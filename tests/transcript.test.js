const test = require("node:test");
const assert = require("node:assert/strict");
const { parseTranscript, itemsFromText, followCuts } = require("../src/core/captions/transcript.js");

test("formato whisper: segments com words em segundos", () => {
  const json = JSON.stringify({
    segments: [
      {
        start: 0.5,
        end: 2.0,
        text: " Olá mundo",
        words: [
          { word: " Olá", start: 0.5, end: 0.9 },
          { word: " mundo", start: 1.0, end: 2.0 },
        ],
      },
    ],
  });
  const r = parseTranscript(json);
  assert.equal(r.errors.length, 0);
  assert.equal(r.items.length, 1);
  assert.deepEqual(r.items[0], {
    index: 1,
    startMs: 500,
    endMs: 2000,
    text: "Olá mundo",
    words: [
      { text: "Olá", startMs: 500, endMs: 900 },
      { text: "mundo", startMs: 1000, endMs: 2000 },
    ],
  });
});

test("segments sem words recebem as words do topo por tempo", () => {
  const r = parseTranscript(
    JSON.stringify({
      segments: [
        { start: 0, end: 1, text: "a b" },
        { start: 1, end: 2, text: "c" },
      ],
      words: [
        { word: "a", start: 0, end: 0.4 },
        { word: "b", start: 0.5, end: 0.9 },
        { word: "c", start: 1.1, end: 1.8 },
      ],
    }),
  );
  assert.equal(r.items[0].words.length, 2);
  assert.equal(r.items[1].words[0].text, "c");
});

test("só words: quebra em pontuação e em pausa longa", () => {
  const r = parseTranscript(
    JSON.stringify({
      words: [
        { word: "Oi.", start: 0, end: 0.3 },
        { word: "Tudo", start: 0.4, end: 0.6 },
        { word: "bem", start: 0.7, end: 0.9 },
        { word: "depois", start: 3, end: 3.5 },
      ],
    }),
  );
  assert.deepEqual(
    r.items.map((i) => i.text),
    ["Oi.", "Tudo bem", "depois"],
  );
});

test("whisper.cpp: transcription com offsets em ms", () => {
  const r = parseTranscript(
    JSON.stringify({ transcription: [{ offsets: { from: 1000, to: 2500 }, text: " teste" }] }),
  );
  assert.equal(r.items[0].startMs, 1000);
  assert.equal(r.items[0].endMs, 2500);
  assert.equal(r.items[0].text, "teste");
});

test("lista simples e BOM", () => {
  const r = parseTranscript(String.fromCharCode(0xfeff) + JSON.stringify([{ start: 1, end: 2, text: "x" }]));
  assert.equal(r.items.length, 1);
});

test("erros: JSON inválido, formato desconhecido, segmento inválido", () => {
  assert.equal(parseTranscript("{").errors.length, 1);
  assert.equal(parseTranscript('{"foo":1}').errors.length, 1);
  const r = parseTranscript(
    JSON.stringify({
      segments: [
        { start: 2, end: 1, text: "x" },
        { start: 0, end: 1, text: "" },
      ],
    }),
  );
  assert.equal(r.items.length, 0);
  assert.equal(r.errors.length, 2);
});

test("frase longa é dividida, mas não depois de preposição nem no meio de nome", () => {
  const { itemsFromWords } = require("../src/core/captions/transcript.js");
  const text = "nós estamos aqui hoje com todo mundo junto para falar um pouco sobre o Bom Jardim agora";
  let t = 0;
  const words = text.split(" ").map((w) => ({ text: w, startMs: (t += 300) - 300, endMs: t }));
  const items = itemsFromWords(words);
  assert.ok(items.length > 1);
  for (const it of items.slice(0, -1)) assert.doesNotMatch(it.text, /( o| Bom)$/);
});

test("palavra sozinha com 0 ms entre pausas não some da legenda (fica até 300 ms, sem chegar na próxima)", () => {
  const { itemsFromWords } = require("../src/core/captions/transcript.js");
  const items = itemsFromWords([{ text: "oi.", startMs: 0, endMs: 300 }, { text: "vale", startMs: 2000, endMs: 2000 }, { text: "tudo", startMs: 2150, endMs: 2400 }]);
  assert.deepEqual(items.map((i) => [i.text, i.startMs, i.endMs]), [["oi.", 0, 300], ["vale tudo", 2000, 2400]]);
  const alone = itemsFromWords([{ text: "oi.", startMs: 0, endMs: 300 }, { text: "vale", startMs: 2000, endMs: 2000 }, { text: "tudo", startMs: 4000, endMs: 4300 }]);
  assert.deepEqual(alone.map((i) => [i.text, i.startMs, i.endMs]), [["oi.", 0, 300], ["vale", 2000, 2300], ["tudo", 4000, 4300]]);
});

