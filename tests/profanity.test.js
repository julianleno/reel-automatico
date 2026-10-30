const test = require("node:test");
const assert = require("node:assert/strict");
const { isProfane, findProfanity, censorWord, censorSegments } = require("../src/core/captions/profanity.js");

test("palavrão: inteiro, variações e maiúsculas; palavras inocentes ficam", () => {
  for (const w of ["porra,", "Caralho!", "merdinha", "FODA", "fodendo", "pqp", "cu.", "Desgraçado"]) assert.ok(isProfane(w), w);
  for (const w of ["cultura", "computador", "putz", "pinto", "porrada", "fodder", "merecer", "custo", "puxa", ""]) assert.equal(isProfane(w), false, w);
});

test("censurar: primeira e última letra, pontuação intacta", () => {
  assert.equal(censorWord("porra,"), "p***a,");
  assert.equal(censorWord("Caralho!"), "C*****o!");
  assert.equal(censorWord("cu."), "c*.");
  assert.equal(censorWord("\"merda\""), "\"m***a\"");
});

test("palavrões na fala com o tempo, e segmentos censurados sem mexer nos outros", () => {
  const words = [
    { text: "Que", startMs: 0, endMs: 200 },
    { text: "porra", startMs: 200, endMs: 600 },
    { text: "é", startMs: 600, endMs: 700 },
    { text: "essa?", startMs: 700, endMs: 1000 },
  ];
  assert.deepEqual(findProfanity(words), [{ index: 1, text: "porra", startMs: 200, endMs: 600 }]);
  const segs = [
    { id: "1", text: "Que porra é essa?", words: [{ text: "Que" }, { text: "porra" }, { text: "é" }, { text: "essa?" }] },
    { id: "2", text: "Tudo certo.", words: [{ text: "Tudo" }, { text: "certo." }] },
  ];
  const out = censorSegments(segs);
  assert.equal(out[0].text, "Que p***a é essa?");
  assert.equal(out[0].words[1].text, "p***a");
  assert.equal(segs[0].words[1].text, "porra", "o original não muda");
  assert.equal(out[1], segs[1]);
});
