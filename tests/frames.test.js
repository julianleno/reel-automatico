const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSegments } = require("../src/core/captions/segmenter.js");
const { buildFrames, layoutWords } = require("../src/core/captions/frames.js");

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

test("segmentos trazem as palavras com tempo proporcional quando não há tempo real", () => {
  const r = buildSegments([{ index: 1, startMs: 0, endMs: 1000, text: "ab cdef" }]);
  const words = r.segments[0].words;
  assert.deepEqual(
    words.map((w) => w.text),
    ["ab", "cdef"],
  );
  near(words[0].inSeconds, 0);
  near(words[0].outSeconds, 2 / 6);
  near(words[1].inSeconds, 2 / 6);
  near(words[1].outSeconds, 1);
});

test("segmentos usam o tempo real das palavras e acompanham offset", () => {
  const item = {
    index: 1,
    startMs: 1000,
    endMs: 3000,
    text: "um dois",
    words: [
      { text: "um", startMs: 1000, endMs: 1400 },
      { text: "dois", startMs: 2500, endMs: 3000 },
    ],
  };
  const words = buildSegments([item], { offsetMs: 500 }).segments[0].words;
  near(words[0].inSeconds, 1.5);
  near(words[1].inSeconds, 3);
  near(words[1].outSeconds, 3.5);
});

test("buildFrames sem destaque: um quadro por legenda", () => {
  const { segments } = buildSegments([{ index: 1, startMs: 0, endMs: 1000, text: "a b c" }]);
  const frames = buildFrames(segments, { highlight: false });
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0].words, ["a", "b", "c"]);
  assert.equal(frames[0].active, -1);
});

test("buildFrames com destaque: um quadro por palavra, contínuos e sem buracos", () => {
  const { segments } = buildSegments([{ index: 1, startMs: 0, endMs: 3000, text: "aaa bbb ccc" }]);
  const frames = buildFrames(segments, { highlight: true });
  assert.deepEqual(
    frames.map((f) => f.active),
    [0, 1, 2],
  );
  near(frames[0].inSeconds, 0);
  near(frames[0].outSeconds, frames[1].inSeconds);
  near(frames[1].outSeconds, frames[2].inSeconds);
  near(frames[2].outSeconds, 3);
  assert.equal(new Set(frames.map((f) => f.id)).size, 3);
});

test("buildFrames: palavra curta demais cede o tempo à vizinha", () => {
  const segments = [
    {
      id: "1-1",
      inSeconds: 0,
      outSeconds: 1,
      text: "a b c",
      words: [
        { text: "a", inSeconds: 0, outSeconds: 0.01 },
        { text: "b", inSeconds: 0.01, outSeconds: 0.5 },
        { text: "c", inSeconds: 0.5, outSeconds: 0.51 },
      ],
    },
    { id: "2-2", inSeconds: 2, outSeconds: 2.02, text: "x y", words: [
      { text: "x", inSeconds: 2, outSeconds: 2.01 },
      { text: "y", inSeconds: 2.01, outSeconds: 2.02 },
    ] },
  ];
  const frames = buildFrames(segments, { highlight: true });
  assert.equal(frames.length, 2);
  assert.equal(frames[0].active, 1);
  near(frames[0].inSeconds, 0);
  near(frames[0].outSeconds, 0.51);
  near(frames[1].inSeconds, 2);
  near(frames[1].outSeconds, 2.02);
});

test("layoutWords quebra em linhas pela largura", () => {
  const measure = (t) => t.length * 10;
  const one = layoutWords(["aa", "bbb"], measure, { maxWidth: 100 });
  assert.equal(one.lines.length, 1);
  assert.deepEqual(one.lines[0].words.map((w) => w.x), [0, 30]);
  assert.equal(one.width, 60);

  const two = layoutWords(["aaaa", "bbbb", "cc"], measure, { maxWidth: 90 });
  assert.deepEqual(
    two.lines.map((l) => l.words.map((w) => w.text)),
    [["aaaa", "bbbb"], ["cc"]],
  );
  assert.equal(two.width, 90);
  assert.equal(two.lines[1].words[0].index, 2);

  // palavra maior que a linha fica sozinha, sem linha vazia
  const big = layoutWords(["aaaaaaaaaaaa", "b"], measure, { maxWidth: 50 });
  assert.equal(big.lines.length, 2);
});

test("layoutWords respeita caracteres por linha e equilibra duas linhas", () => {
  const measure = (t) => t.length * 10;
  const chars = layoutWords(["um", "dois", "tres", "quatro"], measure, { maxChars: 8 });
  assert.deepEqual(chars.lines.map((l) => l.words.map((w) => w.text)), [["um", "dois"], ["tres"], ["quatro"]]);
  // sem equilíbrio: "uma palavra numa linha e o resto na outra"
  const words = ["a", "bb", "cc", "dd", "ee"];
  assert.deepEqual(layoutWords(words, measure, { maxWidth: 110 }).lines.map((l) => l.words.length), [4, 1]);
  const even = layoutWords(words, measure, { maxWidth: 110, balance: true });
  assert.deepEqual(even.lines.map((l) => l.words.length), [3, 2]);
  assert.equal(even.lines[1].words[0].x, 0);
});
