const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const AI = require("../src/adobe/cep/js/services/ai.js");
const IA = require("../prototypes/reel-sem-premiere/ia.js");
const { timingReliable } = require("../src/core/captions/disfluency.js");

// resposta da API como a função do Supabase devolve
const reply = (answer) => ({ ok: true, status: 200, json: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(answer) }] }) });
const words = ["Hoje", "eu", "vou", "Hoje", "eu", "vou", "falar", "de", "dinheiro."].map((text, i) => ({ text, startMs: i * 400, endMs: i * 400 + 300 }));

test("app: sem código a IA não é chamada e tudo volta null (segue pelas regras)", async () => {
  let calls = 0;
  const s = IA.session(AI, "", { fetch: async () => { calls += 1; return reply({}); } });
  assert.equal(s.on, false);
  assert.equal(await s.cuts(words, timingReliable), null);
  assert.equal(await s.keys([{ words: [{ text: "x" }] }]), null);
  assert.equal(await s.post(words), null);
  assert.equal(calls, 0);
});

test("app: Boost vira trechos do bruto; o vício fica com as regras; regra dentro do corte da IA sai", async () => {
  IA.memo.clear();
  const sent = [];
  const fetch = async (url, init) => {
    sent.push(JSON.parse(init.body));
    assert.ok(init.signal, "pedido com prazo e Cancelar");
    return reply({ cuts: [{ from: 0, to: 2, reason: "retake", note: "dito de novo" }, { from: 7, to: 7, reason: "vicio", note: "de" }] });
  };
  const s = IA.session(AI, "TESTE-1", { fetch });
  const cuts = await s.cuts(words, timingReliable);
  assert.equal(sent[0].task, "cuts");
  assert.equal(sent[0].code, "TESTE-1");
  // o fim vai até a palavra seguinte (como o Boost do painel)
  assert.deepEqual(cuts, [{ kind: "retake", startMs: 0, endMs: 1200, text: "Hoje eu vou", note: "dito de novo" }]);
  const rules = [{ kind: "retake", startMs: 100, endMs: 900, text: "eu vou" }, { kind: "filler", startMs: 2800, endMs: 3100, text: "de" }];
  assert.deepEqual(IA.mergeCuts(rules, cuts).map((c) => c.startMs), [0, 2800]);
  // a mesma fala de novo (prévia, "Fazer de novo"): não paga outra vez
  await IA.session(AI, "TESTE-1", { fetch }).cuts(words, timingReliable);
  assert.equal(sent.length, 1);
});

test("app: IA fora do ar avisa uma vez e o resto da rodada nem chama", async () => {
  IA.memo.clear();
  let calls = 0;
  const fails = [];
  const fetch = async () => {
    calls += 1;
    throw new TypeError("Failed to fetch");
  };
  const s = IA.session(AI, "TESTE-1", { fetch, onFail: (what, why) => fails.push(what + ": " + why) });
  assert.equal(await s.cuts(words, timingReliable), null);
  assert.equal(await s.keys([{ words: [{ text: "dinheiro." }] }]), null);
  assert.equal(await s.post(words), null);
  assert.equal(calls, 1);
  assert.deepEqual(fails, ["cortes: sem conexão com a internet"]);
  // o aviso não promete post: depois da 1ª falha nenhuma chamada sai
  assert.equal(IA.failMessage("sem conexão com a internet", true), "IA indisponível (sem conexão com a internet): o Reel sai pelas regras do app, sem o texto do post.");
  assert.equal(IA.failMessage("cancelado", false), "IA indisponível (cancelado): o Reel sai pelas regras do app.");
  // código errado: a mensagem do ai.js chega ao aviso
  const s2 = IA.session(AI, "ERRADO", { fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }), onFail: (w, why) => fails.push(why) });
  assert.equal(await s2.reel(words, 30), null);
  assert.equal(fails[1], "código de acesso da IA inválido");
});

test("app: IA que não responde cai no prazo; Cancelar larga o pedido", async () => {
  IA.memo.clear();
  const hang = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  const fails = [];
  const slow = IA.session(AI, "TESTE-1", { fetch: hang, timeoutMs: 50, onFail: (w, why) => fails.push(why) });
  assert.equal(await slow.post(words), null);
  const stop = new AbortController();
  const s = IA.session(AI, "TESTE-1", { fetch: hang, signal: stop.signal, onFail: (w, why) => fails.push(why) });
  const pending = s.keys([{ words: [{ text: "dinheiro." }] }]);
  stop.abort();
  assert.equal(await pending, null);
  assert.deepEqual(fails, ["a IA demorou mais de 2 minutos", "cancelado"]);
});

