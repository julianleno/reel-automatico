// Reel na duração pedida (src/core/video/reel-plan.js): só contas, com palavras de mentira.
const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../src/core/video/reel-plan.js");

// frases: [n de palavras, pausa depois (ms)]; cada palavra dura 300 ms com 50 ms entre elas
function speech(sentences) {
  const words = [];
  let t = 0;
  sentences.forEach(([n, pause]) => {
    for (let k = 0; k < n; k += 1) {
      words.push({ text: "p" + words.length + (k === n - 1 ? "." : ""), startMs: t, endMs: t + 300 });
      t += 350;
    }
    t += pause - 50;
  });
  return words;
}

test("reel na duração: pausa longa conta só 240 ms (o corte de silêncio tira o resto)", () => {
  const w = speech([[3, 2000], [3, 0]]);
  // 6 palavras de 300 ms + 4 vãos de 50 ms + uma pausa de 2 s que conta 240
  assert.equal(R.speechMs(w, 0, 5), 6 * 300 + 4 * 50 + 240);
  assert.deepEqual(R.sentences(w), [{ from: 0, to: 2 }, { from: 3, to: 5 }]);
});

test("reel na duração: tira o que a IA mandou tirar e não deixa pedacinho solto", () => {
  const w = speech([[10, 0], [10, 0]]);
  // retake nas palavras 2-17: sobram 0-1 (0,65 s, picota: sai) e 18-19 (sai)
  assert.deepEqual(R.minus([{ from: 0, to: 19 }], [{ from: 2, to: 17 }], w), []);
  assert.deepEqual(R.minus([{ from: 0, to: 19 }], [{ from: 8, to: 11 }], w), [{ from: 0, to: 7 }, { from: 12, to: 19 }]);
});

test("reel na duração: o último trecho é cortado no fim de uma frase, nunca no meio", () => {
  // 6 frases de 3,45 s com pausa (conta 240 ms) e 300 ms de folga no trecho: 2 frases = 7,44 s,
  // 3 = 11,13 s; meta 10 s (até 10,5 s) cabe 2
  const w = speech([[10, 1000], [10, 1000], [10, 1000], [10, 1000], [10, 1000], [10, 1000]]);
  const out = R.trimTo([{ from: 0, to: 59 }], w, 10000);
  assert.deepEqual(out, [{ from: 0, to: 19 }]);
  assert.ok(R.totalMs(out, w) <= 10500);
  assert.ok(String(w[out[0].to].text).endsWith("."));
});

test("reel na duração: um trecho da IA que já dá a meta vence a colagem de pedaços", () => {
  const w = speech(Array.from({ length: 30 }, () => [10, 300])); // 30 frases de ~3,75 s
  // trecho A (score 9): 16 frases (~60 s); B e C (score 8 e 7): curtos
  const clips = [{ from: 200, to: 209, score: 8 }, { from: 0, to: 159, score: 9 }, { from: 220, to: 229, score: 7 }];
  const out = R.choose(clips, w, 60000, []);
  assert.equal(out[0].from, 0);
  const ms = R.totalMs(out, w);
  assert.ok(ms >= 60000 * 0.85 && ms <= 60000 * 1.1, "dura " + ms);
  // sem trecho do tamanho certo: junta os melhores em ordem do bruto
  const mix = R.choose([{ from: 100, to: 129, score: 9 }, { from: 10, to: 39, score: 8 }], w, 25000, []);
  assert.deepEqual(mix.map((s) => s.from), [10, 100]);
});

test("reel na duração: sem IA, as frases em ordem até a meta, sem o retake", () => {
  const w = speech([[10, 800], [10, 800], [10, 800], [10, 800]]);
  const out = R.fallback(w, 8000, [{ from: 0, to: 9 }]); // 1ª frase era tentativa
  assert.equal(out[0].from, 10);
  assert.ok(R.totalMs(out, w) <= 8800);
});

test("reel na duração: sem IA, frase longa demais para caber não para o plano; as seguintes completam", () => {
  // 1.MOV: o Whisper não pôs o ponto e a 2ª frase tinha 33 s; o plano de 30 s parava em 13 s
  const w = speech([[10, 800], [10, 800], [100, 800], [10, 800], [10, 800], [10, 800], [10, 800], [10, 800]]);
  const out = R.fallback(w, 15000, []);
  const ms = R.totalMs(out, w);
  assert.ok(ms >= 15000 * 0.85 && ms <= 15000 * 1.1, "dura " + ms);
  assert.ok(out.every((s) => s.to < 20 || s.from >= 120), "a frase de 100 palavras fica de fora: " + JSON.stringify(out));
  assert.equal(out[0].from, 0);
});

