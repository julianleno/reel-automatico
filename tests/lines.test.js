const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../src/core/captions/lines.js");
const { buildSegments } = require("../src/core/captions/segmenter.js");

const line = {
  id: "1",
  inSeconds: 1,
  outSeconds: 2,
  text: "eu vou tomar um",
  words: [
    { text: "eu", inSeconds: 1, outSeconds: 1.2 },
    { text: "vou", inSeconds: 1.2, outSeconds: 1.5 },
    { text: "tomar", inSeconds: 1.5, outSeconds: 1.8 },
    { text: "um", inSeconds: 1.8, outSeconds: 2 },
  ],
};

test("timecode como no Premiere, ida e volta", () => {
  assert.equal(L.formatFrames(86 + 23 / 24, 24), "00:01:26:23");
  assert.equal(L.parseTimecode("00:01:26:23", 24), 86 + 23 / 24);
  assert.equal(L.parseTimecode("1:26,5", 24), 86.5);
  assert.equal(L.parseTimecode("86.2", 24), 86.2);
  assert.ok(Number.isNaN(L.parseTimecode("1:2x", 24)));
});

test("texto: mesmo nº de palavras mantém os tempos; outro nº reparte", () => {
  const same = L.setLineText(line, "eu vou tomar uns");
  assert.deepEqual(same.words.map((w) => w.inSeconds), [1, 1.2, 1.5, 1.8]);
  assert.equal(same.text, "eu vou tomar uns");
  const fewer = L.setLineText(line, "vou tomar");
  assert.deepEqual(fewer.words.map((w) => [w.inSeconds, w.outSeconds]), [[1, 1.5], [1.5, 2]]);
  assert.equal(L.setLineText(line, "   "), null);
});

test("tempos: as palavras acompanham na mesma proporção", () => {
  const moved = L.setLineTimes(line, 3, 5);
  assert.deepEqual(moved.words.map((w) => Number(w.inSeconds.toFixed(3))), [3, 3.4, 4, 4.6]);
  assert.equal(moved.words[3].outSeconds, 5);
});

test("dividir e juntar", () => {
  const [a, b] = L.splitLine(line, 2);
  assert.equal(a.text, "eu vou");
  assert.equal(b.text, "tomar um");
  assert.equal(a.outSeconds, 1.5);
  assert.equal(b.inSeconds, 1.5);
  assert.equal(L.splitLine(line, 0), null);
  const back = L.mergeLines(a, b);
  assert.equal(back.text, line.text);
  assert.equal(back.outSeconds, 2);
});

test("linha arrumada à mão não é dividida de novo pelo segmentador", () => {
  const items = L.linesToItems([line], 100);
  assert.equal(items[0].startMs, 900, "tira o deslocamento que já estava somado");
  const segs = buildSegments(items, { maxWords: 2, offsetMs: 100 }).segments;
  assert.equal(segs.length, 1);
  assert.equal(segs[0].text, "eu vou tomar um");
  assert.equal(segs[0].inSeconds, 1);
});

test("destaque escolhido à mão vale mais que a IA e as regras, até o desenho", () => {
  const { decorateSegments } = require("../src/core/captions/emphasis.js");
  const marked = L.setLineKey(line, 2); // "tomar"
  const other = L.setLineKey({ ...line, id: "2", inSeconds: 2, outSeconds: 3, words: line.words.map((w) => ({ ...w, inSeconds: w.inSeconds + 1, outSeconds: w.outSeconds + 1 })) }, -1);
  const segs = buildSegments(L.linesToItems([marked, other], 0), { maxWords: 2 }).segments;
  assert.equal(segs.length, 2);
  // a IA tinha escolhido a 1ª palavra das duas linhas: o editor manda
  const out = decorateSegments(segs, { keys: [0, 4] });
  assert.deepEqual(out[0].words.map((w) => w.key), [false, false, true, false]);
  assert.deepEqual(out[1].words.map((w) => w.key), [false, false, false, false]);
  // dividir mantém a escolha na parte em que a palavra ficou
  const [a, b] = L.splitLine(marked, 2);
  assert.equal(b.words[0].manualKey, true);
  assert.equal(a.keyManual, true);
});

test("editar uma linha não apaga a fala baixa (quiet) nem o tempo estimado das palavras", () => {
  // como no painel: transcrição -> linhas do editor -> edição -> linesToItems -> aba Cortes (keepQuietWords)
  const said = ["oi", "gente", "tudo", "certo", "galera", "beleza"];
  const words = said.map((text, i) => ({ text, startMs: i * 400, endMs: i * 400 + 350 }));
  words[1].quiet = true;
  words[2].estimated = true;
  words[5].quiet = true;
  const items = [{ index: 1, startMs: 0, endMs: 2400, text: said.join(" "), words }];
  const opts = { maxWords: 3, wordMarks: true };
  const marks = (list) => list.flatMap((it) => it.words).map((w) => (w.quiet ? "q" : "") + (w.estimated ? "e" : ""));

  let lines = buildSegments(items, opts).segments;
  assert.equal(lines.length, 2);
  // mexe só na 2ª linha, com o mesmo nº de palavras (a palavra trocada é a mesma fala, no mesmo tempo)
  let after = L.linesToItems([lines[0], L.setLineText(lines[1], "certo galera blz")], 0);
  assert.deepEqual(marks(after), ["", "q", "e", "", "", "q"]);
  // a linha travada volta ao editor e passa por juntar, dividir e mudar o tempo
  lines = buildSegments(after, opts).segments;
  const [a, b] = L.splitLine(L.mergeLines(lines[0], lines[1]), 2);
  after = L.linesToItems([a, L.setLineTimes(b, 1, 2.6)], 0);
  assert.deepEqual(marks(after), ["", "q", "e", "", "", "q"]);
  // outro nº de palavras: tempos repartidos; fica baixa a palavra nova cujo meio cai numa palavra baixa
  lines = buildSegments(after, opts).segments;
  assert.deepEqual(marks([L.setLineText(lines[1], "tudo certo pessoal galera blz")]), ["", "", "", "", "q"]);
  // sem pedir (app sem Premiere, timeline), o segmentador sai igual: palavras sem as marcas
  assert.deepEqual(marks(buildSegments(items, { maxWords: 3 }).segments), ["", "", "", "", "", ""]);
});
