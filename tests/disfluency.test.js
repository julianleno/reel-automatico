const test = require("node:test");
const assert = require("node:assert/strict");
const { findFillers, findRetakes, findOffscript, timingReliable, retakeShare } = require("../src/core/captions/disfluency.js");

// Palavras com 300 ms cada, coladas, a partir de 0 (pausa opcional antes de uma posição).
function words(text, pauses = {}) {
  let t = 0;
  return text.split(" ").map((w, i) => {
    t += pauses[i] || 0;
    const word = { text: w, startMs: t, endMs: t + 300 };
    t += 300;
    return word;
  });
}

test("vícios: hã/ahn e alongados; 'é' só solto depois de vírgula ou pausa", () => {
  const found = findFillers(words("então hã eu acho ééé que foi bom, é ver isso. É impossível"));
  assert.deepEqual(found.map((f) => f.text), ["hã", "ééé", "é"]);
  assert.equal(found[0].keep, "eu acho ééé que");
  assert.deepEqual([found[0].startMs, found[0].endMs], [300, 600]);
  // verbo no meio da frase, sem pausa: fica
  assert.deepEqual(findFillers(words("isso é muito bom")), []);
  // depois de uma pausa conta só se também parar depois; colado na palavra seguinte é verbo
  assert.equal(findFillers(words("isso é muito bom", { 1: 400, 2: 400 })).length, 1);
  assert.deepEqual(findFillers(words("isso é muito bom", { 1: 400 })), []);
  // Roteiro 4 (fx-3): "corrigir [1,2 s] é essencial." é verbo; e a hesitação sozinha entre pausas sai
  assert.deepEqual(findFillers(words("hormonal corrigir é essencial.", { 2: 1200 })), []);
  // Roteiro 4: "bem, [5,8 s] é fazer" é o começo da tomada boa; o "é" esticado pelo encaixe na volta da fala
  // (400 ms) não vale como arrastado depois da vírgula, porque a vírgula ficou do outro lado da pausa
  assert.deepEqual(findFillers([{ text: "bem,", startMs: 165800, endMs: 166300 }, { text: "é", startMs: 172070, endMs: 172470 },
    { text: "fazer", startMs: 172470, endMs: 173390 }]), []);
  assert.deepEqual(findFillers(words("falei. é eu acho", { 1: 600, 2: 600 })).map((f) => f.text), ["é"]);
  // depois de vírgula, "é" curto é verbo (bruto do cliente 2: "Sim, é isso mesmo", 20 ms)
  const sim = words("Sim, é isso mesmo");
  sim[1].endMs = sim[1].startMs + 20;
  sim[2].startMs = sim[1].endMs;
  assert.deepEqual(findFillers(sim), []);
  // depois de vírgula e com pausa, mas seguido de artigo: verbo (bruto do Jota: "você cobra, é [pausa] o quanto de tempo")
  assert.deepEqual(findFillers(words("o quanto você cobra, é o quanto de tempo", { 5: 430 })), []);
  assert.deepEqual(findFillers(words("o quanto você cobra, é eu acho", { 5: 430 })).map((f) => f.text), ["é"]);
  // lista editável
  assert.deepEqual(findFillers(words("tipo assim foi"), ["tipo"]).map((f) => f.text), ["tipo"]);
});

test("retake: frase recomeçada corta a primeira tentativa e mantém a última", () => {
  const w = words("hoje eu vou mostrar como hoje eu vou mostrar como fazer pão");
  const r = findRetakes(w);
  assert.equal(r.length, 1);
  assert.equal(r[0].kind, "retake");
  assert.equal(r[0].text, "hoje eu vou mostrar como");
  assert.deepEqual([r[0].startMs, r[0].endMs], [0, 1500]);
  assert.equal(r[0].keep, "hoje eu vou mostrar");
});

