#!/usr/bin/env node
/**
 * Juiz do Reel: assiste um MP4 pronto e dá nota, com a lista de defeitos e o instante de cada um.
 *
 *   npm run reel:juiz -- <reel.mp4> [outro.mp4 ...] [--json] [--detalhe]
 *
 * Mede sozinho (só o MP4): formato para o Instagram, loudness, cortes (diferença entre quadros), o
 * enquadramento de cada lado do corte (punch-in), estalo e fala colada em cada emenda, ar morto no
 * começo e no fim, pausas longas, pulo de volume entre trechos, quadro preto ou congelado, salto de
 * zoom no meio do plano. Com o "<nome> tempos.json" que o app grava ao lado (trechos, palavras,
 * legendas, zooms e sons), usa os cortes exatos e confere também palavra cortada, legenda fora de
 * sincronia e legenda que pisca. Os limites vêm de docs/padrao-reel.md (medidos nos Reels do Jota e
 * em Reels baixados). As contas são funções puras, testadas em tests/reel-juiz.test.js.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const BUNDLED = path.join(ROOT, "src/adobe/cep/bin/ffmpeg.exe");
const FFMPEG = process.platform === "win32" && fs.existsSync(BUNDLED) ? BUNDLED : "ffmpeg";

// Limites (docs/padrao-reel.md). Cada um com o porquê e de onde veio.
const LIMITS = {
  lufs: [-16, -12], // Instagram entrega em -14 (3 Reels baixados: -14,1); fora disso o app normaliza diferente
  truePeak: -1, // dBTP: acima disso o AAC do app de destino distorce
  leadInMs: 300, // fala começa até 0,3 s (Jota: 0 a 120 ms)
  tailMs: 1200, // depois da última fala (Jota deixa ~0,5-1 s para a última legenda ler)
  longPauseMs: 1500, // pausa no meio da fala (Jota: maior 1,34 s, num Reel de 3 min)
  shortShotS: 0.3, // plano mais curto que isso pisca (Jota: 0,33 s nas sequências de imagens)
  levelJumpDb: 6, // voz de um trecho para o outro (Jota: até ~4 dB)
  clickDb: 18, // energia aguda no instante da emenda acima do redor (dB)
  captionLateMs: 120, // legenda entra depois da palavra
  captionEarlyMs: 250, // legenda entra antes da palavra (entrar um pouco antes é comum)
  captionMinS: 0.3, // legenda que pisca
  zoomStep: 0.03, // escala que muda mais que 3% de um quadro para o outro, sem ser corte
};

// ---------------------------------------------------------------- contas (puras)

function median(list) {
  const xs = Array.from(list).sort((a, b) => a - b);
  if (!xs.length) return 0;
  const m = xs.length >> 1;
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
}

function percentile(list, p) {
  const xs = Array.from(list).sort((a, b) => a - b);
  if (!xs.length) return 0;
  return xs[Math.min(xs.length - 1, Math.max(0, Math.round((p / 100) * (xs.length - 1))))];
}

// Diferença média entre cada quadro e o anterior (cinza 0..255), no quadro todo e em faixas
// horizontais: um corte mexe em quase todas as faixas; uma legenda que entra, só em 1 a 3.
function frameDiffs(frames, w, h, bands) {
  const n = frames.length;
  const nb = bands || 16;
  const diff = new Float32Array(n);
  const band = [];
  const rows = h / nb;
  band.push(new Float32Array(nb));
  for (let i = 1; i < n; i += 1) {
    const a = frames[i - 1], b = frames[i];
    const bd = new Float32Array(nb);
    let s = 0;
    for (let y = 0; y < h; y += 1) {
      let rs = 0;
      const o = y * w;
      for (let x = 0; x < w; x += 1) rs += Math.abs(a[o + x] - b[o + x]);
      s += rs;
      bd[Math.min(nb - 1, Math.floor(y / rows))] += rs;
    }
    diff[i] = s / (w * h);
    for (let k = 0; k < nb; k += 1) bd[k] /= w * rows;
    band.push(bd);
  }
  return { diff, band };
}

// Cortes pela imagem: o quadro i é o 1º do plano novo quando a diferença dele é um pico isolado
// (bem acima da mediana dos vizinhos) em boa parte das faixas. Picos a menos de 0,3 s um do outro
// viram uma transição (vários quadros: luz, flash), contada à parte.
function findCuts(fd, fps, opts) {
  const o = Object.assign({ minDiff: 6, ratio: 2.5, minBands: 5, win: 6 }, opts || {});
  const { diff, band } = fd;
  const n = diff.length;
  const nb = band[0].length;
  const spikes = [];
  for (let i = 1; i < n; i += 1) {
    const around = [];
    for (let k = i - o.win; k <= i + o.win; k += 1) if (k >= 1 && k < n && Math.abs(k - i) > 0) around.push(diff[k]);
    const m = Math.max(0.5, median(around));
    if (diff[i] < o.minDiff || diff[i] < o.ratio * m) continue;
    let bands = 0;
    for (let b = 0; b < nb; b += 1) {
      const nbAround = [];
      for (let k = i - o.win; k <= i + o.win; k += 1) if (k >= 1 && k < n && k !== i) nbAround.push(band[k][b]);
      if (band[i][b] > 3 && band[i][b] > o.ratio * Math.max(0.5, median(nbAround))) bands += 1;
    }
    if (bands >= o.minBands) spikes.push({ frame: i, diff: diff[i], ratio: diff[i] / m, bands });
  }
  // agrupa picos próximos (transição de vários quadros)
  const cuts = [];
  const gap = Math.round(0.3 * fps);
  for (const s of spikes) {
    const last = cuts[cuts.length - 1];
    if (last && s.frame - last.lastFrame <= gap) {
      last.lastFrame = s.frame;
      last.frames += 1;
      last.diff = Math.max(last.diff, s.diff);
    } else cuts.push({ frame: s.frame, lastFrame: s.frame, frames: 1, diff: s.diff, bands: s.bands });
  }
  return cuts.map((c) => ({ frame: c.frame, t: c.frame / fps, kind: c.frames > 1 ? "transicao" : "corte", frames: c.frames, lastFrame: c.lastFrame, diff: c.diff }));
}

// O quadro de corte perto de um instante: o de maior pico (diferença contra a mediana dos vizinhos) em
// até win quadros, que mexa em pelo menos 5 das faixas (a legenda sozinha mexe em 1 a 3). -> índice ou -1
function spikeNear(fd, frame, win) {
  const { diff, band } = fd;
  let best = -1, bestRatio = 2;
  for (let i = Math.max(1, frame - win); i <= Math.min(diff.length - 1, frame + win); i += 1) {
    const around = [];
    for (let k = i - 6; k <= i + 6; k += 1) if (k >= 1 && k < diff.length && k !== i) around.push(diff[k]);
    const ratio = diff[i] / Math.max(0.3, median(around));
    if (ratio <= bestRatio) continue;
    let bands = 0;
    for (let b = 0; b < band[i].length; b += 1) if (band[i][b] > 2 * Math.max(0.3, band[i - 1][b], band[Math.min(diff.length - 1, i + 1)][b])) bands += 1;
    if (bands >= 5) {
      best = i;
      bestRatio = ratio;
    }
  }
  return best;
}

// Amostra bilinear de um quadro cinza (fora do quadro: -1)
function sample(img, w, h, u, v) {
  if (u < 0 || v < 0 || u > w - 1 || v > h - 1) return -1;
  const x0 = Math.floor(u), y0 = Math.floor(v);
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const fx = u - x0, fy = v - y0;
  const a = img[y0 * w + x0], b = img[y0 * w + x1], c = img[y1 * w + x0], d = img[y1 * w + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

// Erro médio (limitado em 40, para a parte que mexeu não mandar) de B contra A escalado por s e
// deslocado (tx, ty): B(x, y) ~ A(x/s + tx, y/s + ty). Só o miolo de B, de 2 em 2 pixels.
function alignError(a, b, w, h, s, tx, ty, step) {
  const st = step || 2;
  let sum = 0, n = 0;
  const mx = Math.round(w * 0.08), my = Math.round(h * 0.08);
  for (let y = my; y < h - my; y += st) {
    for (let x = mx; x < w - mx; x += st) {
      const v = sample(a, w, h, x / s + tx, y / s + ty);
      if (v < 0) continue;
      sum += Math.min(40, Math.abs(b[y * w + x] - v));
      n += 1;
    }
  }
  return n > (w * h) / (st * st) / 4 ? sum / n : Infinity;
}

function half(img, w, h) {
  const hw = w >> 1, hh = h >> 1;
  const out = new Float32Array(hw * hh);
  for (let y = 0; y < hh; y += 1) for (let x = 0; x < hw; x += 1) {
    const o = 2 * y * w + 2 * x;
    out[y * hw + x] = (img[o] + img[o + 1] + img[o + w] + img[o + w + 1]) / 4;
  }
  return out;
}

// Quanto B está mais perto (s > 1) ou mais longe (s < 1) que A: busca grossa em metade do tamanho
// (escala de 0,8 a 1,25, ponto fixo em qualquer lugar do quadro) e fina no tamanho todo.
// -> { s, err (erro alinhado), err1 (erro sem mexer) }
function scaleBetween(a, b, w, h) {
  const ha = half(a, w, h), hb = half(b, w, h), hw = w >> 1, hh = h >> 1;
  let best = { s: 1, tx: 0, ty: 0, err: alignError(ha, hb, hw, hh, 1, 0, 0) };
  for (let s = 0.8; s <= 1.2501; s += 0.01) {
    // ponto fixo f: x/s + tx = x em x = f -> tx = f (1 - 1/s); f no quadro, mais 3 px de folga
    const span = (len) => [Math.min(0, len * (1 - 1 / s)) - 3, Math.max(0, len * (1 - 1 / s)) + 3];
    const [x0, x1] = span(hw), [y0, y1] = span(hh);
    for (let tx = x0; tx <= x1; tx += 1) for (let ty = y0; ty <= y1; ty += 1) {
      const e = alignError(ha, hb, hw, hh, s, tx, ty, 2);
      if (e < best.err) best = { s, tx, ty, err: e };
    }
  }
  let fine = { s: best.s, tx: best.tx * 2, ty: best.ty * 2, err: Infinity };
  const c = Object.assign({}, fine);
  for (let s = c.s - 0.015; s <= c.s + 0.0151; s += 0.005) {
    for (let tx = c.tx - 2; tx <= c.tx + 2; tx += 0.5) for (let ty = c.ty - 2; ty <= c.ty + 2; ty += 0.5) {
      const e = alignError(a, b, w, h, s, tx, ty, 2);
      if (e < fine.err) fine = { s, tx, ty, err: e };
    }
  }
  return { s: Math.round(fine.s * 1000) / 1000, err: fine.err, err1: alignError(a, b, w, h, 1, 0, 0, 2) };
}

// Volume em dBFS por janela (RMS)
function envelopeDb(samples, sr, winMs) {
  const n = Math.max(1, Math.round((sr * winMs) / 1000));
  const out = new Float32Array(Math.floor(samples.length / n));
  for (let k = 0; k < out.length; k += 1) {
    let s = 0;
    for (let i = k * n; i < (k + 1) * n; i += 1) s += samples[i] * samples[i];
    out[k] = 10 * Math.log10(s / n + 1e-12);
  }
  return out;
}

// Fala por janela: acima do meio do caminho (em dB) entre o ruído (10%) e a voz (95%), com no
// mínimo 12 dB acima do ruído. Buracos de até 60 ms dentro da fala são fala (consoante surda).
function speechMask(db) {
  const floor = percentile(db, 10), voice = percentile(db, 95);
  const thr = Math.max(floor + 12, floor + (voice - floor) * 0.45);
  const m = Array.from(db, (d) => d > thr);
  return { mask: m, thr, floor, voice };
}

// Trechos sem fala (em ms) a partir da máscara, ignorando os que tocam o começo ou o fim
function quietSpans(mask, winMs) {
  const out = [];
  let start = -1;
  for (let i = 0; i <= mask.length; i += 1) {
    const quiet = i < mask.length && !mask[i];
    if (quiet && start < 0) start = i;
    if (!quiet && start >= 0) {
      out.push({ startMs: start * winMs, endMs: i * winMs, edge: start === 0 || i === mask.length });
      start = -1;
    }
  }
  return out;
}

// Estalo numa emenda: energia do agudo (2ª diferença) na janela de 2 ms em volta do instante,
// contra a mediana das janelas de 2 ms nos 40 ms em volta (sem a do instante). -> dB acima do redor
function clickDb(samples, sr, atSec) {
  const win = Math.max(8, Math.round(sr * 0.002));
  const hf = (k0) => {
    let s = 0;
    for (let i = Math.max(2, k0); i < Math.min(samples.length, k0 + win); i += 1) {
      const d = samples[i] - 2 * samples[i - 1] + samples[i - 2];
      s += d * d;
    }
    return s / win + 1e-14;
  };
  const at = Math.round(atSec * sr);
  // o pico perto do instante (±3 ms: o corte do vídeo cai no quadro, o do áudio na amostra)
  let peak = 0;
  for (let k = at - win * 2; k <= at + win; k += win >> 1) peak = Math.max(peak, hf(k));
  const ref = [];
  for (let k = at - 10 * win; k <= at + 10 * win; k += win) if (Math.abs(k - at) > 3 * win) ref.push(hf(k));
  return 10 * Math.log10(peak / Math.max(median(ref), 1e-12));
}

// Nível da voz de cada lado de um instante: mediana das janelas com fala em até 2 s
function sideLevels(db, mask, winMs, atMs, spanMs) {
  const k = Math.round(atMs / winMs), n = Math.round((spanMs || 2000) / winMs);
  const before = [], after = [];
  for (let i = Math.max(0, k - n); i < k; i += 1) if (mask[i]) before.push(db[i]);
  for (let i = k; i < Math.min(db.length, k + n); i += 1) if (mask[i]) after.push(db[i]);
  return { before: before.length >= 10 ? median(before) : null, after: after.length >= 10 ? median(after) : null };
}

// Folga da emenda: ms da última janela com fala até o corte, e do corte até a próxima fala (até 1,5 s)
function gapsAt(mask, winMs, atMs) {
  const k = Math.round(atMs / winMs), lim = Math.round(1500 / winMs);
  let b = 0, a = 0;
  while (b < lim && k - b - 1 >= 0 && !mask[k - b - 1]) b += 1;
  while (a < lim && k + a < mask.length && !mask[k + a]) a += 1;
  return { before: b * winMs, after: a * winMs };
}

// Fala colada no corte: há voz nos 30 ms antes E nos 30 ms depois (a emenda caiu dentro da fala)
function voicedAt(db, mask, winMs, atMs) {
  const k = Math.round(atMs / winMs), n = Math.max(1, Math.round(30 / winMs));
  let before = 0, after = 0;
  for (let i = k - n; i < k; i += 1) if (mask[i]) before += 1;
  for (let i = k; i < k + n; i += 1) if (mask[i]) after += 1;
  return before === n && after === n;
}

// Legendas contra as palavras (tempo do Reel, segundos). captions: [{ start, end, text }];
// words: [{ start, end, text }]. -> [{ at, kind, ms }]
function captionIssues(captions, words, lim) {
  const L = Object.assign({}, LIMITS, lim || {});
  const out = [];
  for (const c of captions) {
    const len = c.end - c.start;
    if (len < L.captionMinS) out.push({ at: c.start, kind: "legenda-pisca", ms: Math.round(len * 1000), text: c.text });
    // a palavra que abre a legenda: o mesmo texto, a mais perto do início dela (pegar só pela hora casava
    // com a última palavra da legenda anterior)
    const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\d]/gu, "");
    const first = norm(String(c.text).split(/\s+/)[0]);
    const w = words.filter((x) => norm(x.text) === first && Math.abs(x.start - c.start) < 1)
      .sort((a, b) => Math.abs(a.start - c.start) - Math.abs(b.start - c.start))[0];
    if (!w) continue;
    const d = Math.round((c.start - w.start) * 1000); // > 0: legenda atrasada
    if (d > L.captionLateMs) out.push({ at: c.start, kind: "legenda-atrasada", ms: d, text: c.text });
    else if (-d > L.captionEarlyMs) out.push({ at: c.start, kind: "legenda-adiantada", ms: -d, text: c.text });
  }
  return out;
}

// Contraste da letra contra o que está em volta dela, no quadro como saiu. mask e frame: cinza w x h (a máscara
// da legenda parada que o app grava e o mesmo pedaço do quadro). Em fatias de 20 colunas (~2 letras): a letra
// (máscara > 128) contra o anel de até 2 px fora dela (onde ficam a sombra e o contorno). Razão de contraste do
// WCAG com a luminância (luma/255)^2,2; fatia boa com 3:1 ou mais (texto grande, nível AA).
// -> { ok: fração das fatias boas, ratio: mediana das razões, slices }
function textContrast(mask, frame, w, h) {
  const text = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] > 128;
  const lum = (v) => Math.pow(v / 255, 2.2);
  const ratios = [];
  for (let x0 = 0; x0 < w; x0 += 20) {
    const t = [], r = [];
    for (let y = 0; y < h; y += 1) for (let x = x0; x < Math.min(w, x0 + 20); x += 1) {
      if (text(x, y)) { t.push(frame[y * w + x]); continue; }
      let near = false;
      for (let dy = -2; dy <= 2 && !near; dy += 1) for (let dx = -2; dx <= 2 && !near; dx += 1) near = text(x + dx, y + dy);
      if (near) r.push(frame[y * w + x]);
    }
    if (t.length < 6 || r.length < 6) continue;
    const a = lum(median(t)), b = lum(median(r));
    ratios.push((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05));
  }
  return { ok: ratios.length ? ratios.filter((x) => x >= 3).length / ratios.length : 1, ratio: ratios.length ? Number(median(ratios).toFixed(2)) : null, slices: ratios.length };
}

// Palavra cortada pelo meio: uma emenda que cai dentro de uma palavra (com 40 ms de folga das bordas)
function cutInsideWord(cutsSec, words) {
  const out = [];
  for (const t of cutsSec) {
    const w = words.find((x) => t > x.start + 0.04 && t < x.end - 0.04);
    if (w) out.push({ at: t, kind: "palavra-cortada", text: w.text });
  }
  return out;
}

// Peso de cada defeito na nota (100 - soma). Aviso pesa pouco: o Reel do Jota passa com eles.
const WEIGHTS = {
  formato: 15, "loudness": 4, "pico": 4, "estalo": 6, "fala-colada": 3, "palavra-cortada": 6, "plano-curto": 3,
  "ar-morto-inicio": 8, "ar-morto-fim": 3, "pausa-longa": 3, "pulo-volume": 4, "preto": 10, "congelado": 10,
  "legenda-atrasada": 2, "legenda-adiantada": 1, "legenda-pisca": 2, "legenda-ilegivel": 3, "salto-zoom": 5, "corte-sem-reenquadrar": 4, dessincronia: 6,
};
const PASS = 70;

function grade(defects) {
  const by = {};
  for (const d of defects) by[d.kind] = (by[d.kind] || 0) + 1;
  // cada tipo pesa no máximo 3x o peso (um problema que se repete não zera a nota sozinho)
  let lost = 0;
  for (const k of Object.keys(by)) lost += Math.min(3, by[k]) * (WEIGHTS[k] || 2);
  const score = Math.max(0, Math.round(100 - lost));
  return { score, pass: score >= PASS, count: by };
}

// ---------------------------------------------------------------- leitura (ffmpeg)

function run(args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args, { windowsHide: true });
    const out = [];
    let err = "";
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => (err = (err + d).slice(-(opts && opts.keepErr ? 1 << 22 : 65536))));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve({ out: Buffer.concat(out), err }) : reject(new Error("ffmpeg " + code + ": " + err.trim().split("\n").pop()))));
  });
}

function probe(file) {
  const t = spawnSync(FFMPEG, ["-hide_banner", "-i", file], { encoding: "utf8" }).stderr || "";
  const v = /Stream #[^\n]*Video: (\w+)[^\n]*?, (\d{2,5})x(\d{2,5})[^\n]*?, ([\d.]+) fps/.exec(t) || [];
  const a = /Stream #[^\n]*Audio: (\w+)[^\n]*?, (\d+) Hz/.exec(t) || [];
  const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(t) || [];
  return {
    vcodec: v[1] || "", w: Number(v[2]) || 0, h: Number(v[3]) || 0, fps: Number(v[4]) || 0,
    acodec: a[1] || "", sampleRate: Number(a[2]) || 0,
    duration: d.length ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0,
    hdr: /arib-std-b67|smpte2084|bt2020/.test(t),
  };
}

async function loudness(file) {
  const { err } = await run(["-hide_banner", "-nostats", "-i", file, "-vn", "-filter_complex", "ebur128=peak=true", "-f", "null", "-"], { keepErr: true });
  const s = err.slice(err.lastIndexOf("Summary:"));
  const g = (re) => Number((re.exec(s) || [])[1]);
  return { lufs: g(/I:\s+(-?[\d.]+) LUFS/), lra: g(/LRA:\s+(-?[\d.]+) LU/), truePeak: g(/Peak:\s+(-?[\d.]+) dBFS/) };
}

// Quadros pequenos em cinza e, na mesma decodificação, quadro preto e congelado (filtros do ffmpeg;
// o congelado olha o quadro pequeno, onde o ruído do vídeo some: só pega o que parou de verdade)
async function grayFrames(file, w, h) {
  const { out, err } = await run(["-hide_banner", "-nostats", "-i", file, "-an", "-vf",
    "scale=" + w + ":" + h + ":flags=area,format=gray,blackdetect=d=0.1:pix_th=0.1,freezedetect=n=0.002:d=0.6", "-f", "rawvideo", "-"], { keepErr: true });
  const n = Math.floor(out.length / (w * h));
  const frames = [];
  for (let i = 0; i < n; i += 1) frames.push(out.subarray(i * w * h, (i + 1) * w * h));
  frames.black = [...err.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => ({ start: Number(m[1]), end: Number(m[2]) }));
  frames.freezes = [...err.matchAll(/freeze_start: ([\d.]+)/g)].map((m) => ({ start: Number(m[1]) }));
  return frames;
}

async function monoAudio(file, sr) {
  const { out } = await run(["-hide_banner", "-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", String(sr), "-f", "f32le", "-"]);
  return new Float32Array(out.buffer, out.byteOffset, out.length >> 2);
}

// Metadados que o app grava ao lado: "<bruto> tempos.json" (o Reel é "<bruto> reel <estilo>.mp4")
function sidecar(file) {
  const dir = path.dirname(file);
  const name = path.basename(file);
  const i = name.lastIndexOf(" reel ");
  const cand = i > 0 ? path.join(dir, name.slice(0, i) + " tempos.json") : "";
  if (!cand || !fs.existsSync(cand)) return null;
  try {
    return JSON.parse(fs.readFileSync(cand, "utf8"));
  } catch (e) {
    return null;
  }
}

// emendas do app no tempo do Reel: fim de cada trecho que ficou (somados)
function cutsFromTrechos(trechos, speed) {
  const out = [];
  let acc = 0;
  for (let i = 0; i < trechos.length - 1; i += 1) {
    acc += trechos[i][1] - trechos[i][0];
    out.push(acc / (speed || 1));
  }
  return out;
}

async function judge(file, opts) {
  const o = opts || {};
  const info = probe(file);
  if (!info.w) throw new Error("não é um vídeo: " + file);
  const meta = o.meta === undefined ? sidecar(file) : o.meta;
  const defects = [];
  const add = (d) => defects.push(d);
  // formato para o Instagram: 1080x1920, H.264, AAC 48 kHz, até 60 q/s
  if (info.w !== 1080 || info.h !== 1920) add({ at: 0, kind: "formato", detail: info.w + "x" + info.h + " (esperado 1080x1920)" });
  if (info.vcodec !== "h264") add({ at: 0, kind: "formato", detail: "vídeo " + info.vcodec + " (esperado h264)" });
  if (info.acodec !== "aac" || info.sampleRate !== 48000) add({ at: 0, kind: "formato", detail: "áudio " + info.acodec + " " + info.sampleRate + " Hz (esperado aac 48000)" });
  if (!(info.fps >= 23.9 && info.fps <= 60.01)) add({ at: 0, kind: "formato", detail: info.fps + " q/s" });
  // HDR do iPhone passado adiante em 8 bits: quem não tem HDR (a maioria) vê a cor lavada
  if (info.hdr) add({ at: 0, kind: "formato", detail: "marcado HDR/BT.2020 (esperado SDR BT.709)" });

  const [loud, frames, samples] = await Promise.all([loudness(file), grayFrames(file, 108, 192), monoAudio(file, 48000)]);
  if (!(loud.lufs >= LIMITS.lufs[0] && loud.lufs <= LIMITS.lufs[1])) add({ at: 0, kind: "loudness", detail: loud.lufs + " LUFS (faixa " + LIMITS.lufs.join(" a ") + ")" });
  if (loud.truePeak > LIMITS.truePeak) add({ at: 0, kind: "pico", detail: loud.truePeak + " dBTP (máx. " + LIMITS.truePeak + ")" });
  for (const b of frames.black) add({ at: b.start, kind: "preto", detail: (b.end - b.start).toFixed(2) + " s" });
  for (const f of frames.freezes) add({ at: f.start, kind: "congelado" });

  const fps = info.fps || 30;
  const fd = frameDiffs(frames, 108, 192);
  const seen = findCuts(fd, fps);
  const speed = meta && meta.velocidade > 1 ? meta.velocidade : 1;
  const metaCuts = meta && Array.isArray(meta.trechos) ? cutsFromTrechos(meta.trechos, speed) : null;
  // emendas: as do app (exatas) ou as vistas na imagem
  const cuts = metaCuts ? metaCuts.map((t) => ({ t, kind: "corte", frame: Math.round(t * fps) })) : seen;

  // imagem e som cortam juntos? A emenda do áudio (metadados) contra o pico da imagem mais perto (até 0,25 s).
  // Mais de 1 quadro de diferença = a boca fora do som logo depois do corte.
  if (metaCuts) {
    for (const c of cuts) {
      const k = spikeNear(fd, c.frame, Math.round(0.25 * fps));
      if (k < 0) continue;
      c.syncMs = Math.round((k / fps - c.t) * 1000);
      if (Math.abs(c.syncMs) > 1000 / fps + 5) add({ at: c.t, kind: "dessincronia", detail: "a imagem corta " + Math.abs(c.syncMs) + " ms " + (c.syncMs > 0 ? "depois" : "antes") + " do som" });
    }
  }

  // enquadramento de cada lado do corte (punch-in): quadro antes contra o depois
  for (const c of cuts) {
    if (c.kind !== "corte" || c.frame < 1 || c.frame >= frames.length) continue;
    const sc = scaleBetween(frames[c.frame - 1], frames[c.frame], 108, 192);
    c.scale = sc.s;
    c.err = sc.err;
    c.err1 = sc.err1;
  }

  // áudio: fala, pausas, estalo e fala colada nas emendas, pulo de volume
  const WIN = 10;
  const db = envelopeDb(samples, 48000, WIN);
  const sm = speechMask(db);
  const quiet = quietSpans(sm.mask, WIN);
  const firstSpeech = sm.mask.indexOf(true) * WIN;
  const lastSpeech = (sm.mask.lastIndexOf(true) + 1) * WIN;
  const words = meta && Array.isArray(meta.palavras) ? meta.palavras.map((p) => ({ start: p[0] / speed, end: p[1] / speed, text: p[2] })) : null;
  const leadIn = words && words.length ? Math.round(words[0].start * 1000) : firstSpeech;
  if (leadIn > LIMITS.leadInMs) add({ at: 0, kind: "ar-morto-inicio", detail: leadIn + " ms até a fala" });
  const tail = Math.round(info.duration * 1000 - lastSpeech);
  if (tail > LIMITS.tailMs) add({ at: lastSpeech / 1000, kind: "ar-morto-fim", detail: tail + " ms depois da última fala" });
  for (const q of quiet) {
    if (!q.edge && q.endMs - q.startMs > LIMITS.longPauseMs) add({ at: q.startMs / 1000, kind: "pausa-longa", detail: q.endMs - q.startMs + " ms" });
  }
  const sfx = meta && Array.isArray(meta.sons) ? meta.sons : [];
  for (const c of cuts) {
    if (c.kind !== "corte") continue;
    const nearSfx = sfx.some((s) => Math.abs(s - c.t) < 0.06);
    c.click = clickDb(samples, 48000, c.t);
    c.voiced = voicedAt(db, sm.mask, WIN, c.t * 1000);
    c.gap = gapsAt(sm.mask, WIN, c.t * 1000);
    const lv = sideLevels(db, sm.mask, WIN, c.t * 1000);
    c.levelJump = lv.before !== null && lv.after !== null ? Math.round((lv.after - lv.before) * 10) / 10 : null;
    if (c.click > LIMITS.clickDb && !nearSfx) add({ at: c.t, kind: "estalo", detail: c.click.toFixed(0) + " dB de agudo na emenda" });
    // pela imagem, o corte pode ser só do vídeo (imagem de apoio) com a voz seguindo: não é emenda de áudio
    if (c.voiced && metaCuts) add({ at: c.t, kind: "fala-colada", detail: "voz dos dois lados da emenda" });
    if (c.levelJump !== null && Math.abs(c.levelJump) > LIMITS.levelJumpDb) add({ at: c.t, kind: "pulo-volume", detail: (c.levelJump > 0 ? "+" : "") + c.levelJump + " dB" });
  }
  // planos curtos (entre cortes, sem contar transição)
  const bounds = [0].concat(cuts.map((c) => c.t), [info.duration]);
  const shots = [];
  for (let i = 1; i < bounds.length; i += 1) shots.push(bounds[i] - bounds[i - 1]);
  shots.forEach((len, i) => {
    if (len < LIMITS.shortShotS && i > 0 && i < shots.length - 1) add({ at: bounds[i], kind: "plano-curto", detail: Math.round(len * 1000) + " ms" });
  });
  // salto de zoom: pico na imagem fora dos cortes do app, com o quadro só escalado (o alinhado quase igual)
  if (metaCuts) {
    for (const s of seen) {
      if (s.kind !== "corte" || cuts.some((c) => Math.abs(c.t - s.t) < 1.5 / fps)) continue;
      const sc = scaleBetween(frames[s.frame - 1], frames[s.frame], 108, 192);
      if (Math.abs(sc.s - 1) > LIMITS.zoomStep && sc.err < sc.err1 * 0.6) add({ at: s.t, kind: "salto-zoom", detail: "escala " + sc.s + " de um quadro para o outro" });
    }
  }
  // legendas e palavras (só com os metadados do app)
  if (words && meta && Array.isArray(meta.legendasTempo)) {
    const caps = meta.legendasTempo.map((l) => ({ start: l[0] / speed, end: l[1] / speed, text: l[2] }));
    for (const d of captionIssues(caps, words)) add({ at: d.at, kind: d.kind, detail: d.ms + " ms: \"" + d.text + "\"" });
  }
  if (words && metaCuts) for (const d of cutInsideWord(metaCuts, words)) add({ at: d.at, kind: "palavra-cortada", detail: "\"" + d.text + "\"" });

  // contraste da legenda: a máscara de cada legenda parada (PNG do app) contra o mesmo pedaço do quadro
  const legib = [];
  const mk = meta && meta.legendaMascara;
  const mkFile = mk && path.join(path.dirname(file), mk.arquivo);
  if (mk && fs.existsSync(mkFile)) {
    const k = mk.escala || 2, mw = Math.round(info.w / k), mh = Math.round(mk.h / k), y0 = Math.round(mk.y / k);
    const strip = (await run(["-hide_banner", "-v", "error", "-i", mkFile, "-f", "rawvideo", "-pix_fmt", "gray", "-"])).out;
    const step = Math.max(1, Math.ceil(mk.tempos.length / 40)); // até 40 legendas, espalhadas
    for (let i = 0; i < mk.tempos.length; i += step) {
      const t = mk.tempos[i] / speed;
      const fr = (await run(["-hide_banner", "-v", "error", "-ss", t.toFixed(3), "-i", file, "-frames:v", "1", "-vf", "scale=" + mw + ":" + Math.round(info.h / k), "-f", "rawvideo", "-pix_fmt", "gray", "-"])).out;
      const c = textContrast(strip.subarray(i * mw * mh, (i + 1) * mw * mh), fr.subarray(y0 * mw, (y0 + mh) * mw), mw, mh);
      if (!c.slices) continue;
      legib.push(Object.assign({ t }, c));
      if (c.ok < 0.8) add({ at: t, kind: "legenda-ilegivel", detail: Math.round(c.ok * 100) + "% das letras com contraste de 3:1 (mediana " + c.ratio + ":1)" });
    }
  }

  const realCuts = cuts.filter((c) => c.kind === "corte");
  const reframed =realCuts.filter((c) => c.scale !== undefined && Math.abs(c.scale - 1) >= 0.04).length;
  // Jump cut seco: no Reel do app (uma câmera), corte sem mudar o enquadramento mostra o pulo da cabeça.
  // O Jota muda o enquadramento em 41% dos cortes (Patrícia). Pela imagem não dá para separar do corte para
  // a imagem de apoio, então só com os metadados.
  if (metaCuts && realCuts.length >= 2 && reframed / realCuts.length < 0.3) {
    add({ at: realCuts[0].t, kind: "corte-sem-reenquadrar", detail: reframed + " de " + realCuts.length + " cortes mudam o enquadramento" });
  }

  defects.sort((a, b) => a.at - b.at);
  const g = grade(defects);
  const pauses = quiet.filter((q) => !q.edge).map((q) => q.endMs - q.startMs);
  return {
    file, score: g.score, pass: g.pass, count: g.count, defects,
    medidas: {
      formato: info.w + "x" + info.h + " " + info.vcodec + " " + info.fps + " q/s, " + info.acodec + " " + info.sampleRate + " Hz" + (info.hdr ? " (HDR)" : ""),
      duracao: Number(info.duration.toFixed(2)), lufs: loud.lufs, truePeak: loud.truePeak, lra: loud.lra,
      cortes: realCuts.length, transicoes: cuts.filter((c) => c.kind === "transicao").length, fonteDosCortes: metaCuts ? "app" : "imagem",
      planoMedioS: shots.length ? Number((median(shots)).toFixed(2)) : 0, planoMinS: shots.length ? Number(Math.min(...shots).toFixed(2)) : 0,
      cortesComReenquadre: realCuts.length ? Math.round((reframed / realCuts.length) * 100) + "%" : "-",
      falaComecaMs: leadIn, sobraNoFimMs: tail,
      pausaMedianaMs: pauses.length ? median(pauses) : 0, pausaMaxMs: pauses.length ? Math.max(...pauses) : 0,
      // folga nas emendas (só as que caíram fora da fala): da fala ao corte e do corte à fala
      folgaAntesMs: median(realCuts.filter((c) => c.gap && !c.voiced).map((c) => c.gap.before)),
      folgaDepoisMs: median(realCuts.filter((c) => c.gap && !c.voiced).map((c) => c.gap.after)),
      vozDb: Number(sm.voice.toFixed(1)), ruidoDb: Number(sm.floor.toFixed(1)),
      // legendas olhadas (máscara do app): quantas com 80% das letras em 3:1 ou mais, e a mediana das razões
      legendasLegiveis: legib.length ? Math.round((legib.filter((c) => c.ok >= 0.8).length / legib.length) * 100) + "% de " + legib.length : "-",
      contrasteLegenda: legib.length ? Number(median(legib.map((c) => c.ratio)).toFixed(2)) : null,
    },
    cortes: o.detail ? cuts.map((c) => ({ t: Number(c.t.toFixed(3)), kind: c.kind, frames: c.frames, scale: c.scale, click: c.click && Number(c.click.toFixed(1)), voiced: c.voiced, gap: c.gap, syncMs: c.syncMs, levelJump: c.levelJump, err: c.err && Number(c.err.toFixed(1)), err1: c.err1 && Number(c.err1.toFixed(1)) })) : undefined,
  };
}

function printReport(r) {
  const m = r.medidas;
  console.log("\n" + path.basename(r.file) + ": nota " + r.score + (r.pass ? " (passa)" : " (NÃO passa)"));
  console.log("  " + m.formato + ", " + m.duracao + " s, " + m.lufs + " LUFS, pico " + m.truePeak + " dBTP");
  console.log("  " + m.cortes + " cortes (" + m.fonteDosCortes + ")" + (m.transicoes ? " + " + m.transicoes + " transições" : "") + ", plano mediano " + m.planoMedioS + " s (mín. " + m.planoMinS + " s), reenquadre em " + m.cortesComReenquadre);
  console.log("  fala começa em " + m.falaComecaMs + " ms, sobra no fim " + m.sobraNoFimMs + " ms, pausa mediana " + m.pausaMedianaMs + " ms (máx. " + m.pausaMaxMs + " ms), folga na emenda " + m.folgaAntesMs + " + " + m.folgaDepoisMs + " ms");
  if (m.legendasLegiveis !== "-") console.log("  legendas legíveis: " + m.legendasLegiveis + " (contraste mediano " + m.contrasteLegenda + ":1)");
  for (const d of r.defects) console.log("  - " + d.at.toFixed(2).padStart(7) + " s  " + d.kind + (d.detail ? ": " + d.detail : ""));
  if (r.cortes) for (const c of r.cortes) console.log("    corte " + JSON.stringify(c));
}

async function main() {
  const args = process.argv.slice(2);
  const files = args.filter((a) => !a.startsWith("--"));
  if (!files.length) {
    console.log("uso: npm run reel:juiz -- <reel.mp4> [outro.mp4 ...] [--json] [--detalhe]");
    process.exit(2);
  }
  const all = [];
  for (const f of files) {
    const r = await judge(f, { detail: args.includes("--detalhe") });
    all.push(r);
    if (!args.includes("--json")) printReport(r);
  }
  if (args.includes("--json")) console.log(JSON.stringify(all, null, 2));
  process.exitCode = all.every((r) => r.pass) ? 0 : 1;
}

module.exports = { LIMITS, WEIGHTS, median, percentile, frameDiffs, findCuts, spikeNear, scaleBetween, alignError, envelopeDb, speechMask, quietSpans, clickDb, sideLevels, voicedAt, gapsAt, textContrast, captionIssues, cutInsideWord, grade, cutsFromTrechos, sidecar, judge, probe };

if (require.main === module) main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(2);
});
