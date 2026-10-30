const test = require("node:test");
const assert = require("node:assert/strict");
const J = require("../scripts/reel-juiz.js");

// imagem com textura (para o alinhamento ter onde se agarrar), escalada por s em volta de (fx, fy)
function textured(w, h, s, fx, fy, shift) {
  const img = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const u = fx + (x - fx) / (s || 1) + (shift || 0), v = fy + (y - fy) / (s || 1);
    img[y * w + x] = Math.max(0, Math.min(255, Math.round(128 + 50 * Math.sin(u / 4.1) * Math.cos(v / 6.3) + 40 * Math.sin((u + 2 * v) / 9.7))));
  }
  return img;
}

test("juiz: corte seco achado pela imagem; legenda que entra não é corte; vários quadros seguidos viram transição", () => {
  const w = 54, h = 96;
  const frames = [];
  for (let i = 0; i < 100; i += 1) {
    // plano A até o quadro 29, plano B (outra textura) do 30 em diante; mexendo um pouco (fala)
    const f = i < 30 ? textured(w, h, 1, 20, 40, i * 0.05) : textured(w, h, 1.3, 10, 70, i * 0.05);
    // "legenda" que aparece no quadro 50: só uma faixa estreita muda
    if (i >= 50) for (let y = 60; y < 66; y += 1) for (let x = 10; x < 44; x += 1) f[y * w + x] = 255;
    // flash de 3 quadros (transição) em 70..72
    if (i >= 70 && i <= 72) f.fill(240 - (i - 70) * 60);
    frames.push(f);
  }
  const cuts = J.findCuts(J.frameDiffs(frames, w, h), 30);
  assert.deepEqual(cuts.map((c) => [c.frame, c.kind]), [[30, "corte"], [70, "transicao"]]);
});

test("juiz: punch-in medido (12% a mais em volta do rosto); plano igual dá 1", () => {
  const w = 108, h = 192;
  const a = textured(w, h, 1, 54, 70);
  const b = textured(w, h, 1.12, 54, 70);
  assert.ok(Math.abs(J.scaleBetween(a, b, w, h).s - 1.12) <= 0.011, "punch-in de 12%");
  assert.ok(Math.abs(J.scaleBetween(b, a, w, h).s - 1 / 1.12) <= 0.011, "volta para o aberto");
  assert.equal(J.scaleBetween(a, a, w, h).s, 1);
});

test("juiz: estalo na emenda (onda cortada no meio) é pego; com micro fade ou no silêncio, não", () => {
  const sr = 48000;
  const tone = (f, n, phase) => Float32Array.from({ length: n }, (_, i) => 0.3 * Math.sin(phase + (2 * Math.PI * f * i) / sr));
  // emenda seca: 0,5 s de 220 Hz e mais 0,5 s começando em outra fase (o salto da forma de onda)
  const a = tone(220, sr / 2, 0), b = tone(220, sr / 2, 2.2);
  const dry = new Float32Array(sr);
  dry.set(a, 0);
  dry.set(b, sr / 2);
  assert.ok(J.clickDb(dry, sr, 0.5) > J.LIMITS.clickDb, "emenda seca: " + J.clickDb(dry, sr, 0.5).toFixed(1) + " dB");
  // a mesma com 8 ms descendo e 8 subindo (o que o app faz em cada emenda)
  const faded = dry.slice();
  const d = Math.round(0.008 * sr);
  for (let i = 0; i < d; i += 1) {
    faded[sr / 2 - 1 - i] *= i / d;
    faded[sr / 2 + i] *= i / d;
  }
  assert.ok(J.clickDb(faded, sr, 0.5) < J.LIMITS.clickDb, "com fade: " + J.clickDb(faded, sr, 0.5).toFixed(1) + " dB");
  // no silêncio (ruído de fundo baixo dos dois lados), a emenda não estala
  const quiet = Float32Array.from({ length: sr }, (_, i) => 0.001 * Math.sin(i * 0.37) * Math.cos(i * 0.011));
  assert.ok(J.clickDb(quiet, sr, 0.5) < J.LIMITS.clickDb);
});