test("app: destaques e post pela IA; o post.txt tem título, legenda e hashtags", async () => {
  IA.memo.clear();
  const s = IA.session(AI, "TESTE-1", {
    fetch: async (url, init) => {
      const task = JSON.parse(init.body).task;
      return reply(task === "keys" ? { picks: [{ sentence: 0, word: 2 }] } : { title: "Dinheiro hoje", caption: "Para tudo. Comenta aí!", hashtags: ["#Dinheiro", "financas"], chapters: [] });
    },
  });
  assert.deepEqual(await s.keys([{ words: [{ text: "falar" }, { text: "de" }, { text: "dinheiro." }] }]), [2]);
  const post = await s.post(words);
  assert.equal(IA.postFile(post, AI.chaptersText), "﻿Dinheiro hoje\n\nPara tudo. Comenta aí!\n\n#dinheiro #financas\n");
});

test("app: a tela carrega os mesmos scripts que o modo sem tela (faltava o reel-plan e a IA: 'AppLegendasReelPlan is not defined')", () => {
  const dir = path.join(__dirname, "../prototypes/reel-sem-premiere");
  const srcs = (file) => [...fs.readFileSync(path.join(dir, file), "utf8").matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  const ui = srcs("ui.html");
  for (const s of srcs("index.html")) assert.ok(ui.includes(s), "ui.html sem " + s);
});

test("app: trecho do plano não começa nem termina no meio da frase (\"gostava muito de\" e pulava, 2.MOV)", () => {
  const words = ["banquete.", "O", "governador", "gostava", "muito", "de", "peixe.", "\"Domingos", "Garcia\",", "eu", "acho.", "Os", "parlamentares", "chamaram",
    "Domingos", "Garcia,", "João", "Alves", "e", "Felipe", "Pedroso."].map((text, i) => ({ text, startMs: i * 500, endMs: i * 500 + 400 }));
  // termina em "de": vai até "peixe."; o vizinho não muda
  assert.deepEqual(IA.closeSentences([{ from: 0, to: 5 }, { from: 11, to: 20 }], words), [{ from: 0, to: 6 }, { from: 11, to: 20 }]);
  // começa em "governador": volta para o "O"
  assert.deepEqual(IA.closeSentences([{ from: 2, to: 6 }], words), [{ from: 1, to: 6 }]);
  // o fim de frase está a mais de 3 palavras: encolhe até a frase inteira ("acho.")
  assert.deepEqual(IA.closeSentences([{ from: 0, to: 13 }], words), [{ from: 0, to: 10 }]);
  // não entra no trecho seguinte: encolhe até "banquete." (e o seguinte, que começava em "peixe.", vai à frase dele); encostados viram um só
  assert.deepEqual(IA.closeSentences([{ from: 0, to: 4 }, { from: 6, to: 10 }], words), [{ from: 0, to: 0 }, { from: 7, to: 10 }]);
  assert.deepEqual(IA.closeSentences([{ from: 0, to: 5 }, { from: 6, to: 10 }], words), [{ from: 0, to: 10 }]);
  // começo de frase longe demais e nenhum dentro: o começo fica como veio; o fim vai até "Pedroso."
  assert.deepEqual(IA.closeSentences([{ from: 15, to: 17 }], words), [{ from: 15, to: 20 }]);
});

test("app: trecho separado do vizinho só pelo retake continua a frase (a tomada boa não sai)", () => {
  // Roteiro 4 em 60 s: "…da concentração [e da própria performance,] e da própria performance. Então, …"; a tomada
  // boa começava "no meio da frase" e saía, e o Reel emendava "concentração" em "Então,"
  const words = ["do", "foco,", "da", "concentração", "e", "da", "própria", "performance,", "e", "da", "própria", "performance.", "Então,", "não", "é", "só", "usar."]
    .map((text, i) => ({ text, startMs: i * 500, endMs: i * 500 + 400 }));
  const segs = [{ from: 0, to: 3 }, { from: 8, to: 16 }];
  assert.deepEqual(IA.closeSentences(segs, words, [{ from: 4, to: 7 }]), segs);
  // sem dizer o que é retake, é como antes: a tomada boa encolhe até a frase seguinte
  assert.deepEqual(IA.closeSentences(segs, words)[1], { from: 12, to: 16 });
});

test("app: retake que começou a frase deixa a tomada boa inteira, mesmo sem o trecho vizinho", () => {
  // 2.MOV: "passagem. [A Câmara queria oferecer,] a Câmara queria agradar. O governador…"; sem a frase de antes no
  // plano (olhando o paletó), a tomada boa saía e sobrava só "O governador…"
  const words = ["passagem.", "A", "Câmara", "queria", "oferecer,", "a", "Câmara", "queria", "agradar.", "O", "governador", "gostava."]
    .map((text, i) => ({ text, startMs: i * 500, endMs: i * 500 + 400 }));
  const segs = [{ from: 0, to: 0 }, { from: 5, to: 11 }];
  assert.deepEqual(IA.closeSentences(segs, words, [{ from: 1, to: 4 }]), [{ from: 0, to: 0 }, { from: 5, to: 11 }]);
  assert.deepEqual(IA.closeSentences([{ from: 5, to: 11 }], words, [{ from: 1, to: 4 }]), [{ from: 5, to: 11 }]);
});
