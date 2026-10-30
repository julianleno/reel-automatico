const test = require("node:test");
const assert = require("node:assert/strict");
const { SAFE_ZONES, safeZoneIssues, liftIntoSafe, shrinkIntoSafe } = require("../src/core/captions/safezone.js");

const box = (left, top, right, bottom) => ({ left, top, right, bottom });

test("área segura: legenda estreita no meio da tela não encosta em nada", () => {
  assert.deepEqual(safeZoneIssues(box(0.25, 0.55, 0.75, 0.62)), []);
});

test("área segura: legenda no rodapé cai na descrição de todas as redes", () => {
  const issues = safeZoneIssues(box(0.25, 0.8, 0.75, 0.86));
  assert.deepEqual(issues.map((i) => i.id), ["reels", "tiktok", "shorts"]);
  assert.ok(issues.every((i) => i.sides.includes("bottom")));
});

test("área segura: linha larga só bate nos botões da metade de baixo", () => {
  const wide = box(0.07, 0.6, 0.93, 0.66); // 86% da largura, como o render limita
  assert.ok(safeZoneIssues(wide, ["reels"])[0].sides.includes("right"));
  assert.deepEqual(safeZoneIssues(box(0.07, 0.3, 0.93, 0.36), ["reels"]), []); // acima dos botões
});

test("área segura: o estilo padrão (até 87% da largura, no meio da tela) não é acusado", () => {
  assert.deepEqual(safeZoneIssues(box(0.13, 0.475, 0.87, 0.648)), []);
});

test("área segura: escolher a rede filtra; id desconhecido é ignorado", () => {
  const issues = safeZoneIssues(box(0.25, 0.74, 0.75, 0.8), ["reels", "nada"]); // TikTok também bateria
  assert.deepEqual(issues.map((i) => i.id), ["reels"]);
});

test("área segura: subir tira do rodapé, sem fugir para o terço de cima; sem espaço, null", () => {
  const low = box(0.25, 0.8, 0.75, 0.86);
  const up = liftIntoSafe(low, ["reels"]);
  assert.ok(Math.abs(low.bottom + up - (1 - SAFE_ZONES.reels.bottom)) < 1e-9);
  const moved = box(low.left, low.top + up, low.right, low.bottom + up);
  assert.deepEqual(safeZoneIssues(moved, ["reels"]), []);

  assert.equal(liftIntoSafe(box(0.07, 0.6, 0.93, 0.66), ["reels"]), 0); // larga: não é caso de subir
  assert.equal(liftIntoSafe(box(0.1, 0.02, 0.9, 0.98)), null);
  assert.equal(liftIntoSafe(box(0.25, 0.4, 0.75, 0.5)), 0);
});

test("área segura: larga demais para os botões encolhe até caber; acima deles, não mexe", () => {
  const wide = box(0.07, 0.6, 0.93, 0.66);
  const scale = shrinkIntoSafe(wide, ["shorts"]);
  assert.ok(scale < 1);
  const half = (0.93 - 0.5) * scale;
  assert.deepEqual(safeZoneIssues(box(0.5 - half, 0.6, 0.5 + half, 0.66), ["shorts"]), []);
  assert.equal(shrinkIntoSafe(box(0.07, 0.2, 0.93, 0.3), ["shorts"]), 1);
  assert.equal(shrinkIntoSafe(box(0.3, 0.6, 0.7, 0.66)), 1);
});