test("corte que acaba na palavra que fica deixa 120 ms de respiro antes dela, sem pegar a que sai", () => {
  // 1.MOV (148,1 s): tentativa, pausa de 2 s, a tomada boa; o corte ia até o começo dela e, emendado com
  // a pausa, comia a folga e o "P" de "Passava"
  const w = words("passava por guaratinguetá a caminho passava por guaratinguetá a caminho de vila rica", { 5: 2000 });
  const r = findRetakes(w);
  assert.equal(r.length, 1);
  assert.deepEqual([r[0].startMs, r[0].endMs], [0, w[5].startMs - 120]);
  // sem pausa (palavras coladas) não há respiro para deixar: o corte acaba no fim da última que sai
  assert.equal(findRetakes(words("hoje eu vou mostrar como hoje eu vou mostrar como fazer pão"))[0].endMs, 1500);
  // pausa curta: o respiro é o que houver, nunca pegando a palavra que sai
  const short = findRetakes(words("passava por guaratinguetá a caminho passava por guaratinguetá a caminho de vila", { 5: 50 }));
  assert.equal(short[0].endMs, 1500);
  // vício com pausa depois: o corte acaba no fim dele (a pausa fica com o corte de silêncio e a folga dele)
  const f = findFillers(words("eu fui hã lá", { 2: 400, 3: 300 }));
  assert.deepEqual([f[0].startMs, f[0].endMs], [1000 - 40, 1300]); // 40 ms antes do "hã": o quadro arredondado não deixa a ponta dele
});

test("retake com trecho abandonado e três tentativas: fica só a última", () => {
  const w = words("a receita de bolo erro a receita de bolo errei de novo a receita de bolo de cenoura");
  const r = findRetakes(w);
  assert.deepEqual(r.map((x) => x.text), ["a receita de bolo erro", "a receita de bolo errei de novo"]);
  assert.equal(r[1].keep, "a receita de bolo");
});

test("palavra dobrada vira repetição; frase comum repetida sem palavra longa não", () => {
  assert.deepEqual(findRetakes(words("eu acho que que sim")).map((x) => [x.kind, x.text]), [["repeticao", "que"]]);
  assert.deepEqual(findRetakes(words("de que a casa e de que a rua")), []);
  // repetição longe demais (mais de 10 s) não é retake
  const far = words("vamos falar de bolo hoje", {}).concat(words("vamos falar de bolo hoje").map((x) => ({ ...x, startMs: x.startMs + 20000, endMs: x.endMs + 20000 })));
  assert.deepEqual(findRetakes(far), []);
});

test("frase recomeçada do começo depois de uma vírgula, mais de 10 s depois: a 1ª tentativa sai", () => {
  // 2.MOV (63,9 s): a tentativa leva 12 s até a vírgula; o editor tirou ela e ficou com a segunda
  const text = "Tem uma palavra que é ruim. A Câmara de Vila Rica queria muito agradar o governador durante a sua passagem e queria oferecer, a Câmara de Vila Rica queria agradar o governador e oferecer a ele um banquete.";
  const w = words(text).map((x, i) => (i >= 6 ? { ...x, startMs: x.startMs + i * 500, endMs: x.endMs + i * 500 } : x));
  const r = findRetakes(w);
  assert.equal(w[23].startMs - w[6].startMs > 10000, true);
  assert.deepEqual(r.map((c) => c.text), ["A Câmara de Vila Rica queria muito agradar o governador durante a sua passagem e queria oferecer,"]);
  // no meio da frase (cliente 1: "quem da equipe pedagógica é especialista" e, 29 s depois, "quem ali da equipe pedagógica é
  // especialista"), não: emendaria duas tomadas no meio da frase
  const mid = words("Primeira pergunta, quem da equipe pedagógica é especialista em educação inclusiva, e depois vem o resto, quem ali da equipe pedagógica é especialista em educação inclusiva?")
    .map((x, i) => (i >= 13 ? { ...x, startMs: x.startMs + 20000, endMs: x.endMs + 20000 } : x));
  assert.deepEqual(findRetakes(mid), []);
});

