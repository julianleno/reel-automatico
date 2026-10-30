const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSegments } = require("../src/core/captions/segmenter.js");

const item = (index, startMs, endMs, text) => ({ index, startMs, endMs, text });

test("conversão básica para segundos e limpeza padrão", () => {
  const r = buildSegments([item(1, 1000, 2500, "<i>Olá</i>\nmundo")]);
  assert.equal(r.segments.length, 1);
  assert.equal(r.segments[0].inSeconds, 1);
  assert.equal(r.segments[0].outSeconds, 2.5);
  assert.equal(r.segments[0].text, "Olá mundo");
});

test("com 2 palavras por legenda, vírgula com uma palavra só não vira legenda sozinha", () => {
  // .srt do teste do fx-2 no Premiere: "1," ficava 100 ms na tela
  const r = buildSegments([item(1, 100, 1700, "Legenda número 1, ação e acentuação")], { maxWords: 2, minDurationMs: 200 });
  assert.deepEqual(r.segments.map((s) => s.text), ["Legenda número", "1, ação", "e acentuação"]);
});

test("fala rápida com 2 por legenda leva uma terceira palavra em vez de piscar", () => {
  const timed = (step) => ({ index: 1, startMs: 0, endMs: step * 6, text: "vende doce na rua todo dia",
    words: "vende doce na rua todo dia".split(" ").map((t, i) => ({ text: t, startMs: i * step, endMs: i * step + step - 10 })) });
  const fast = buildSegments([timed(120)], { maxWords: 2 }).segments.map((s) => s.words.length);
  const slow = buildSegments([timed(400)], { maxWords: 2 }).segments.map((s) => s.words.length);
  assert.ok(Math.max(...fast) === 3, "rápida " + fast + " / normal " + slow);
  assert.ok(slow.every((n) => n <= 2), "normal " + slow);
});

test("remove sobreposição com a próxima legenda e aplica gap", () => {
  const r = buildSegments([item(1, 0, 3000, "a"), item(2, 2000, 4000, "b")], { gapMs: 100 });
  assert.equal(r.segments[0].outSeconds, 1.9);
  assert.equal(r.segments[1].inSeconds, 2);
});

test("duração mínima é aplicada quando há espaço", () => {
  const r = buildSegments([item(1, 0, 50, "a"), item(2, 5000, 6000, "b")], { minDurationMs: 300 });
  assert.equal(r.segments[0].outSeconds, 0.3);
});

test("offset desloca e clampa em zero", () => {
  const r = buildSegments([item(1, 100, 1000, "a")], { offsetMs: -500 });
  assert.equal(r.segments[0].inSeconds, 0);
  assert.equal(r.segments[0].outSeconds, 0.5);
  assert.equal(r.warnings.length, 1);
});

test("maxChars divide proporcionalmente por palavras", () => {
  const r = buildSegments([item(1, 0, 4000, "um dois três quatro")], { maxChars: 11 });
  assert.equal(r.segments.length, 2);
  assert.equal(r.segments[0].text, "um dois");
  assert.equal(r.segments[1].text, "três quatro");
  assert.equal(r.segments[1].outSeconds, 4);
  assert.ok(r.segments[0].outSeconds > 0 && r.segments[0].outSeconds < 4);
});

test("uppercase e tags ASS", () => {
  const r = buildSegments([item(1, 0, 1000, "{\\an8}texto")], { uppercase: true });
  assert.equal(r.segments[0].text, "TEXTO");
});

test("joinLines=false preserva quebra", () => {
  const r = buildSegments([item(1, 0, 1000, "a\nb")], { joinLines: false });
  assert.equal(r.segments[0].text, "a\nb");
});

test("legenda vazia após limpeza é ignorada com aviso", () => {
  const r = buildSegments([item(1, 0, 1000, "<b></b>")]);
  assert.equal(r.segments.length, 0);
  assert.equal(r.warnings.length, 1);
});

