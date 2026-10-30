/**
 * Para onde a pessoa olha: a frase inteira dita olhando o paletó ("Tem uma palavra que é ruim de começar." e
 * "Domingos Garcia" no 2.MOV, noite de 21/10) perde a vez na escolha do Reel na duração (reel-plan.avoid).
 * A caixa do FaceDetector do Windows não diz para onde a pessoa olha; aqui é a malha do rosto do MediaPipe
 * (Face Landmarker, Apache-2.0, 478 pontos e a matriz da cabeça), que roda offline no Chromium do Electron.
 *
 * Contas (tests/reel-olhar.test.js):
 *   pose(m)                       -> { pitch, yaw } em graus (pitch > 0: cabeça para baixo); m = matriz 4x4 do MediaPipe
 *   facing(s)                     -> a amostra { face, pitch, yaw } está de frente para a câmera
 *   awaySentences(sentences, words, samples) -> [{ from, to }] frases ditas sem olhar a câmera
 * No Electron (pipeline.js):
 *   measure({ ffmpeg, input, dir, duration, signal, key }) -> [{ t, face, pitch, yaw }] (t em s do bruto; key: o mesmo
 *     vídeo de novo não mede outra vez)
 */
"use strict";

// Medido nos 3 brutos (quadros-chave olhados um a um): de frente, a cabeça fica em |yaw| até 24° e pitch até 5°;
// olhando o paletó, yaw 29 a 56° ou pitch 11 a 31°, e muitas vezes nenhum rosto (cabeça baixa demais).
const MAX_YAW = 25;
const MAX_PITCH = 15;
const WORD_PAD_S = 0.15; // amostra conta para a palavra até 150 ms antes e depois dela
const AWAY_SHARE = 0.25; // frase sem olhar: no máximo 1/4 das amostras de frente
const MIN_SAMPLES = 2; // com uma amostra só, um piscar decidiria
const MIN_FACE_SHARE = 0.5; // vídeo sem pessoa (tela gravada, paisagem): não é cabeça falante, nada perde a vez

function pose(m) {
  const deg = (r) => (r * 180) / Math.PI;
  // coluna por coluna: R[i][j] = m[j*4+i]
  return { pitch: deg(Math.atan2(m[6], m[10])), yaw: deg(Math.asin(Math.max(-1, Math.min(1, -m[2])))) };
}

function facing(s) {
  return !!s.face && Math.abs(s.yaw) <= MAX_YAW && s.pitch <= MAX_PITCH;
}

// sentences: [{ from, to }] (reel-plan.strongSentences), words com startMs/endMs, samples de measure()
function awaySentences(sentences, words, samples) {
  if (!samples || !samples.length || samples.filter((s) => s.face).length < samples.length * MIN_FACE_SHARE) return [];
  return sentences.filter((u) => {
    // só as amostras de quando a palavra está sendo dita (a pausa sai no corte)
    const inside = samples.filter((s) => {
      for (let i = u.from; i <= u.to; i += 1) {
        if (s.t >= words[i].startMs / 1000 - WORD_PAD_S && s.t <= words[i].endMs / 1000 + WORD_PAD_S) return true;
      }
      return false;
    });
    return inside.length >= MIN_SAMPLES && inside.filter(facing).length <= inside.length * AWAY_SHARE;
  });
}

// --- Medida (só no Electron: ffmpeg, Image, canvas, FaceDetector) ---

const LANES = 3; // ffmpegs ao mesmo tempo: o quadro-chave decodifica em uma linha só (4K: ~150 ms cada)
const SIDE = 256; // o recorte em volta do rosto que vai para a malha

// Quadros-chave em JPEG de 480 px e o tempo de cada um. Só o quadro-chave (-skip_frame nokey): no iPhone vem 1 a
// cada 0,93 s e não decodifica o resto (o vídeo inteiro a 3 q/s levava 72 s num bruto de 3 min; o quadro-chave, 11 s).
function keyFrames(o, from, to, tag) {
  const { spawn } = require("child_process");
  const path = require("path");
  return new Promise((resolve) => {
    const args = ["-hide_banner", "-nostats", "-y", "-skip_frame", "nokey", "-ss", from.toFixed(3), "-t", (to - from).toFixed(3), "-i", o.input,
      "-vf", "scale=480:-2,showinfo", "-fps_mode", "passthrough", "-q:v", "5", path.join(o.dir, "olhar" + tag + "-%04d.jpg")];
    const child = spawn(o.ffmpeg, args, { windowsHide: true });
    const stop = () => { try { child.kill(); } catch (e) { /* já terminou */ } };
    if (o.signal) o.signal.addEventListener("abort", stop);
    const times = [];
    let rest = "";
    child.stderr.on("data", (d) => {
      const lines = (rest + d).split(/\r?\n/);
      rest = lines.pop();
      lines.forEach((l) => {
        const m = /showinfo.*pts_time:([0-9.]+)/.exec(l);
        if (m) times.push(from + Number(m[1]));
      });
    });
    child.on("error", () => resolve([]));
    child.on("close", () => {
      if (o.signal) o.signal.removeEventListener("abort", stop);
      resolve(times.map((t, i) => ({ t, file: path.join(o.dir, "olhar" + tag + "-" + String(i + 1).padStart(4, "0") + ".jpg") })));
    });
  });
}