test("frase regravada sem o conector da frente: a com conector sai", () => {
  // 2.MOV: "Por isso, os parlamentares chamaram." e, depois de outra fala, "Os parlamentares chamaram Domingos Garcia"
  const w = words("Por isso, os parlamentares chamaram. Deixa pra lá. Os parlamentares chamaram Domingos Garcia, João Alves e Felipe Pedroso.");
  assert.deepEqual(findRetakes(w).map((c) => c.text), ["Por isso, os parlamentares chamaram."]);
  // conteúdo novo depois do conector não é retake
  assert.deepEqual(findRetakes(words("Por isso, os alunos estudam muito. Os professores gostam de bolo e de festa.")), []);
});

test("retake de frase inteira: dita, terminada e regravada mais adiante (fica a última)", () => {
  // como no bruto da cliente 1: a primeira pergunta regravada 30 s depois
  const w = words(
    "Primeira pergunta, quem da equipe pedagógica é especialista? Não pergunte apenas isso. Primeira pergunta, quem ali da equipe pedagógica é especialista em inclusão?",
    { 7: 30000 }
  );
  const r = findRetakes(w);
  assert.deepEqual(r.map((c) => c.text), ["Primeira pergunta, quem da equipe pedagógica é especialista?"]);
  // roteiro repetindo de propósito depois de uma frase terminada não é retake (cliente 2)
  assert.deepEqual(findRetakes(words("mas ela voltou vazia. Lançaram pela segunda vez e ela voltou vazia novamente.")), []);
  // anáfora (oração completa, vírgula, mesma abertura com outro fim) fica: vídeos editados do
  // cliente 2 e da cliente 1
  assert.deepEqual(findRetakes(words("Hoje nós temos uma mãe, nós temos uma protetora, uma intercessora.")), []);
  assert.deepEqual(findRetakes(words("Nossa Senhora Aparecida continuam no coração do brasileiro, Nossa Senhora Aparecida, padroeira.")), []);
  assert.deepEqual(findRetakes(words("Quem não sonha em conhecer o Vale da Paraíba, mas sonha em conhecer o santuário.")), []);
  // recomeço de verdade continua saindo, mesmo com vírgula
  assert.equal(findRetakes(words("eu fui lá ontem, eu fui lá ontem no mercado.")).length, 1);
  // só o conector igual no começo não é retake (vídeo editado: "Para isso, ..." duas vezes)
  assert.deepEqual(findRetakes(words("Para isso, sinta-te em primeiro lugar. Tenha produto bonito. Para isso é muito importante ter maquininha.")), []);
  // o conector igual e o resto repetido é
  assert.equal(findRetakes(words("Para isso, escolha bons pontos. Para isso, escolha pontos de ônibus.")).length, 1);
});

test("frase largada no meio e refeita com outro começo: a largada sai", () => {
  const w = words("Por isso, os parlamentares chamaram... Os parlamentares chamaram Domingos Garcia para pescar.");
  assert.deepEqual(findRetakes(w).map((c) => c.text), ["Por isso, os parlamentares chamaram..."]);
  // sem reticências a frase não conta como largada: só a repetição colada sai, o "Por isso," fica
  assert.deepEqual(findRetakes(words("Por isso, os parlamentares chamaram. Os parlamentares chamaram Domingos Garcia para pescar.")).map((c) => c.text), ["os parlamentares chamaram."]);
});

test("pergunta do gancho refeita com outro começo: a primeira sai; pergunta nova, não", () => {
  const w = words("Por que envolverem Nossa Senhora Aparecida na política? O que tem a ver Nossa Senhora Aparecida com política? Na verdade, tudo.");
  assert.deepEqual(findRetakes(w).map((c) => c.text), ["Por que envolverem Nossa Senhora Aparecida na política?"]);
  assert.deepEqual(findRetakes(words("Você sabe quem foi Domingos Garcia? E por que os pescadores voltaram ao rio?")), []);
});