test("maxWords limita o nº de palavras por legenda", () => {
  const r = buildSegments([item(1, 0, 3000, "um dois três quatro cinco")], { maxWords: 2 });
  assert.deepEqual(
    r.segments.map((s) => s.text),
    ["um dois", "três quatro", "cinco"],
  );
  assert.equal(r.segments[0].inSeconds, 0);
  assert.equal(r.segments[2].outSeconds, 3);
});

test("maxWords usa o tempo real das palavras quando a transcrição traz", () => {
  const words = [
    { text: "um", startMs: 0, endMs: 200 },
    { text: "dois", startMs: 300, endMs: 500 },
    { text: "três", startMs: 2000, endMs: 2300 },
    { text: "quatro", startMs: 2400, endMs: 2900 },
  ];
  const r = buildSegments([{ index: 1, startMs: 0, endMs: 3000, text: "um dois três quatro", words }], {
    maxWords: 2,
    uppercase: true,
  });
  assert.equal(r.segments.length, 2);
  assert.equal(r.segments[0].text, "UM DOIS");
  assert.equal(r.segments[0].outSeconds, 2);
  assert.equal(r.segments[1].inSeconds, 2);
  assert.equal(r.segments[1].outSeconds, 3);
});

test("maxWords e maxChars combinados", () => {
  const r = buildSegments([item(1, 0, 4000, "a b extraordinariamente c")], { maxWords: 3, maxChars: 10 });
  assert.deepEqual(
    r.segments.map((s) => s.text),
    ["a b", "extraordinariamente", "c"],
  );
});

test("clipToRange mantém as legendas que começam no trecho e corta no Out", () => {
  const { clipToRange } = require("../src/core/captions/segmenter.js");
  const seg = (id, a, b, words) => ({ id, inSeconds: a, outSeconds: b, text: words.map((w) => w[0]).join(" "), words: words.map(([text, i, o]) => ({ text, inSeconds: i, outSeconds: o })) });
  const segments = [
    seg("1", 0, 1, [["antes", 0, 1]]),
    seg("2", 2, 4, [["dentro", 2, 3], ["fora", 3.5, 4]]),
    seg("3", 5, 6, [["depois", 5, 6]]),
  ];
  const out = clipToRange(segments, 1.5, 3.2);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "2");
  assert.equal(out[0].outSeconds, 3.2);
  assert.deepEqual(out[0].words.map((w) => w.text), ["dentro"]);
  assert.equal(out[0].text, "dentro");
  assert.equal(clipToRange(segments, 0, 100).length, 3);
});

test("maxLines: maxChars vale por linha e a legenda leva até maxLines linhas", () => {
  const text = "um dois tres quatro cinco seis";
  const one = buildSegments([item(1, 0, 6000, text)], { maxChars: 12, maxLines: 1 });
  assert.deepEqual(one.segments.map((s) => s.text), ["um dois tres", "quatro cinco", "seis"]);
  const two = buildSegments([item(1, 0, 6000, text)], { maxChars: 12, maxLines: 2 });
  assert.deepEqual(two.segments.map((s) => s.text), ["um dois tres quatro", "cinco seis"]);
});

test("maxDurationMs encurta a legenda que sobra na tela sem cortar a última palavra", () => {
  const words = [
    { text: "oi", startMs: 0, endMs: 300 },
    { text: "gente", startMs: 300, endMs: 600 },
  ];
  const r = buildSegments([{ index: 1, startMs: 0, endMs: 9000, text: "oi gente", words }], { maxDurationMs: 2000 });
  assert.equal(r.segments[0].outSeconds, 2);
  assert.equal(r.segments[0].words[1].outSeconds, 2);
  assert.equal(r.segments[0].words[1].inSeconds, 0.3);
  // palavra que começa depois do limite continua visível por 300 ms
  const late = buildSegments([{ index: 1, startMs: 0, endMs: 9000, text: "oi gente", words: [words[0], { text: "gente", startMs: 5000, endMs: 5400 }] }], { maxDurationMs: 2000 });
  assert.equal(late.segments[0].outSeconds, 5.3);
});

