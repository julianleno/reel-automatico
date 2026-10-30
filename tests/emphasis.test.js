const test = require("node:test");
const assert = require("node:assert/strict");
const { decorateSegments, zoomMoments } = require("../src/core/captions/emphasis.js");

const seg = (inSeconds, text) => ({ inSeconds, outSeconds: inSeconds + 1, text, words: text.split(" ").map((t) => ({ text: t })) });
const keys = (s) => s.words.filter((w) => w.key).map((w) => w.text);

test("destaque: números, nomes no meio da frase e ênfase; começo de frase não", () => {
  const out = decorateSegments([seg(0, "Hoje o João ganhou R$ 50"), seg(1, "e 30% de desconto."), seg(2, "Nunca vi isso no Bom Jardim")]);
  assert.deepEqual(keys(out[0]), ["João", "R$", "50"]);
  assert.deepEqual(keys(out[1]), ["30%"]);
  // "Nunca" começa frase (depois do ponto), mas é palavra de ênfase; "Bom Jardim" é nome
  assert.deepEqual(keys(out[2]), ["Nunca", "Bom", "Jardim"]);
  // não altera os segmentos originais
  assert.equal("key" in seg(0, "x").words[0], false);
});

test("emoji: um por legenda pelo dicionário, com intervalo mínimo e só se ligado", () => {
  const segs = [seg(0, "quero ganhar dinheiro"), seg(1, "com muito amor"), seg(4, "num grupo de oração"), seg(5, "sem nada")];
  assert.deepEqual(decorateSegments(segs).map((s) => s.emoji), ["", "", "", ""]);
  const out = decorateSegments(segs, { emojis: true });
  assert.deepEqual(out.map((s) => s.emoji), ["💰", "", "👥", ""]);
});

test("zoom: primeira palavra de destaque por legenda, espaçado, saindo no fim da legenda", () => {
  const seg = (inSeconds, outSeconds, words) => ({
    inSeconds, outSeconds, text: words.join(" "),
    words: words.map((text, i) => ({ text, inSeconds: inSeconds + i * 0.3, outSeconds: inSeconds + (i + 1) * 0.3 })),
  });
  const moments = zoomMoments([
    seg(0, 1.2, ["isso", "é", "grátis", "nunca"]), // grátis em 0,6; nunca na mesma legenda não conta
    seg(2, 3, ["custa", "R$", "50"]), // perto demais do anterior
    seg(5, 9, ["o", "segredo", "é"]), // segura no máximo 2 s
    seg(8, 8.2, ["agora"]), // perto demais
    seg(12, 12.2, ["agora"]), // legenda curta: fica pelo menos 0,6 s
  ], { gapSeconds: 3 });
  assert.deepEqual(moments.map((m) => [+m.inSeconds.toFixed(2), +m.outSeconds.toFixed(2)]), [[0.6, 1.2], [5.3, 7.3], [12, 12.6]]);
});

test("keys de fora (IA) substituem as regras, contando as palavras de todos os segmentos", () => {
  const segs = [
    { id: "1", inSeconds: 0, outSeconds: 1, words: [{ text: "Ganhei", inSeconds: 0 }, { text: "500", inSeconds: 0.5 }] },
    { id: "2", inSeconds: 1, outSeconds: 3, words: [{ text: "reais", inSeconds: 1 }, { text: "hoje", inSeconds: 2 }] },
  ];
  const out = decorateSegments(segs, { keys: [3] });
  assert.deepEqual(out.flatMap((s) => s.words.map((w) => w.key)), [false, false, false, true]);
  assert.deepEqual(zoomMoments(segs, { keys: [3] }).map((m) => m.inSeconds), [2]);
  // sem keys continuam as regras: "500" é número
  assert.equal(decorateSegments(segs)[0].words[1].key, true);
});

test("zoomLayers suave: camadas encostadas, alterna aproximar e afastar e termina afastado", () => {
  const { zoomLayers } = require("../src/core/captions/emphasis.js");
  const m = [{ inSeconds: 2, outSeconds: 4 }, { inSeconds: 8, outSeconds: 9 }, { inSeconds: 15, outSeconds: 16 }];
  const L = zoomLayers(m, { smooth: true, scale: 130, endSeconds: 60 });
  assert.deepEqual(L.map((l) => [l.inSeconds, l.outSeconds]), [[2, 8], [8, 15], [15, 17.5], [17.5, 19.5]]);
  assert.deepEqual(L[0].keys, [{ seconds: 0, value: 100 }, { seconds: 2, value: 130 }]);
  assert.deepEqual(L[1].keys, [{ seconds: 0, value: 130 }, { seconds: 2, value: 100 }]);
  assert.equal(L[3].keys[L[3].keys.length - 1].value, 100);
  // o fim da sequência corta a última
  const cut = zoomLayers([{ inSeconds: 2, outSeconds: 4 }], { smooth: true, scale: 120, endSeconds: 3 });
  assert.deepEqual(cut.map((l) => [l.inSeconds, l.outSeconds]), [[2, 3]]);
  assert.deepEqual(cut[0].keys, [{ seconds: 0, value: 100 }, { seconds: 1, value: 120 }]);
});

test("zoomLayers rápido: uma camada por momento, entra e sai em 0,3 s", () => {
  const { zoomLayers } = require("../src/core/captions/emphasis.js");
  const L = zoomLayers([{ inSeconds: 5, outSeconds: 7 }], { smooth: false, scale: 120 });
  assert.deepEqual(L, [{ inSeconds: 5, outSeconds: 7, keys: [{ seconds: 0, value: 100 }, { seconds: 0.3, value: 120 }, { seconds: 1.7, value: 120 }, { seconds: 2, value: 100 }] }]);
});