test("fora do roteiro: 'deixa eu te contar' é gancho (conteúdo); só o inequívoco sai sozinho", () => {
  assert.deepEqual(findOffscript(words("Deixa eu te contar uma coisa sobre Aparecida.")), []);
  const found = findOffscript(words("Ficou ruim. Vou de novo do começo. Acho que ficou claro pra vocês."));
  assert.deepEqual(found.map((f) => [f.text, !!f.sure]), [
    ["Ficou ruim.", false],
    ["Vou de novo do começo.", true],
    ["Acho que ficou claro pra vocês.", false],
  ]);
  // duas marcas fortes diferentes na mesma frase: sai sozinho (1.MOV e 2.MOV, o editor tirou as duas)
  const two = findOffscript(words("Então esse é um gancho, depois eles veem que eu vou ficar melhor. Acho que é bom, mas deixa eu só terminar essa frase. Acho que é bom saber disso."));
  assert.deepEqual(two.map((f) => [f.text.slice(0, 20), !!f.sure]), [["Então esse é um ganc", true], ["Acho que é bom, mas ", true], ["Acho que é bom saber", false]]);
});

test("contagem: o resto da frase vira sugestão de ensaio, desmarcada", () => {
  const found = findOffscript(words("um, dois, três, a Câmara, a Câmara, como se falava. A Câmara de Vila Rica queria agradar."));
  assert.deepEqual(found.map((f) => [f.text, !!f.sure]), [["um, dois, três,", true], ["a Câmara, a Câmara, como se falava.", false]]);
});

test("tempo espremido pelo Whisper: sem sugestão de corte que levaria fala junto", () => {
  // como no cliente 2: "Eles acreditando ... lançaram as" todas no mesmo instante, depois "redes," longa
  const w = words("Eles acreditando que teriam sorte lançaram as redes, lançaram as redes, mas voltou vazia.");
  for (let k = 1; k <= 7; k += 1) w[k].startMs = w[k].endMs = w[0].startMs = w[0].endMs = 1000;
  w[7].endMs = 5000;
  w[7].startMs = 1000;
  assert.equal(findRetakes(w).length, 0);
  // com o tempo certo, a mesma fala vira sugestão normal
  assert.deepEqual(findRetakes(words("Eles acreditando que teriam sorte lançaram as redes, lançaram as redes, mas voltou vazia.")).map((c) => c.text), ["lançaram as redes,"]);
  assert.equal(timingReliable(w, 5, 8), false);
  assert.equal(timingReliable(w, 0, 3), false); // o fim cai numa palavra espremida
  assert.equal(timingReliable(words("um dois três"), 1, 2), true);
});

test("fora do roteiro: contagem para começar sai, com certeza; 'um' sozinho é artigo", () => {
  const found = findOffscript(words("a Câmara de, um, dois, três, a Câmara de Vila Rica tem um banquete."));
  assert.deepEqual(found.map((f) => [f.kind, f.text, !!f.sure]), [["ensaio", "um, dois, três,", true]]);
  assert.deepEqual(findOffscript(words("três, dois, um, valendo")).map((f) => f.text), ["três, dois, um,"]);
});

test("fora do roteiro: frase sobre a gravação vira sugestão; a mesma palavra no conteúdo, não", () => {
  const w = words("Ninguém conseguia pescar. Acho que é bom, mas deixa eu só terminar essa frase. Eles lançaram as redes.");
  const found = findOffscript(w);
  assert.deepEqual(found.map((f) => [f.kind, f.text]), [["fora", "Acho que é bom, mas deixa eu só terminar essa frase."]]);
  assert.equal(found[0].keep, "Eles lançaram as redes.");
  // marca fraca só em fala curta, separada por pausa
  assert.deepEqual(findOffscript(words("O cozinheiro corta a cebola em cubos bem pequenos.")), []);
  assert.deepEqual(findOffscript(words("tudo pronto corta essa parte", { 2: 900 })).map((f) => f.text), ["corta essa parte"]);
});