test("quebra natural: legenda não termina em artigo ou preposição", () => {
  const texts = (text, opt) => buildSegments([item(1, 0, 6000, text)], opt).segments.map((s) => s.text);
  // "vi" sozinho na tela lê pior: a legenda leva uma palavra a mais
  assert.deepEqual(texts("vi a casa azul", { maxWords: 2 }), ["vi a casa", "azul"]);
  assert.deepEqual(texts("eu vou para a praia hoje", { maxWords: 3 }), ["eu vou", "para a praia", "hoje"]);
  // palavra fraca sozinha não some nem trava
  assert.deepEqual(texts("de", { maxWords: 1 }), ["de"]);
});

test("quebra natural: pontuação fecha a legenda", () => {
  const texts = (text, opt) => buildSegments([item(1, 0, 8000, text)], opt).segments.map((s) => s.text);
  assert.deepEqual(texts("aqui no Bom Jardim. Se você desejar conhecer", { maxWords: 4 }), ["aqui no Bom Jardim.", "Se você desejar conhecer"]);
  // vírgula só fecha se a legenda já tem metade do tamanho
  assert.deepEqual(texts("Boa tarde, eu sou Mariana", { maxWords: 4 }), ["Boa tarde,", "eu sou Mariana"]);
  assert.deepEqual(texts("Sim, eu sou Mariana hoje", { maxWords: 4 }), ["Sim, eu sou Mariana", "hoje"]);
});

test("quebra natural: pausa da fala fecha a legenda", () => {
  const words = [
    { text: "olha", startMs: 0, endMs: 300 },
    { text: "só", startMs: 300, endMs: 500 },
    { text: "isso", startMs: 1200, endMs: 1500 }, // 700 ms de pausa antes
    { text: "aqui", startMs: 1500, endMs: 1800 },
  ];
  const r = buildSegments([{ index: 1, startMs: 0, endMs: 1800, text: "olha só isso aqui", words }], { maxWords: 3 });
  assert.deepEqual(r.segments.map((s) => s.text), ["olha só", "isso aqui"]);
  assert.equal(r.segments[1].inSeconds, 1.2);
});

test("quebra natural: nome próprio no meio da frase não se divide", () => {
  const texts = (text, opt) => buildSegments([item(1, 0, 8000, text)], opt).segments.map((s) => s.text);
  assert.deepEqual(texts("acontecendo no Bom Jardim hoje", { maxWords: 2 }), ["acontecendo", "no Bom Jardim", "hoje"]);
  assert.deepEqual(texts("na rua Coronel João Correia, 579", { maxWords: 2 }), ["na rua", "Coronel João Correia,", "579"]);
});

test("moveSegment: leva o bloco para a nova posição e corrige o texto", () => {
  const { moveSegment } = require("../src/core/captions/segmenter.js");
  const seg = {
    id: "1-1", inSeconds: 2, outSeconds: 4, text: "ola mundo",
    words: [{ text: "ola", inSeconds: 2, outSeconds: 3 }, { text: "mundo", inSeconds: 3, outSeconds: 4 }],
  };
  const moved = moveSegment(seg, 10);
  assert.deepEqual([moved.inSeconds, moved.outSeconds, moved.text], [10, 12, "ola mundo"]);
  assert.deepEqual(moved.words.map((w) => [w.inSeconds, w.outSeconds]), [[10, 11], [11, 12]]);
  assert.equal(seg.words[0].inSeconds, 2, "não altera o original");

  const same = moveSegment(seg, 2, "Olá Mundo");
  assert.deepEqual(same.words, [{ text: "Olá", inSeconds: 2, outSeconds: 3 }, { text: "Mundo", inSeconds: 3, outSeconds: 4 }]);

  const more = moveSegment(seg, 0, "olá  meu mundo");
  assert.equal(more.text, "olá meu mundo");
  assert.deepEqual(more.words.map((w) => w.text), ["olá", "meu", "mundo"]);
  assert.ok(Math.abs(more.words[1].inSeconds - 2 / 3) < 1e-9 && more.words[2].outSeconds === 2);
});

