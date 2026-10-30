// scripts/reel-check.js: as palavras ouvidas que não chegaram à legenda, na ordem (LCS)
const test = require("node:test");
const assert = require("node:assert/strict");
const { missing } = require("../scripts/reel-check.js");

test("conferência do Reel: acha a palavra que sumiu da legenda, mesmo com a frase repetida", () => {
  const said = "uma aliada da sua performance é uma aliada".split(" ").map((text, i) => ({ text, startMs: i * 500 }));
  const caption = "uma da sua performance é uma aliada".split(" ");
  assert.deepEqual(missing(said, caption).map((w) => w.text + "@" + w.startMs), ["aliada@500"], "a 1ª aliada, não a 2ª");
  assert.deepEqual(missing(said, said.map((w) => w.text)), []);
  assert.equal(missing(said, []).length, said.length);
});

test("conferência do Reel: conta por palavra (frase regravada não engana; cada cortada explica uma só)", () => {
  const { lostWords } = require("../scripts/reel-check.js");
  const heard = "é fazer bem é fazer bem e corrigir é essencial".split(" ").map((text, i) => ({ text, startMs: i * 1000 }));
  // a 1ª tomada saiu como retake ("é fazer bem"); a legenda tem a 2ª: nada perdido, mesmo com o LCS casando a 1ª
  assert.equal(lostWords(heard, "é fazer bem e corrigir é essencial".split(" "), ["é", "fazer", "bem"]).length, 0);
  // o "é" de "corrigir é essencial" sumiu: um "é" cortado (o do retake) não explica os dois
  assert.deepEqual(lostWords(heard, "é fazer bem e corrigir essencial".split(" "), ["é", "fazer", "bem"]).map((w) => w.text), ["é"]);
});