// uma malha por janela (cada uma é um wasm novo) e a medida de cada vídeo guardada: a prévia que se refaz sozinha
// e o "Fazer de novo" não medem outra vez
let shared = null;
const memo = new Map();

async function measure(o) {
  if (o.key && memo.has(o.key)) return memo.get(o.key);
  const fs = require("fs");
  const path = require("path");
  const V = require(path.join(__dirname, "node_modules/@mediapipe/tasks-vision/vision_bundle.cjs"));
  const wasm = "file:///" + path.join(__dirname, "node_modules/@mediapipe/tasks-vision/wasm").replace(/\\/g, "/");
  // os caminhos direto (o FilesetResolver testa o SIMD antes e levava 4 s); o modelo vai em bytes (sem fetch de file://)
  shared = shared || V.FaceLandmarker.createFromOptions(
    { wasmLoaderPath: wasm + "/vision_wasm_internal.js", wasmBinaryPath: wasm + "/vision_wasm_internal.wasm" },
    { baseOptions: { modelAssetBuffer: new Uint8Array(fs.readFileSync(path.join(__dirname, "modelos/face_landmarker.task"))), delegate: "CPU" },
      runningMode: "IMAGE", numFaces: 1, outputFacialTransformationMatrixes: true });
  const landmarker = await shared.catch((e) => { shared = null; throw e; });
  const step = o.duration / LANES;
  const lanes = await Promise.all(Array.from({ length: LANES }, (_, k) => keyFrames(o, k * step, k === LANES - 1 ? o.duration + 1 : (k + 1) * step, k)));
  const frames = [].concat(...lanes);
  // o detector da malha é para selfie: rosto pequeno no quadro inteiro (pessoa em pé) escapava em 4 de 10 quadros.
  // Então a malha olha um recorte em volta do rosto: o do quadro anterior ou o que o FaceDetector do sistema acha.
  const fd = typeof FaceDetector !== "undefined" ? new FaceDetector({ fastMode: true, maxDetectedFaces: 1 }) : null;
  const canvas = document.createElement("canvas");
  canvas.width = SIDE;
  canvas.height = SIDE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const out = [];
  let last = null; // { cx, cy, s } em px do quadro
  for (const f of frames) {
    if (o.signal && o.signal.aborted) break;
    const sample = { t: f.t, face: false, pitch: 0, yaw: 0 };
    out.push(sample);
    let img;
    try {
      img = new Image();
      img.src = "file:///" + f.file.replace(/\\/g, "/");
      await img.decode();
    } catch (e) {
      continue; // quadro que não saiu
    }
    const look = (c) => {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, SIDE, SIDE);
      ctx.drawImage(img, c.cx - c.s / 2, c.cy - c.s / 2, c.s, c.s, 0, 0, SIDE, SIDE);
      const r = landmarker.detect(canvas);
      return r.faceLandmarks.length ? { r, c } : null;
    };
    let hit = last ? look(last) : null;
    if (!hit && fd) {
      const faces = await fd.detect(img).catch(() => []);
      if (faces.length) {
        const b = faces[0].boundingBox;
        hit = look({ cx: b.x + b.width / 2, cy: b.y + b.height / 2, s: Math.max(b.width, b.height) * 2.6 });
      }
    }
    last = null;
    if (!hit) continue;
    Object.assign(sample, { face: true }, pose(hit.r.facialTransformationMatrixes[0].data));
    // o próximo recorte: 2,2x o lado da malha, no centro dela
    const pts = hit.r.faceLandmarks[0];
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const x0 = Math.min(...xs), y0 = Math.min(...ys), side = Math.max(Math.max(...xs) - x0, Math.max(...ys) - y0) * hit.c.s;
    last = { cx: hit.c.cx - hit.c.s / 2 + ((x0 + Math.max(...xs)) / 2) * hit.c.s, cy: hit.c.cy - hit.c.s / 2 + ((y0 + Math.max(...ys)) / 2) * hit.c.s, s: side * 2.2 };
  }
  frames.forEach((f) => { try { fs.unlinkSync(f.file); } catch (e) { /* não saiu */ } });
  if (o.key && !(o.signal && o.signal.aborted)) memo.set(o.key, out);
  return out;
}

module.exports = { pose, facing, awaySentences, measure, MAX_YAW, MAX_PITCH };
