// Quem está falando (src/core/video/speaker.js), com os casos dos testes do Open Clip.
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../src/core/video/speaker.js");

const words = (list) => list.map(([text, start, end]) => ({ text, start, end }));

test("falas: ponto final, última palavra e pausa de 0,35 s terminam uma fala", () => {
  const w = words([["oi", 0, 0.3], ["tudo", 0.35, 0.6], ["bem.", 0.6, 0.9], ["e", 1.0, 1.2], ["aí", 1.6, 1.9]]);
  assert.deepEqual([...S.boundaryIndices(w)].sort(), [2, 3, 4]);
});

test("janelas: as mesmas regras do Open Clip", () => {
  // sem fronteira: uma janela só
  let w = words([0, 1, 2, 3, 4].map((i) => ["w" + i, i * 0.3, i * 0.3 + 0.2]));
  assert.deepEqual(S.speechWindows(w, new Set(), 1.4, 3), [[0, 1.4]]);
  // corta na fronteira quando a janela já tem 3 s
  w = words([["A", 0, 1], ["B", 1, 2], ["C.", 2, 4], ["D", 4, 5], ["E", 5, 6], ["F.", 6, 8]]);
  assert.deepEqual(S.speechWindows(w, new Set([2, 5]), 8, 3), [[0, 4], [4, 8]]);
  // fronteira cedo demais é pulada
  w = words([["A.", 0, 0.5], ["B", 0.5, 2], ["C.", 2, 5]]);
  assert.deepEqual(S.speechWindows(w, new Set([0, 2]), 5, 3), [[0, 5]]);
  // última janela curta junta com a anterior
  w = words([["A", 0, 1], ["B", 1, 2], ["C.", 2, 4], ["D.", 4, 4.3]]);
  assert.deepEqual(S.speechWindows(w, new Set([2, 3]), 4.3, 3), [[0, 4.3]]);
  // contíguas, cobrindo tudo, cortes só no fim de palavra; pausa e silêncio do fim não somem
  w = words([["A", 0, 1], ["B.", 1, 3], ["C", 4.5, 5.5], ["D.", 5.5, 7]]);
  const win = S.speechWindows(w, new Set([1, 3]), 8, 1);
  assert.deepEqual(win, [[0, 3], [3, 8]]);
});

test("pessoas: rostos perto viram a mesma pessoa; longe, outra", () => {
  const f = (x) => ({ x: x, y: 100, w: 80, h: 100 });
  const tracks = S.groupTracks([[f(100), f(900)], [f(110), f(905)], [f(95)]]);
  assert.equal(tracks.length, 2);
  assert.equal(tracks[0].faces.length, 3);
  assert.equal(tracks[1].faces.length, 2);
  assert.deepEqual(S.trackCenter(tracks[1]).map(Math.round), [943, 150]);
});

test("pessoas: rosto falso num quadro só ou quem se inclinou não vira 3ª pessoa num podcast de 2", () => {
  const f = (x, w) => ({ x: x, y: 100, w: w || 80, h: 100 });
  // 6 quadros de uma fala: A em 100, B em 900; no 3º, um rosto falso (quadro na parede); no 5º, A inclinado (+100 px)
  const frames = [[f(100), f(900)], [f(102), f(898)], [f(101), f(903), f(500, 40)], [f(99), f(900)], [f(200), f(901)], [f(100), f(899)]];
  const tracks = S.groupTracks(frames);
  assert.equal(tracks.length, 2, "contou " + tracks.length);
  assert.deepEqual(tracks.map((t) => Math.round(S.trackCenter(t)[0])), [140, 940]);
  // terceira pessoa de verdade (vista em vários quadros) continua contando
  assert.equal(S.groupTracks(frames.map((q) => q.concat([f(1500)]))).length, 3);
  // uma pessoa só, o rosto falso num quadro: 1
  assert.equal(S.groupTracks([[f(100)], [f(100), f(600)], [f(102)]]).length, 1);
  assert.deepEqual(S.groupTracks([]), []);
});

test("boca: quem mexe a boca fala; ninguém mexendo, o maior rosto", () => {
  const still = new Uint8Array(16).fill(100);
  const moving = (v) => new Uint8Array(16).fill(v);
  const parado = { id: 0, faces: [1, 2, 3].map(() => ({ x: 100, y: 0, w: 80, h: 100, roi: still })) };
  const falando = { id: 1, faces: [100, 140, 90].map((v) => ({ x: 900, y: 0, w: 60, h: 80, roi: moving(v) })) };
  assert.equal(S.lipScore(falando.faces.map((f) => f.roi), []), (40 + 50) / 2 * 0.7);
  assert.equal(S.pickSpeaker([parado, falando]).id, 1);
  const outroParado = { id: 2, faces: [{ x: 900, y: 0, w: 40, h: 50, roi: still }, { x: 900, y: 0, w: 40, h: 50, roi: still }] };
  assert.equal(S.pickSpeaker([outroParado, parado]).id, 0);
  assert.deepEqual(S.mouthBox({ x: 100, y: 200, w: 80, h: 100 }), { x: 124, y: 262.5, w: 32, h: 25 });
});