test("texto digitado: uma linha por texto, em sequência, palavras no ritmo de fala", () => {
  const items = itemsFromText("Salva e envia\n\n  pro seu AMIGO  \r\n", 10000, 3000);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => [i.index, i.startMs, i.endMs, i.text]), [
    [1, 10000, 13000, "Salva e envia"],
    [2, 13000, 16000, "pro seu AMIGO"],
  ]);
  assert.deepEqual(items[0].words, [
    { text: "Salva", startMs: 10000, endMs: 10350 },
    { text: "e", startMs: 10350, endMs: 10700 },
    { text: "envia", startMs: 10700, endMs: 13000 },
  ]);
  assert.deepEqual(itemsFromText("   \n", 0, 3000), []);
});

test("legendas seguem os cortes: palavra cortada sai, o resto volta no tempo", () => {
  const w = (text, startMs, endMs) => ({ text, startMs, endMs });
  const items = [
    { index: 1, startMs: 0, endMs: 2000, text: "eu eu fui lá", words: [w("eu", 0, 300), w("eu", 1000, 1300), w("fui", 1300, 1600), w("lá", 1600, 2000)] },
    { index: 2, startMs: 5000, endMs: 6000, text: "tchau", words: [w("tchau", 5000, 6000)] },
    { index: 3, startMs: 2100, endMs: 2400, text: "sumiu", words: [w("sumiu", 2100, 2400)] },
  ];
  // tira o retake [0, 1000) e o silêncio [2000, 5000), que engole "sumiu"
  const out = followCuts(items, [{ startMs: 0, endMs: 1000 }, { startMs: 2000, endMs: 5000 }]);
  assert.deepEqual(out.map((i) => [i.index, i.startMs, i.endMs, i.text]), [
    [1, 0, 1000, "eu fui lá"],
    [2, 1000, 2000, "tchau"],
  ]);
  assert.deepEqual(out[0].words[0], { text: "eu", startMs: 0, endMs: 300 });
  // perdeu menos da metade: fica, encurtada
  const kept = followCuts([{ index: 1, startMs: 0, endMs: 1000, text: "oi", words: [w("oi", 0, 1000)] }], [{ startMs: 800, endMs: 900 }]);
  assert.deepEqual(kept[0].words, [{ text: "oi", startMs: 0, endMs: 900 }]);
});

test("legendas seguem os cortes e a frase baixa da 2ª escuta continua com quiet (o próximo Autocorte não a corta)", () => {
  const items = [{ index: 1, startMs: 0, endMs: 3000, text: "como a escola", words: [
    { text: "como", startMs: 0, endMs: 500, quiet: true }, { text: "a", startMs: 1500, endMs: 1700, quiet: true }, { text: "escola", startMs: 1700, endMs: 3000, quiet: true }] }];
  const out = followCuts(items, [{ startMs: 600, endMs: 1400 }]);
  assert.deepEqual(out[0].words.map((w) => [w.text, !!w.quiet]), [["como", true], ["a", true], ["escola", true]]);
});

test("fim de frase esticado pela pausa: o corte do silêncio deixa a palavra com o pedaço falado", () => {
  // Premiere real (fx-2): "esquina." ia de 2000 a 3200 ms (o Whisper estica pela pausa) e o
  // silêncio de 2300 a 4000 saiu; a palavra perdia mais da metade e sumia da legenda.
  const w = (text, startMs, endMs) => ({ text, startMs, endMs });
  const items = [{ index: 1, startMs: 1000, endMs: 3200, text: "da esquina.", words: [w("da", 1000, 1300), w("esquina.", 1300, 3200)] },
    { index: 2, startMs: 4000, endMs: 5000, text: "E vi", words: [w("E", 3700, 4300), w("vi", 4300, 5000)] }];
  const out = followCuts(items, [{ startMs: 2300, endMs: 4000 }]);
  assert.deepEqual(out.map((i) => i.text), ["da esquina.", "E vi"]); // "E" puxado para dentro da pausa também fica
  assert.deepEqual(out[0].words[1], { text: "esquina.", startMs: 1300, endMs: 2300 });
  // ponta curta demais (lasca de 50 ms antes do corte) continua saindo
  assert.equal(followCuts([{ index: 1, startMs: 0, endMs: 1000, text: "x", words: [w("x", 0, 1000)] }], [{ startMs: 50, endMs: 1000 }]).length, 0);
});