test("moveSegment: com fim, o bloco ocupa exatamente o clipe aparado", () => {
  const { moveSegment } = require("../src/core/captions/segmenter.js");
  const seg = {
    id: "1", inSeconds: 0, outSeconds: 2, text: "a b",
    words: [{ text: "a", inSeconds: 0, outSeconds: 1 }, { text: "b", inSeconds: 1, outSeconds: 2 }],
  };
  const m = moveSegment(seg, 5, undefined, 5.5);
  assert.deepEqual([m.inSeconds, m.outSeconds], [5, 5.5]);
  assert.deepEqual(m.words.map((w) => [w.inSeconds, w.outSeconds]), [[5, 5.5], [5.5, 5.5]]);
});

test("cortes de câmera: nenhuma legenda atravessa um corte", () => {
  const words = [
    { text: "antes", startMs: 0, endMs: 400 },
    { text: "do", startMs: 400, endMs: 700 },
    { text: "corte", startMs: 950, endMs: 1300 },
    { text: "depois", startMs: 1300, endMs: 1800 },
  ];
  const { segments } = buildSegments([{ index: 1, startMs: 0, endMs: 1800, text: "antes do corte depois", words }], { cutsMs: [1000] });
  assert.deepEqual(segments.map((s) => [s.inSeconds, s.outSeconds, s.text]), [
    [0, 1, "antes do"],
    [1, 1.8, "corte depois"],
  ]);
  // a duração mínima não estica a legenda por cima do corte
  const short = buildSegments([item(1, 0, 100, "oi")], { cutsMs: [150], minDurationMs: 500 }).segments;
  assert.equal(short[0].outSeconds, 0.15);
});

test("legenda de menos de um quadro, espremida pela seguinte, não entra (cairia em cima dela)", () => {
  const r = buildSegments([item(1, 28400, 28420, "sobra"), item(2, 28420, 28930, "seguinte")], { minDurationMs: 200 });
  assert.deepEqual(r.segments.map((s) => s.text), ["seguinte"]);
});

test("legenda que ficaria menos de 0,4 s junta com a vizinha da mesma frase (com uma palavra a mais)", () => {
  const timed = (list) => ({ index: 1, startMs: list[0][1], endMs: list[list.length - 1][2], text: list.map((x) => x[0]).join(" "), words: list.map(([text, startMs, endMs]) => ({ text, startMs, endMs })) });
  const texts = (list) => buildSegments([timed(list)], { maxWords: 4, maxLines: 2 }).segments.map((s) => s.text);
  // 2.MOV aos 55 s: "novamente." ficava 297 ms sozinha; fim de frase junta para trás
  assert.deepEqual(texts([["e", 53000, 54830], ["ela", 54830, 54880], ["voltou", 54880, 54970], ["vazia", 54970, 55040], ["novamente.", 55040, 55340]]), ["e ela voltou vazia novamente."]);
  // Jota: "não" (270 ms) junta para frente com "fecha."
  assert.deepEqual(texts([["do", 2120, 2250], ["mês", 2250, 2470], ["a", 2470, 2560], ["conta", 2560, 3000], ["não", 3000, 3270], ["fecha.", 3270, 3730]]), ["do mês a conta", "não fecha."]);
  // não passa de um fim de frase nem de uma palavra a mais: fica como está (0,35 s)
  assert.deepEqual(texts([["A", 4230, 4520], ["palavra", 4520, 5030], ["é", 5030, 5140], ["passagem.", 5140, 6490], ["Tem", 6490, 6580], ["uma", 6580, 6670], ["palavra", 6670, 6840], ["que", 6840, 7040], ["é", 7040, 7090], ["ruim", 7090, 7360]]),
    ["A palavra é passagem.", "Tem uma palavra", "que é ruim"]);
});