test("reel na duração: o que sai do bruto, com folga em volta das falas", () => {
  const w = speech([[3, 2000], [3, 2000], [3, 0]]);
  const cuts = R.cutsOutside([{ from: 3, to: 5 }], w, 10000, 150);
  assert.equal(cuts.length, 2);
  assert.equal(cuts[0].startMs, 0);
  assert.equal(cuts[0].endMs, w[3].startMs - 150);
  assert.equal(cuts[1].startMs, w[5].endMs + 150);
  assert.equal(cuts[1].endMs, 10000);
});

test("reel na duração: com pontuação, a pausa no meio da frase não vira fim (\"saúde e da [pausa]\")", () => {
  // frase 1 (10 palavras, ponto); frase 2: 6 palavras, pausa de 900 ms SEM ponto, mais 6 palavras e ponto
  const w = [];
  let t = 0;
  const add = (n, last) => {
    for (let k = 0; k < n; k += 1) {
      w.push({ text: "p" + w.length + (last && k === n - 1 ? "." : ""), startMs: t, endMs: t + 300 });
      t += 350;
    }
  };
  add(10, true);
  t += 600;
  add(6, false);
  t += 850; // pausa longa no meio da frase 2
  add(6, true);
  // meta perto do fim da pausa: antes, o corte parava em p15 ("... e da"); agora vai até o ponto ou fica na frase 1
  const out = R.trimTo([{ from: 0, to: w.length - 1 }], w, 6500);
  const last = w[out[out.length - 1].to].text;
  assert.ok(last.endsWith("."), "terminou em " + last);
});

test("reel na duração: trecho da IA curto demais segue com a fala limpa logo depois", () => {
  const w = speech(Array.from({ length: 12 }, () => [10, 800])); // 12 frases de ~3,7 s com folga
  // a IA achou só as 3 primeiras frases (a abertura); meta 25 s; a frase 4 é retake e sai
  const out = R.choose([{ from: 0, to: 29, score: 9 }], w, 25000, [{ from: 30, to: 39 }]);
  const ms = R.totalMs(out, w);
  assert.ok(ms >= 25000 * 0.85 && ms <= 25000 * 1.1, "dura " + ms);
  assert.equal(out[0].from, 0);
  assert.ok(out.every((s) => s.to < 30 || s.from > 39), "o retake não volta");
});

test("reel na duração: plano curto completa com a frase do meio primeiro, depois a seguinte", () => {
  const w = speech([[10, 800], [10, 800], [10, 800], [10, 800], [10, 800]]); // 5 frases de ~3,45 s
  // a IA pegou a 1ª e a 3ª (~7,5 s) para uma meta de 11 s: entra a 2ª (a do meio), não a 4ª
  const out = R.fill([{ from: 0, to: 9 }, { from: 20, to: 29 }], w, 11000, []);
  assert.deepEqual(out, [{ from: 0, to: 29 }]);
  // a frase do meio é retake: entra a seguinte
  const skip = R.fill([{ from: 0, to: 9 }, { from: 20, to: 29 }], w, 11000, [{ from: 10, to: 19 }]);
  assert.deepEqual(skip.map((s) => s.from), [0, 20]);
  assert.equal(skip[skip.length - 1].to, 39);
  // já na meta: fica igual
  assert.deepEqual(R.fill([{ from: 0, to: 29 }], w, 10000, []), [{ from: 0, to: 29 }]);
  // pausa no meio da frase não quebra a frase forte
  assert.equal(R.strongSentences(speech([[3, 2000], [3, 0]]).map((x, i) => (i === 2 ? { ...x, text: "sem" } : x))).length, 1);
});

test("reel na duração: frase dita sem olhar a câmera perde a vez se outras completam a duração", () => {
  // 6 frases de 10 palavras (3,45 s cada); meta 10 s: o plano em ordem pega as 2 primeiras + a 3ª
  const w = speech([[10, 1000], [10, 1000], [10, 1000], [10, 1000], [10, 1000], [10, 1000]]);
  const plan = R.fallback(w, 10000, []);
  assert.deepEqual(plan, [{ from: 0, to: 19 }]);
  // a 2ª foi dita olhando o paletó: sai, e a 3ª entra no lugar
  const out = R.avoid(plan, w, 10000, [], [{ from: 10, to: 19 }]);
  assert.deepEqual(out, [{ from: 0, to: 9 }, { from: 20, to: 29 }]);
  // sem outra frase para completar (o resto saiu como retake), fica como estava: preferência, não regra
  assert.deepEqual(R.avoid(plan, w, 10000, [{ from: 20, to: 59 }], [{ from: 10, to: 19 }]), plan);
  assert.deepEqual(R.avoid(plan, w, 10000, [], []), plan);
});