test("palavra que o Whisper carimbou dentro do silêncio cortado volta para a peça vizinha", () => {
  // Premiere real (fx-2, whisper small): a fala acaba antes do silêncio medido (−91 dB), mas o fim
  // das frases veio carimbado até 1 s depois, dentro do corte. Peças mantidas: 0–4, 12,633–15,6,
  // 30,167–33,467; "4–12,633" tem retake (não é só silêncio).
  const w = (text, s, e) => ({ text, startMs: s * 1000, endMs: e * 1000 });
  const removed = [
    { startMs: 4000, endMs: 12633 },
    { startMs: 15600, endMs: 18000, silence: true },
    { startMs: 18000, endMs: 30167, silence: true },
    { startMs: 33467, endMs: 34130, silence: true },
  ];
  const items = [
    { index: 1, startMs: 14500, endMs: 17960, text: "no mercado da esquina.", words: [w("no", 14.5, 14.8), w("mercado", 15.07, 15.48), w("da", 16.66, 16.96), w("esquina.", 16.96, 17.96)] },
    { index: 2, startMs: 32000, endMs: 34880, text: "no final do vídeo.", words: [w("no", 32.4, 32.84), w("final", 32.84, 33.34), w("do", 33.51, 33.77), w("vídeo.", 33.77, 34.88)] },
    { index: 3, startMs: 5000, endMs: 6000, text: "retake", words: [w("retake", 5, 6)] }, // corte de conteúdo: sai
  ];
  const out = followCuts(items, removed);
  assert.deepEqual(out.map((i) => i.text), ["no mercado da esquina.", "no final do vídeo."]);
  const piece1End = 15600 - 8633, piece2End = 33467 - 8633 - 2400 - 12167;
  for (const [item, end] of [[out[0], piece1End], [out[1], piece2End]]) {
    const ws = item.words;
    assert.ok(ws.every((x, k) => x.endMs > x.startMs && (!k || x.startMs >= ws[k - 1].endMs)), JSON.stringify(ws));
    assert.equal(ws[ws.length - 1].endMs, end, "a frase termina no fim da peça");
  }
  assert.equal(out[0].words[0].startMs, 14500 - 8633, "o começo da frase não mexe");
  // dividido pelo tamanho das palavras (o tempo ali é palpite): "da" é a mais curta
  const [, mercado, da, esquina] = out[0].words;
  assert.ok(da.endMs - da.startMs < mercado.endMs - mercado.startMs && da.estimated && esquina.estimated);
  // a pausa do Whisper separou a frase: "subiu muito" inteira no silêncio vai para o fim da anterior
  const split = followCuts([
    { index: 1, startMs: 0, endMs: 1000, text: "o preço", words: [w("o", 0, 0.4), w("preço", 0.5, 1)] },
    { index: 2, startMs: 1600, endMs: 2500, text: "subiu muito", words: [w("subiu", 1.6, 2), w("muito", 2.1, 2.5)] },
  ], [{ startMs: 1200, endMs: 3000, silence: true }]);
  assert.deepEqual(split.map((i) => i.text), ["o preço", "subiu muito"]);
  assert.ok(split[0].words[1].endMs <= split[1].words[0].startMs && split[1].words[1].endMs === 1200, JSON.stringify(split));
  // começo da frase seguinte adiantado para dentro do silêncio, mas falado depois dele: fica lá
  const early = followCuts([
    { index: 1, startMs: 0, endMs: 2600, text: "eu fui lá ontem", words: [w("eu", 0, 0.4), w("fui", 0.5, 0.9), w("lá", 1.9, 2.4), w("ontem", 2.4, 2.6)] },
  ], [{ startMs: 1000, endMs: 2000, silence: true }]);
  assert.deepEqual(early[0].words.map((x) => [x.text, x.startMs]), [["eu", 0], ["fui", 500], ["lá", 1000], ["ontem", 1400]]);
  // o mesmo corte sem a marca de silêncio (vício, retake, fala baixa): as palavras dentro saem
  const strict = followCuts(items, removed.map((r) => ({ startMs: r.startMs, endMs: r.endMs })));
  assert.equal(strict[0].text, "no mercado");
});

test("legendas sem tempo por palavra (SRT) seguem o corte; a sobra de uma quase toda cortada sai", () => {
  const srt = [
    { index: 1, startMs: 0, endMs: 1000, text: "quase toda cortada" },
    { index: 2, startMs: 1000, endMs: 3000, text: "metade cortada" },
    { index: 3, startMs: 3000, endMs: 4000, text: "inteira" },
  ];
  const out = followCuts(srt, [{ startMs: 20, endMs: 1000 }, { startMs: 1000, endMs: 2000 }]);
  assert.deepEqual(out.map((i) => [i.text, i.startMs, i.endMs]), [["metade cortada", 20, 1020], ["inteira", 1020, 2020]]);
});