test("duas pessoas empilhadas: metade em cima e embaixo, cada uma no seu rosto", () => {
  // 1920x1080 para 1080x960 (1,125): recorte 1215x1080 (altura toda)
  assert.deepEqual(S.panelCrop([], 1920, 1080), { x: 352, y: 0, w: 1215, h: 1080 });
  const left = S.panelCrop([{ x: 300, y: 200, w: 150, h: 200 }, { x: 310, y: 210, w: 150, h: 200 }], 1920, 1080);
  assert.deepEqual(left, { x: 0, y: 0, w: 1215, h: 1080 }); // rosto perto da borda: preso nela
  const right = S.panelCrop([{ x: 1500, y: 200, w: 150, h: 200 }], 1920, 1080);
  assert.deepEqual(right, { x: 705, y: 0, w: 1215, h: 1080 });
  // em pé 1080x1920 para 1080x960: largura toda, altura 960, 10% de folga sobre a cabeça
  assert.deepEqual(S.panelCrop([{ x: 400, y: 500, w: 200, h: 250 }], 1080, 1920), { x: 0, y: 404, w: 1080, h: 960 });
  assert.equal(S.stackedFilter({ x: 0, y: 0, w: 1215, h: 1080 }, { x: 705, y: 0, w: 1215, h: 1080 }),
    "split=2[cima][baixo];[cima]crop=1215:1080:0:0,scale=1080:960,setsar=1[c1];[baixo]crop=1215:1080:705:0,scale=1080:960,setsar=1[c2];[c1][c2]vstack=inputs=2");
});

test("empilhado e troca de pessoa rodam no grafo da passada final (ffmpeg de verdade)", (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { spawnSync } = require("node:child_process");
  const P = require("../prototypes/reel-sem-premiere/plan.js");
  const bundled = path.join(__dirname, "../src/adobe/cep/bin/ffmpeg.exe");
  const ffmpeg = process.platform === "win32" && fs.existsSync(bundled) ? bundled : "ffmpeg";
  if (spawnSync(ffmpeg, ["-version"]).status !== 0) return t.skip("ffmpeg ausente");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-duas-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lavfi = (spec) => ["-f", "lavfi", "-i", spec];
  const bruto = path.join(dir, "podcast.mp4");
  spawnSync(ffmpeg, ["-hide_banner", "-v", "error", "-y"].concat(lavfi("testsrc2=size=640x360:rate=30:duration=2"),
    lavfi("sine=duration=2"), ["-c:v", "mpeg4", "-c:a", "aac", "-shortest", bruto]));
  const run = (reframe, name) => {
    const file = path.join(dir, name + ".txt");
    fs.writeFileSync(file, P.finalGraph({ W: 1080, H: 1920, band: { y: 800, h: 100 }, cut: null, reframe: reframe, zoom: "1", fx: [], music: false }));
    const out = path.join(dir, name + ".mp4");
    const r = spawnSync(ffmpeg, ["-hide_banner", "-v", "error", "-y", "-i", bruto].concat(lavfi("color=c=white@0.0:s=1080x100:r=30:d=2,format=rgba"),
      lavfi("anullsrc=d=0.1"), lavfi("anullsrc=d=0.1"), ["-/filter_complex", file, "-map", "[v]", "-map", "[a]", "-c:v", "mpeg4", "-c:a", "aac", out]), { encoding: "utf8" });
    assert.equal(r.status, 0, name + ": " + r.stderr);
    assert.match(spawnSync(ffmpeg, ["-hide_banner", "-i", out], { encoding: "utf8" }).stderr, /1080x1920/, name);
  };
  // empilhado: as duas metades no lugar do recorte em pé
  run(S.stackedFilter(S.panelCrop([{ x: 60, y: 60, w: 60, h: 80 }], 640, 360), S.panelCrop([{ x: 500, y: 60, w: 60, h: 80 }], 640, 360)), "duas");
  // troca de pessoa: x do crop por tempo (como o pipeline monta)
  const cw = 202;
  run("crop=" + cw + ":360:'" + S.cropXExpr([{ from: 0, to: 1, x: 0 }, { from: 1, to: 2, x: 438 }]) + "':0,scale=1080:1920,setsar=1", "quemfala");
});

test("recorte que troca de pessoa: expressão por janela para o crop do ffmpeg", () => {
  assert.equal(S.cropXExpr([{ from: 0, to: 4, x: 100 }]), "100");
  assert.equal(S.cropXExpr([{ from: 0, to: 4, x: 100 }, { from: 4, to: 8, x: 900 }, { from: 8, to: 12, x: 100 }]),
    "if(lt(t\\,4.000)\\,100\\,if(lt(t\\,8.000)\\,900\\,100))");
});

test("followPlan: 2 pessoas sempre seguem; uma só, só se andou 8% da largura", () => {
  assert.deepEqual(S.followPlan([0.3, null, 0.7], 2), [0.3, 0.3, 0.7]);
  assert.equal(S.followPlan([0.5, 0.52, 0.55], 1), null);
  assert.deepEqual(S.followPlan([null, 0.4, 0.6], 1), [0.4, 0.4, 0.6]);
  assert.equal(S.followPlan([null, null], 0), null);
});

test("bigFaces: caixinha falsa (menos de 15% da área do maior) sai", () => {
  const out = S.bigFaces([{ x: 0, y: 0, w: 100, h: 100 }, { x: 300, y: 0, w: 90, h: 90 }, { x: 500, y: 0, w: 30, h: 30 }]);
  assert.equal(out.length, 2);
  assert.deepEqual(S.bigFaces([]), []);
});
