/**
 * Som do Jota (@jota.videos, skill "Máquina de Reels": references/audio-locucao-trilha.md e scripts/trilha.js), no
 * ffmpeg em vez do OfflineAudioContext: a música com o drop cravado na palavra-chave (ou na logo), subida até o
 * drop, golpe grave no drop, efeitos curtos nos eventos, música abafada antes da logo, locução por cima, fim abafado
 * com fade, pico em 0,8.
 *
 * trilhaJota({ musica, eventos, locucao, saida, ffmpeg }) -> Promise<{ saida, drop, bpm, aviso }>
 *   musica: arquivo (opcional); locucao: arquivo (opcional, entra no 0); saida: o .wav (48 kHz, estéreo);
 *   ffmpeg: caminho (padrão: o do painel, src/adobe/cep/bin/ffmpeg.exe, ou o do PATH);
 *   eventos (segundos do vídeo): { dur, textos:[t], palavras:[t], transicoes:[[t, dur]], logo: t|null, drop?: t }
 *     drop: onde a batida entra (padrão: a 1ª palavra-chave a partir de 1 s; sem ela, a logo).
 *   -> drop: { video, faixa } (s do vídeo e da música) ou null; aviso: texto para a pessoa, ou "".
 *
 * musicaJota(o) -> filtros do ffmpeg da música (o Reel do app usa o mesmo, em prototypes/reel-sem-premiere/plan.js):
 *   o: { start (s da música que toca no 0 do vídeo; negativo: a música entra depois do 0), gainDb, dur,
 *        abafar: [[de, ate, hz]] (passa-baixa estilo Premiere: fecha em 0,35 s, abre seco em `ate`), fade (s) }
 * lufs(saídaDoEbur128) -> número (o loudness integrado) ou null
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const STEREO = "aformat=sample_rates=48000:channel_layouts=stereo";
const ALVO = -14; // LUFS dos Reels (docs/padrao-reel.md)
const SOB_VOZ = 12; // música sob a locução, em dB: o Jota deixa a música presente nos vídeos de motion (.4 a .7 sob a voz)
const PICO = 0.8; // pico final do Jota
// os sons: no painel montado (dist/extension) ficam em sfx/, ao lado de motion-jota/; no código, em src/adobe/cep/sfx
const SFX = ["../sfx", "../adobe/cep/sfx"].map((d) => path.join(__dirname, d)).find((d) => fs.existsSync(path.join(d, "thump.wav"))) || path.join(__dirname, "../sfx");

// Passa-baixa que fecha de 19 kHz até `hz` em 0,35 s (8 degraus, curva exponencial como a rampa do Jota) e abre seco
// em `ate`; o asendcmd muda a frequência do lowpass no tempo.
function abafarCmds(zonas, nome) {
  const out = [];
  for (const [de, ate, hz] of zonas) {
    for (let k = 1; k <= 8; k += 1) out.push((de + (0.35 * k) / 8).toFixed(3) + " " + nome + " f " + Math.round(19000 * Math.pow(hz / 19000, k / 8)));
    out.push(ate.toFixed(3) + " " + nome + " f 19000");
  }
  return out.join(";");
}

function musicaJota(o) {
  const delay = Math.max(0, -o.start);
  const fade = o.fade || 1.6;
  const zonas = o.abafar || [];
  return [
    STEREO,
    o.start > 0 ? "atrim=start=" + o.start.toFixed(3) + ",asetpts=PTS-STARTPTS" : "",
    delay ? "adelay=" + Math.round(delay * 1000) + ":all=1" : "",
    "volume=" + o.gainDb.toFixed(1) + "dB",
    "afade=t=in:st=" + delay.toFixed(3) + ":d=0.05",
    zonas.length ? "asendcmd=c='" + abafarCmds(zonas, "lowpass@abafa") + "',lowpass@abafa=f=19000" : "",
    "afade=t=out:st=" + Math.max(0, o.dur - fade).toFixed(3) + ":d=" + fade,
    "atrim=end=" + o.dur.toFixed(3),
  ].filter(Boolean).join(",");
}

function lufs(text) {
  const all = String(text).match(/I:\s+(-?[\d.]+) LUFS/g);
  return all ? Number(/(-?[\d.]+) LUFS/.exec(all[all.length - 1])[1]) : null;
}

// sons sintetizados (aevalsrc, vírgula escapada para o grafo): subida (ruído + duas serras subindo uma quinta,
// 110 -> 440 Hz, crescendo e cortando seco no fim), golpe grave (60 -> 36 Hz) e whoosh (ruído em sino, 1,5 kHz)
function riser(d, v) {
  const P = (k) => (79.348 * d * k).toFixed(3) + "*(pow(4\\,t/" + d.toFixed(3) + ")-1)";
  const saw = (p) => "2*(" + p + "-floor(" + p + "+0.5))";
  return "aevalsrc=exprs='" + v + "*pow(t/" + d.toFixed(3) + "\\,3)*(0.4*" + saw(P(1)) + "+0.3*" + saw(P(1.4983)) + "+0.5*(2*random(0)-1))':d=" + d.toFixed(3) + ":s=48000,highpass=f=200,lowpass=f=6000";
}
function boom(v) {
  return "aevalsrc=exprs='" + v + "*min(1\\,t/0.006)*exp(-t/0.7)*sin(2*PI*(36*t+14.4*(1-exp(-t/0.6))))':d=2.4:s=48000,lowpass=f=160";
}
function whoosh(d, v) {
  return "aevalsrc=exprs='" + v + "*pow(sin(PI*t/" + d.toFixed(3) + ")\\,2)*(2*random(0)-1)':d=" + d.toFixed(3) + ":s=48000,bandpass=f=1500:width_type=o:w=2";
}

function run(ff, args, binary) {
  return new Promise((resolve, reject) => {
    const child = spawn(ff, ["-hide_banner"].concat(args), { windowsHide: true });
    const out = [];
    let err = "";
    child.stdout.on("data", (d) => binary && out.push(d));
    child.stderr.on("data", (d) => (err = (err + d).slice(-65536)));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(binary ? Buffer.concat(out) : err) : reject(new Error("ffmpeg " + code + ": " + err.trim().split("\n").pop()))));
  });
}

// o núcleo da análise (src/core/audio/drop.js); na janela do app (Electron) ele fica no AppLegendasCore
function nucleo() {
  const m = require("../core/audio/drop.js");
  if (m.analyzeMusic) return m;
  require("../core/audio/beats.js");
  return window.AppLegendasCore; // eslint-disable-line no-undef
}

async function trilhaJota(o) {
  const ff = o.ffmpeg || (fs.existsSync(path.join(__dirname, "../adobe/cep/bin/ffmpeg.exe")) ? path.join(__dirname, "../adobe/cep/bin/ffmpeg.exe") : "ffmpeg");
  const E = o.eventos || {};
  const dur = Number(E.dur);
  if (!(dur > 0)) throw new Error("trilhaJota: eventos.dur (duração do vídeo em segundos) é obrigatório");
  const args = [], parts = [], labels = [];
  let n = 0;
  const input = (a) => { args.push(...a); return n++; };
  const add = (filtros, nome) => { parts.push(filtros + "[" + nome + "]"); labels.push("[" + nome + "]"); };
  const loud = async (file, start, len) => lufs(await run(ff, (start ? ["-ss", start.toFixed(3)] : []).concat(len ? ["-t", len.toFixed(3)] : [], ["-i", file, "-af", "ebur128=framelog=quiet", "-f", "null", "-"])));
  let drop = null, bpm = 0, aviso = "";
  if (o.locucao) {
    const L = await loud(o.locucao);
    add("[" + input(["-i", o.locucao]) + ":a]" + STEREO + ",volume=" + (L === null ? 0 : ALVO - L).toFixed(1) + "dB", "voz");
  }
  const alvo = E.drop != null ? E.drop : ((E.palavras || []).find((t) => t >= 1) ?? (E.logo != null ? E.logo : null));
  if (o.musica) {
    const D = nucleo();
    const b = await run(ff, ["-v", "error", "-i", o.musica, "-ac", "1", "-ar", "22050", "-f", "f32le", "-"], true);
    const song = D.analyzeMusic(new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + (b.length & ~3))), 22050);
    bpm = song.bpm;
    const placed = alvo != null ? D.placeDrop(song, { at: alvo, seconds: dur }) : null;
    if (alvo != null && !placed) aviso = "Não achei uma entrada forte de batida nessa música (ou ela é curta para o vídeo): ela toca do começo.";
    const start = placed ? placed.start : 0;
    const L = await loud(o.musica, Math.max(0, start), Math.min(dur - Math.max(0, -start), song.dur));
    if (placed) drop = { video: alvo, faixa: placed.drop.exato };
    // abafa antes da logo (se ela não é o próprio drop) e no fim, como o "Abafa e some" do painel de som do Jota
    const abafar = E.logo != null && E.logo > 0.5 && (!drop || E.logo - alvo > 2.5) ? [[Math.max(0, E.logo - 1.9), E.logo, 520]] : [];
    abafar.push([Math.max(0, dur - 1.8), dur + 1, 420]);
    add("[" + input(placed ? ["-i", o.musica] : ["-stream_loop", "-1", "-i", o.musica]) + ":a]" +
      musicaJota({ start, gainDb: (o.locucao ? ALVO - SOB_VOZ : ALVO) - (L === null ? ALVO : L), dur, abafar, fade: 1.6 }), "mus");
  }
  // efeitos (sons do painel, src/adobe/cep/sfx; o snap e o tick-soft de lá estão mudos): tique no texto, golpe na
  // palavra-chave e na logo, whoosh na transição; subida até o drop (e até a logo, se ela vem depois) e golpe grave nele
  const sons = [];
  (E.textos || []).forEach((t) => sons.push({ t, file: "tick-high.wav", v: 0.3 }));
  (E.palavras || []).forEach((t) => sons.push({ t, file: "thump.wav", v: 0.6 }));
  (E.transicoes || []).forEach(([t, d]) => sons.push({ t, src: whoosh(Math.max(0.2, d || 0.5), 0.25) }));
  const golpe = (t, v) => sons.push({ t, file: "thump.wav", v }, { t, src: boom(v * 0.6) });
  const subida = (t) => { const a = Math.max(0, t - 1.4); if (t - a >= 0.5) sons.push({ t: a, src: riser(t - a, 0.3) }); };
  if (drop) { subida(drop.video); golpe(drop.video, 0.7); }
  if (E.logo != null && (!drop || E.logo - drop.video > 2.5)) { subida(E.logo); golpe(E.logo, 0.9); }
  sons.filter((s) => s.t >= 0 && s.t < dur).forEach((s, k) => {
    const pos = "adelay=" + Math.round(s.t * 1000) + ":all=1";
    add(s.file ? "[" + input(["-i", path.join(SFX, s.file)]) + ":a]" + STEREO + ",volume=" + s.v + "," + pos : s.src + "," + STEREO + "," + pos, "s" + k);
  });
  if (!labels.length) add("anullsrc=r=48000:cl=stereo", "nada");
  const graph = parts.join(";") + ";" + labels.join("") + "amix=inputs=" + labels.length + ":normalize=0:duration=longest,apad=whole_dur=" + dur.toFixed(3) +
    ",atrim=end=" + dur.toFixed(3) + ",alimiter=limit=" + PICO + ":level=0:latency=1[a]";
  const file = o.saida + ".grafo.txt";
  fs.writeFileSync(file, graph);
  try {
    await run(ff, ["-v", "error", "-y"].concat(args, ["-/filter_complex", file, "-map", "[a]", "-ar", "48000", "-c:a", "pcm_s16le", o.saida]));
  } finally {
    fs.rmSync(file, { force: true });
  }
  return { saida: o.saida, drop, bpm, aviso };
}

module.exports = { trilhaJota, musicaJota, lufs, ALVO };
