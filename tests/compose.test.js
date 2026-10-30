const test = require("node:test");
const assert = require("node:assert/strict");
const { composeLines, keyLines } = require("../src/core/captions/compose.js");

function show(text) {
  const words = text.split(" ");
  return composeLines(words).map((l) => l.role + ":" + words.slice(l.from, l.to).join(" "));
}

test("composição monta as linhas como no modelo do Jota", () => {
  assert.deepEqual(show("Se gostou desse vídeo,"), ["lead:Se gostou", "main:desse", "accent:vídeo,"]);
  assert.deepEqual(show("Salva e envia"), ["main:Salva", "accent:e envia"]);
  assert.deepEqual(show("pro seu AMIGO."), ["lead:pro seu", "accent:AMIGO."]);
  assert.deepEqual(show("Me segue aí galera!"), ["lead:Me segue aí", "main:galera!"]);
  assert.deepEqual(show("Oi"), ["main:Oi"]);
});

test("composição cobre todas as palavras, em ordem e sem repetir", () => {
  for (const text of ["a b c d e f", "uma frase bem mais longa que o normal aqui", "de da do"]) {
    const words = text.split(" ");
    let next = 0;
    for (const line of composeLines(words)) {
      assert.equal(line.from, next);
      assert.ok(line.to > line.from);
      next = line.to;
    }
    assert.equal(next, words.length);
  }
});

test("Dourado elegante: o destaque grande, o que vem antes em cima e o resto embaixo", () => {
  const roles = (keys) => keyLines(keys).map((l) => l.role + ":" + l.from + "-" + l.to);
  assert.deepEqual(roles([false, true]), ["lead:0-1", "main:1-2"]); // "está / preparado"
  assert.deepEqual(roles([true, false, false]), ["main:0-1", "tail:1-3"]);
  assert.deepEqual(roles([false, true, true, false]), ["lead:0-1", "main:1-3", "tail:3-4"]);
  assert.deepEqual(roles([false, false]), ["lead:0-2"]); // sem destaque: a frase sozinha
  assert.deepEqual(keyLines([]), []);
});
