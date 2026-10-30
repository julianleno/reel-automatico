#!/usr/bin/env node
/**
 * Confere o Reel automático (protótipo sem Premiere): o que o corte ou o tempo das palavras tirou da legenda
 * sem ser vício, retake, ensaio ou fala fora.
 *
 *   npm run reel:check -- bruto1.mov [bruto2.mov ...] [--medium]
 *
 * Para cada vídeo o protótipo roda com --repeticoes (saída em %TEMP%/reel-check/<nome>-XXXXXX, uma pasta por rodada) e sai a conta:
 * segundos do Reel, palavras da 2ª escuta e as palavras que o próprio Reel ouviu (as guardadas em
 * reel-palavras) e não chegaram à legenda nem estão nos cortados (alinhamento LCS; com frase repetida pode
 * haver falso positivo). Com --medium, também quantas palavras do Whisper medium (guardado em
 * %TEMP%/reel-referencia) faltam na legenda: o que o small não ouviu, com ruído de grafia. Tudo pelo
 * transcribeWav, então respeita a vez de transcrever do PC. Só lê o vídeo.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const BIN = path.join(ROOT, "src/adobe/cep/bin");
const PROTO = path.join(ROOT, "prototypes/reel-sem-premiere");
const ELECTRON = path.join(PROTO, "node_modules/electron/dist/electron.exe");
const T = require(path.join(ROOT, "src/adobe/cep/js/services/transcribe.js"));
const P = require(path.join(PROTO, "plan.js"));
const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\d]/gu, "");

// palavras de `words` que não aparecem, na ordem, em `caption` (já normalizada)
function missing(words, caption) {
  const w = words.map((x) => norm(x.text)), n = w.length, m = caption.length;
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) L[i][j] = w[i] === caption[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n) {
    if (j < m && w[i] === caption[j]) { i += 1; j += 1; } else if (j >= m || L[i + 1][j] >= L[i][j + 1]) out.push(words[i++]); else j += 1;
  }
  return out;
}

// Palavras ouvidas que sumiram: por contagem de cada palavra (ouvidas - na legenda - cortadas de propósito), que
// não depende da ordem; o LCS só diz qual ocorrência mostrar. Com a frase regravada, o LCS casava a legenda com a
// 1ª tomada e dava a 2ª como perdida; e como conjunto, um "é" de vício explicava todo "é" perdido.
function lostWords(heard, caption, cutWords) {
  const count = (list) => list.reduce((m, k) => ((m[k] = (m[k] || 0) + 1), m), {});
  const h = count(heard.map((w) => norm(w.text)).filter(Boolean)), c = count(caption), x = count(cutWords);
  const need = {};
  for (const k in h) need[k] = Math.max(0, h[k] - (c[k] || 0) - (x[k] || 0));
  return missing(heard.filter((w) => norm(w.text)), caption).filter((w) => need[norm(w.text)]-- > 0);
}

async function reference(video) {
  const st = fs.statSync(video);
  const key = crypto.createHash("sha1").update([video, st.size, st.mtimeMs, "medium"].join("|")).digest("hex").slice(0, 16);
  const dir = path.join(os.tmpdir(), "reel-referencia");
  const file = path.join(dir, key + ".json");
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  fs.mkdirSync(dir, { recursive: true });
  const wav = path.join(dir, key + ".wav");
  await T.extractWav({ ffmpegPath: path.join(BIN, "ffmpeg.exe"), file: video, wavPath: wav });
  try {
    const words = await T.transcribeWav({ whisperPath: path.join(BIN, "whisper/whisper-cli.exe"), modelPath: path.join(process.env.APPDATA || os.homedir(), "AppLegendas/models/ggml-medium.bin"),
      wavPath: wav, language: "pt", onWait: () => console.log("  esperando outra transcrição terminar neste PC…") });
    fs.writeFileSync(file, JSON.stringify(words));
    return words;
  } finally {
    fs.rmSync(wav, { force: true });
  }
}

async function check(video, withMedium) {
  const name = path.basename(video).replace(/\.[^.]+$/, "");
  console.log(name + "…");
  // uma pasta por rodada: duas conferências ao mesmo tempo no mesmo vídeo davam EPERM na pasta fixa
  fs.mkdirSync(path.join(os.tmpdir(), "reel-check"), { recursive: true });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "reel-check", name + "-"));
  const t0 = Date.now();
  const run = spawnSync(ELECTRON, [PROTO, "--input", video, "--out", out, "--repeticoes"], { encoding: "utf8", maxBuffer: 64 << 20 });
  const log = String(run.stdout || "") + String(run.stderr || "");
  const tj = fs.existsSync(out) && fs.readdirSync(out).find((f) => / tempos\.json$/.test(f));
  if (!tj) throw new Error("o protótipo não terminou: " + log.split("\n").filter((l) => /ERRO/.test(l)).join(" "));
  const t = JSON.parse(fs.readFileSync(path.join(out, tj), "utf8"));
  const second = Number((/(\d+) de uma 2ª escuta/.exec(log) || [])[1] || 0);
  const caption = t.legendas.map((s) => s.replace(/^[\d.]+ /, "")).join(" ").split(/\s+/).map(norm).filter(Boolean);
  const cutWords = t.cortados.map((c) => c.replace(/^\w+: /, "")).join(" ").split(/\s+/).map(norm).filter(Boolean);
  // o que o Reel ouviu e não foi para a legenda, menos o que foi cortado de propósito
  const own = P.savedWords(P.wordsFile(path.join(os.tmpdir(), "reel-palavras"), video, fs.statSync(video), "small-q8", 0)) || [];
  const lost = lostWords(own, caption, cutWords);
  const ref = withMedium ? await reference(video) : null;
  const unheard = ref ? lostWords(ref, caption, cutWords).length : null;
  console.log("  saída: " + out);
  console.log("  " + t.segundosDoBruto.toFixed(0) + " s -> Reel " + t.segundosDoReel + " s em " + ((Date.now() - t0) / 1000).toFixed(0) + " s; " +
    t.cortados.length + " cortados; 2ª escuta: " + second + " palavra(s)");
  console.log("  ouvidas e fora da legenda sem explicação: " + lost.length + (lost.length ? " — " + lost.map((w) => w.text + "@" + (w.startMs / 1000).toFixed(1)).join(" ") : ""));
  if (ref) console.log("  palavras do medium fora da legenda (com ruído de grafia): " + unheard + " de " + ref.length);
  return { video: name, reel: t.segundosDoReel, cortados: t.cortados.length, segunda: second, perdidas: lost.length, medium: unheard };
}

if (require.main === module) {
  (async () => {
    const withMedium = process.argv.includes("--medium");
    const videos = process.argv.slice(2).filter((a) => a !== "--medium");
    if (!videos.length) {
      console.error("Uso: npm run reel:check -- bruto1.mov [bruto2.mov ...] [--medium]");
      process.exit(1);
    }
    if (!fs.existsSync(ELECTRON)) throw new Error("falta o Electron do protótipo: npm install em prototypes/reel-sem-premiere");
    const all = [];
    for (const v of videos) all.push(await check(path.resolve(v), withMedium));
    console.table(all);
  })().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}

module.exports = { missing, lostWords };