test("juiz: fala, pausas, folga na emenda e voz dos dois lados do corte", () => {
  // envelope de 10 ms: ruído em -60, fala em -15
  const db = Float32Array.from({ length: 300 }, (_, i) => ((i >= 20 && i < 100) || (i >= 130 && i < 280) ? -15 : -60));
  const sm = J.speechMask(db);
  assert.equal(sm.mask[19], false);
  assert.equal(sm.mask[20], true);
  assert.deepEqual(J.quietSpans(sm.mask, 10).map((q) => [q.startMs, q.endMs, q.edge]), [[0, 200, true], [1000, 1300, false], [2800, 3000, true]]);
  // corte em 1,2 s: 200 ms desde a fala, 100 ms até a próxima
  assert.deepEqual(J.gapsAt(sm.mask, 10, 1200), { before: 200, after: 100 });
  assert.equal(J.voicedAt(db, sm.mask, 10, 1200), false);
  assert.equal(J.voicedAt(db, sm.mask, 10, 500), true, "corte no meio da fala");
  assert.deepEqual(J.sideLevels(db, sm.mask, 10, 1200), { before: -15, after: -15 });
});

test("juiz: legenda atrasada, adiantada demais ou que pisca; palavra cortada pela emenda", () => {
  const words = [{ start: 1.0, end: 1.3, text: "Mãe" }, { start: 1.35, end: 1.8, text: "escola" }, { start: 3.0, end: 3.4, text: "três" }, { start: 5.0, end: 5.3, text: "fim" }];
  const caps = [
    { start: 1.02, end: 1.8, text: "Mãe escola" }, // 20 ms depois da palavra: ok
    { start: 3.2, end: 3.4, text: "três" }, // 200 ms atrasada e só 0,2 s na tela
    { start: 4.6, end: 5.3, text: "fim" }, // 400 ms antes da palavra
  ];
  assert.deepEqual(J.captionIssues(caps, words).map((d) => [d.kind, d.ms]), [["legenda-pisca", 200], ["legenda-atrasada", 200], ["legenda-adiantada", 400]]);
  assert.deepEqual(J.cutInsideWord([1.32, 1.6, 4.0], words).map((d) => d.text), ["escola"]);
});

test("juiz: legenda branca sobre camisa branca é ilegível; com contorno escuro ou fundo escuro, legível", () => {
  const w = 100, h = 30;
  // "letra": faixas verticais de 3 px a cada 8 px, nas linhas 10..20
  const mask = new Uint8Array(w * h);
  for (let y = 10; y < 20; y += 1) for (let x = 0; x < w; x += 1) if (x % 8 < 3) mask[y * w + x] = 255;
  const frame = (bg, edge) => Uint8Array.from(mask, (m, i) => {
    if (m) return 245; // a letra branca como saiu
    const x = i % w, y = Math.floor(i / w);
    const near = [-2, -1, 1, 2].some((d) => mask[y * w + x + d] || mask[(y + d) * w + x]);
    return near && edge ? edge : bg;
  });
  assert.ok(J.textContrast(mask, frame(230), w, h).ok < 0.2, "branca na camisa branca");
  assert.equal(J.textContrast(mask, frame(230, 60), w, h).ok, 1, "com o contorno escuro");
  assert.equal(J.textContrast(mask, frame(50), w, h).ok, 1, "no paletó escuro");
});

test("juiz: nota soma os pesos, cada tipo conta no máximo 3 vezes; emendas do app vêm dos trechos", () => {
  assert.deepEqual(J.grade([]), { score: 100, pass: true, count: {} });
  const many = Array.from({ length: 10 }, (_, i) => ({ at: i, kind: "estalo" }));
  assert.equal(J.grade(many).score, 100 - 3 * J.WEIGHTS.estalo);
  assert.equal(J.grade([{ kind: "formato" }, { kind: "preto" }, { kind: "congelado" }, { kind: "ar-morto-inicio" }]).pass, false);
  assert.deepEqual(J.cutsFromTrechos([[1, 3], [5, 6], [8, 9]]), [2, 3]);
  assert.deepEqual(J.cutsFromTrechos([[1, 3], [5, 6]], 2), [1]);
});
