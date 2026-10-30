/**
 * Quem está falando: o recorte em pé vai para a pessoa que fala, trocando só no fim de uma fala.
 * Lógica portada do Open Clip (D:\Projetos\.code\open-clip-local, face_tracking.py e
 * segmentation.py, do Julian), com os mesmos testes (tests/reel-speaker.test.js). Aqui só contas:
 * quem extrai os quadros é quem chama (o protótipo e o painel, aba Revisar); o facesInImages
 * acha os rostos no navegador (FaceDetector).
 */
(function (root) {
"use strict";

const SENTENCE_END = /[.!?]$/;
const PAUSE_S = 0.35;

// Índices das palavras que terminam uma fala: ponto final, última palavra ou pausa >= 0,35 s.
// words: [{ text, start, end }] em segundos.
function boundaryIndices(words, pauseS) {
  const pause = pauseS === undefined ? PAUSE_S : pauseS;
  const out = new Set();
  words.forEach((w, i) => {
    const next = words[i + 1];
    if (SENTENCE_END.test(String(w.text).trim()) || !next || next.start - w.end >= pause) out.add(i);
  });
  return out;
}

// Janelas contíguas [início, fim) de pelo menos minS segundos, cobrindo [0, total], que só cortam no
// fim de uma fala (o fim da palavra; a pausa depois vai para a janela seguinte, nada some). Uma
// última janela curta demais se junta à anterior (troca de recorte por meio segundo é feia).
function speechWindows(words, boundaries, total, minS) {
  const min = minS === undefined ? 3 : minS;
  if (!words.length) return [];
  const last = words.length - 1;
  const cuts = [];
  let from = 0;
  words.forEach((w, i) => {
    const isLast = i === last;
    if (!boundaries.has(i) && !isLast) return;
    if (w.end - words[from].start < min && !isLast) return;
    cuts.push(w.end);
    from = i + 1;
  });
  if (!cuts.length) cuts.push(total);
  else cuts[cuts.length - 1] = total;
  const windows = [];
  let prev = 0;
  cuts.forEach((c) => {
    windows.push([prev, c]);
    prev = c;
  });
  if (windows.length >= 2 && windows[windows.length - 1][1] - windows[windows.length - 1][0] < min) {
    windows[windows.length - 2][1] = windows[windows.length - 1][1];
    windows.pop();
  }
  return windows;
}

// Agrupa os rostos achados nos quadros em pessoas: o rosto entra na pessoa cujo centro (mediana)
// está a menos de 0,8 do tamanho do rosto; senão vira pessoa nova.
// frames: [[{ x, y, w, h, roi }]] (um array de rostos por quadro). -> [{ id, faces: [...] }]
function groupTracks(frames) {
  const tracks = [];
  frames.forEach((faces) => {
    faces.forEach((f) => {
      const cx = f.x + f.w / 2;
      const cy = f.y + f.h / 2;
      let best = null;
      let bestD = Infinity;
      tracks.forEach((t) => {
        const c = trackCenter(t);
        const d = Math.hypot(cx - c[0], cy - c[1]);
        if (d < Math.max(f.w, f.h) * 0.8 && d < bestD) {
          best = t;
          bestD = d;
        }
      });
      if (best) best.faces.push(f);
      else tracks.push({ id: tracks.length, faces: [f] });
    });
  });
  // Pessoas = quantos rostos aparecem juntos num quadro, em 2 quadros ou mais (com até 2 quadros, em 1).
  // Um rosto falso num quadro só, ou quem se inclinou (o centro pulou mais que 0,8 do rosto), virava
  // uma pessoa a mais: "3 pessoas" num podcast de 2. Ficam as pessoas vistas em mais quadros.
  const need = frames.length >= 3 ? 2 : 1;
  let people = 0;
  while (frames.filter((faces) => faces.length > people).length >= need) people += 1;
  if (tracks.length <= people) return tracks;
  const kept = tracks.slice().sort((a, b) => b.faces.length - a.faces.length || a.id - b.id).slice(0, people);
  return tracks.filter((t) => kept.indexOf(t) >= 0);
}

function median(list) {
  const s = list.slice().sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function trackCenter(t) {
  return [median(t.faces.map((f) => f.x + f.w / 2)), median(t.faces.map((f) => f.y + f.h / 2))];
}

function trackArea(t) {
  return median(t.faces.map((f) => f.w * f.h));
}

// Região da boca de um rosto sem pontos de referência: metade de baixo, no meio (como o Open
// Clip faz quando o detector não dá os cantos da boca). -> { x, y, w, h } em pixels
function mouthBox(f) {
  const w = f.w * 0.4;
  const h = f.h * 0.25;
  return { x: f.x + f.w * 0.5 - w / 2, y: f.y + f.h * 0.75 - h / 2, w: w, h: h };
}

// Quanto a boca mexe: média da diferença de cinza entre quadros seguidos da região da boca
// (mesmo tamanho, ex.: 32x32) x 0,7 + variação da largura da boca x 0,3. rois: [Uint8Array cinza]
function lipScore(rois, widths) {
  const valid = rois.filter(Boolean);
  if (valid.length < 2) return 0;
  const ws = (widths || []).filter((w) => w > 0);
  let widthVar = 0;
  if (ws.length > 1) {
    const mean = ws.reduce((a, b) => a + b, 0) / ws.length;
    widthVar = ws.reduce((a, b) => a + (b - mean) * (b - mean), 0) / ws.length;
  }
  const diffs = [];
  for (let i = 1; i < valid.length; i += 1) {
    const a = valid[i - 1];
    const b = valid[i];
    let sum = 0;
    for (let k = 0; k < a.length; k += 1) sum += Math.abs(a[k] - b[k]);
    diffs.push(sum / a.length);
  }
  const motion = diffs.reduce((x, y) => x + y, 0) / diffs.length;
  return motion * 0.7 + widthVar * 0.3;
}

// A pessoa que fala na janela: maior movimento de boca; se ninguém mexe, o maior rosto.
function pickSpeaker(tracks) {
  const scored = tracks.filter((t) => t.faces.length).map((t) => ({
    t: t,
    score: lipScore(t.faces.map((f) => f.roi), t.faces.map((f) => f.w * 0.4)),
  }));
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  if (scored[0].score <= 0 && scored.length > 1) return tracks.slice().sort((a, b) => trackArea(b) - trackArea(a))[0];
  return scored[0].t;
}

// x do recorte (pixels do quadro) que varia por janela, para o crop do ffmpeg (avaliado a cada
// quadro). spans: [{ from, to, x }] em segundos do vídeo de saída, contíguos.
function cropXExpr(spans) {
  if (!spans.length) return "0";
  let e = String(Math.round(spans[spans.length - 1].x));
  for (let i = spans.length - 2; i >= 0; i -= 1) {
    e = "if(lt(t\\," + spans[i].to.toFixed(3) + ")\\," + Math.round(spans[i].x) + "\\," + e + ")";
  }
  return e;
}

// Duas pessoas empilhadas (metade de cima e de baixo da tela em pé, 1080x960 cada): o recorte de
// uma metade, centrado no rosto, com 10% de folga acima da cabeça. Sem rosto, o centro.
// faces: rostos da pessoa em pixels do bruto. -> { x, y, w, h }
function panelCrop(faces, sw, sh, pw, ph) {
  const aspect = (pw || 1080) / (ph || 960);
  let w, h;
  if (sw / sh > aspect) {
    h = sh;
    w = Math.round(h * aspect);
  } else {
    w = sw;
    h = Math.round(w / aspect);
  }
  if (!faces.length) return { x: Math.floor((sw - w) / 2), y: Math.floor((sh - h) / 2), w: w, h: h };
  const cx = median(faces.map((f) => f.x + f.w / 2));
  const top = median(faces.map((f) => f.y));
  const x = Math.max(0, Math.min(sw - w, Math.round(cx - w / 2)));
  const y = Math.max(0, Math.min(sh - h, Math.round(top - 0.1 * h)));
  return { x: x, y: y, w: w, h: h };
}

// Grafo do ffmpeg que monta as duas metades (a pessoa da esquerda em cima). Entra depois do
// corte (select), no lugar do recorte em pé. -> trecho de filtro que termina em 1080x1920
function stackedFilter(top, bottom) {
  const c = (p) => "crop=" + p.w + ":" + p.h + ":" + p.x + ":" + p.y + ",scale=1080:960,setsar=1";
  return "split=2[cima][baixo];[cima]" + c(top) + "[c1];[baixo]" + c(bottom) + "[c2];[c1][c2]vstack=inputs=2";
}

// O x (fração da largura) do recorte em cada janela, ou null para o recorte fixo. picks: o centro
// de quem fala em cada janela (null = ninguém achado, fica o anterior). Com 2+ pessoas, sempre
// segue; com uma só, só se ela andou pelo menos minMove da largura (senão o fixo no rosto basta).
function followPlan(picks, people, minMove) {
  const seen = picks.filter((x) => x !== null);
  if (!seen.length || people < 1) return null;
  if (people < 2 && Math.max(...seen) - Math.min(...seen) < (minMove === undefined ? 0.08 : minMove)) return null;
  let last = seen[0];
  return picks.map((x) => (last = x === null ? last : x));
}

// Só os rostos com pelo menos minShare da área do maior: o detector do Premiere devolve caixinhas
// falsas (o mesmo filtro do face-box.js), e uma delas viraria uma "segunda pessoa".
function bigFaces(faces, minShare) {
  const big = Math.max(0, ...faces.map((f) => f.w * f.h));
  return faces.filter((f) => f.w * f.h >= big * (minShare === undefined ? 0.15 : minShare));
}

// Rostos de cada imagem, com a região da boca em 16x16 cinza (para o lipScore). Só no navegador:
// detector é um FaceDetector; images, imagens já decodificadas. -> frames para o groupTracks
async function facesInImages(images, detector) {
  const frame = document.createElement("canvas");
  const fctx = frame.getContext("2d", { willReadFrequently: true });
  const small = document.createElement("canvas");
  small.width = small.height = 16;
  const sctx = small.getContext("2d", { willReadFrequently: true });
  const frames = [];
  for (const img of images) {
    frame.width = img.naturalWidth;
    frame.height = img.naturalHeight;
    fctx.drawImage(img, 0, 0);
    const found = await detector.detect(img).catch(() => []);
    const faces = bigFaces(found.map((fc) => ({ x: fc.boundingBox.x, y: fc.boundingBox.y, w: fc.boundingBox.width, h: fc.boundingBox.height })));
    frames.push(faces.map((f) => {
      const m = mouthBox(f);
      sctx.drawImage(frame, m.x, m.y, m.w, m.h, 0, 0, 16, 16);
      const px = sctx.getImageData(0, 0, 16, 16).data;
      f.roi = new Uint8Array(256);
      for (let k = 0; k < 256; k += 1) f.roi[k] = (px[k * 4] * 0.299 + px[k * 4 + 1] * 0.587 + px[k * 4 + 2] * 0.114) | 0;
      return f;
    }));
  }
  return frames;
}

const api = {
  panelCrop, stackedFilter, followPlan, bigFaces, boundaryIndices, speechWindows, groupTracks, trackCenter, mouthBox, lipScore, pickSpeaker, cropXExpr,
  facesInImages,
};
// No painel CEP (e no Electron do protótipo) o Node também define `module`; com window, o destino é o global.
if (typeof window === "undefined" && typeof module === "object" && module.exports) module.exports = api;
else root.AppLegendasSpeaker = api;
})(typeof self !== "undefined" ? self : this);