test("fora do roteiro: palavra de duração zero no fim não vira sugestão vazia", () => {
  // achado com 4.000 sementes dos invariantes (semente 1622)
  assert.deepEqual(findOffscript([{ text: "corta", startMs: 7721, endMs: 7721 }]), []);
  // contagem espremida no mesmo instante (semente 14888 de 20.000)
  const squeezed = findOffscript([{ text: "um", startMs: 43917, endMs: 43917 }, { text: "dois", startMs: 43917, endMs: 43917 }, { text: "eu", startMs: 44000, endMs: 44300 }]);
  assert.ok(squeezed.every((c) => c.endMs > c.startMs), JSON.stringify(squeezed));
});

test("filterByScript: repetição que o roteiro repete fica; retake de verdade e vício saem", () => {
  const { filterByScript } = require("../src/core/captions/disfluency.js");
  const cands = [
    { kind: "repeticao", text: "isso muda tudo" },
    { kind: "retake", text: "eu fui lá ontem" },
    { kind: "fora", text: "Compra agora!" },
    { kind: "fora", text: "corta essa parte" },
    { kind: "vicio", text: "é" },
    { kind: "ensaio", text: "um dois três", sure: true },
  ];
  const roteiro = "Isso muda tudo. Eu fui lá ontem no mercado. Isso muda tudo! Compra agora.";
  assert.deepEqual(filterByScript(cands, roteiro).map((c) => c.text), ["eu fui lá ontem", "corta essa parte", "é", "um dois três"]);
  // repetição colada no roteiro também conta duas vezes
  assert.equal(filterByScript([{ kind: "retake", text: "eu fui lá ontem" }], "Eu fui lá ontem. Eu fui lá ontem no mercado.").length, 0);
  assert.equal(filterByScript(cands, "").length, cands.length);
  assert.equal(filterByScript(cands, "   ").length, cands.length);
});

test("retakeShare: quanto da fala os trechos marcados tiram (vício não conta, desmarcado não conta)", () => {
  const w = [0, 1, 2, 3, 4].map((i) => ({ text: "p" + i, startMs: i * 1000, endMs: i * 1000 + 500 }));
  assert.equal(retakeShare(w, [{ kind: "retake", checked: true, startMs: 0, endMs: 2000 }]), 0.4);
  assert.equal(retakeShare(w, [{ kind: "vicio", checked: true, startMs: 0, endMs: 5000 }, { kind: "ensaio", checked: false, startMs: 0, endMs: 5000 }]), 0);
  assert.equal(retakeShare([], []), 0);
});

test("findRetakes: duas palavras de conteúdo repetidas em seguida viram repetição; expressões não", () => {
  const kinds = (t) => findRetakes(words(t)).map((c) => c.kind + ":" + c.text);
  assert.deepEqual(kinds("eu sou o Domingos Garcia Domingos Garcia e hoje"), ["repeticao:Domingos Garcia"]);
  assert.deepEqual(kinds("pouco a pouco a gente chega"), []);
  assert.deepEqual(kinds("dia a dia a gente aprende"), []);
  assert.deepEqual(kinds("é isso é isso mesmo"), []);
  // recomeço curto com vírgula ou pausa no meio (2.MOV: "A Câmara, a Câmara de Vila Rica"): sai a primeira
  assert.deepEqual(kinds("A Câmara, a Câmara de Vila Rica queria"), ["repeticao:A Câmara,"]);
  assert.deepEqual(findRetakes(words("o governador o governador gostava", { 2: 400 })).map((c) => c.text), ["o governador"]);
  // trio colado é de propósito (bruto do Jota): nada sai
  assert.deepEqual(kinds("coloca som e faz tudo de novo e de novo e de novo no próximo vídeo."), []);
  // anáfora com vírgula continua fora ("nós temos uma mãe, nós temos uma protetora", cliente 2)
  assert.deepEqual(kinds("nós temos uma mãe, nós temos uma protetora"), []);
});
