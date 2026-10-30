const test = require("node:test");
const assert = require("node:assert/strict");
const { snapWordsToSpeech, spreadCollapsed } = require("../src/core/captions/timing.js");
const { buildSegments } = require("../src/core/captions/segmenter.js");
const { wordsFromWhisperJson } = require("../src/adobe/cep/js/services/transcribe.js");

const w = (text, startMs, endMs) => ({ text, startMs, endMs });

// Tempos medidos no vídeo de teste do Jota (Whisper "Boa" e "Máxima" no mesmo áudio).
test("palavra que o Whisper pôs no silêncio vai para onde a fala volta", () => {
  const silences = [{ startMs: 8530, endMs: 9210 }, { startMs: 10530, endMs: 10720 }];
  const out = snapWordsToSpeech([w("anel.", 8290, 8680), w("Chego", 8960, 9520), w("agora", 9520, 10100), w("e", 10550, 10650), w("eu", 10650, 10880)], silences);
  assert.deepEqual(out.map((x) => x.startMs), [8290, 9210, 9520, 10720, 10784]);
  assert.equal(out[0].endMs, 8530, "a palavra antes da pausa termina quando a fala para");
});

test("primeira palavra depois da pausa, atrasada, volta para o começo da fala", () => {
  const silences = [{ startMs: 8530, endMs: 9210 }];
  const out = snapWordsToSpeech([w("anel.", 9020, 9340), w("Chegou", 9600, 9820)], silences);
  assert.deepEqual(out.map((x) => x.startMs), [9020, 9210]);
  // longe demais (pode ser um "é" que o Whisper tirou): fica
  assert.equal(snapWordsToSpeech([w("x", 0, 100), w("Chegou", 9700, 9820)], silences)[1].startMs, 9700);
});

test("palavra com pontuação no silêncio ainda é da frase anterior e não anda", () => {
  const silences = [{ startMs: 6880, endMs: 7140 }];
  const out = snapWordsToSpeech([w("para", 6860, 6940), w("mim,", 6940, 7390), w("que", 7390, 7580)], silences);
  assert.deepEqual(out.map((x) => x.startMs), [6860, 6940, 7140]);
});

test("palavra com vírgula no silêncio depois de ponto final é frase nova: vai para a volta da fala", () => {
  // Roteiro 4: "performance. [4 s] Então, não é só"; o Whisper pôs "Então," 40 ms antes da fala voltar e ela ia
  // para 99,7 s, em cima do "performance." (o Reel na duração emendava no meio da palavra)
  const silences = [{ startMs: 99970, endMs: 104120 }];
  const out = snapWordsToSpeech([w("própria", 98860, 99160), w("performance.", 99160, 100020), w("Então,", 104080, 104700), w("não", 104700, 105100)], silences);
  assert.equal(out[2].startMs, 104120);
  assert.equal(out[1].endMs, 99970);
});

test("fim de frase carimbado no silêncio volta para o fim da fala, dividido pelo tamanho", () => {
  // Premiere real (fx-2, Whisper small): fala até 15,42 s, silêncio digital até 18,15 s, e o
  // Whisper pôs "da esquina." em 16,66–17,96 s.
  const silences = [{ startMs: 15420, endMs: 18150 }];
  const out = snapWordsToSpeech([w("no", 14500, 14800), w("mercado", 15070, 15480), w("da", 16660, 16960), w("esquina.", 16960, 17960), w("E", 18300, 18400)], silences);
  assert.deepEqual(out.slice(0, 2).map((x) => x.startMs), [14500, 15070]);
  assert.equal(out[3].endMs, 15420, "a frase acaba quando a fala para");
  assert.ok(out[1].estimated && out[2].estimated && out[3].estimated);
  assert.ok(out[2].endMs - out[2].startMs < out[1].endMs - out[1].startMs, "\"da\" é mais curta que \"mercado\"");
  assert.equal(out[4].startMs, 18150, "a frase seguinte começa onde a fala volta");
});

test("depois do ajuste, nenhuma palavra termina depois do começo da seguinte", () => {
  // vídeo real (DcigeMip-aI, 105 s): "sinta-te" volta para onde a fala recomeça e "isso," ficava por cima
  const out = snapWordsToSpeech([w("Para", 105150, 105240), w("isso,", 105240, 105610), w("sinta-te", 105610, 106080)], [{ startMs: 105200, endMs: 105460 }]);
  assert.equal(out[2].startMs, 105460);
  assert.ok(out.every((x, k) => k + 1 === out.length || x.endMs <= out[k + 1].startMs), JSON.stringify(out));
});

test("inícios repetidos pelo Whisper não desfazem o tempo das palavras da legenda", () => {
  const words = [w("que", 7080, 7100), w("na", 7080, 7210), w("verdade", 7210, 7690)];
  const seg = buildSegments([{ index: 1, startMs: 7080, endMs: 7690, text: "que na verdade", words }], {}).segments[0];
  assert.deepEqual(seg.words.map((x) => Math.round(x.inSeconds * 1000)), [7080, 7120, 7210]);
});

test("alucinação em música: pontuação repetida vira uma e palavra de 30 s não vira legenda de 30 s", () => {
  // vídeo real (MNMh30GiqaA): "bonitos!!!!…" de 56,16 s a 86,72 s
  const json = { transcription: [{ text: " e", offsets: { from: 56080, to: 56160 } }, { text: " bonitos" + "!".repeat(200), offsets: { from: 56160, to: 86720 } }, { text: " está", offsets: { from: 86820, to: 87070 } }] };
  const words = wordsFromWhisperJson(json);
  assert.deepEqual(words[1], { text: "bonitos!", startMs: 56160, endMs: 57660 });
  assert.equal(words[2].endMs - words[2].startMs, 250);
  // a que fecha um grupo espremido no mesmo instante guarda o tempo do grupo
  const squeezed = wordsFromWhisperJson({ transcription: [{ text: " lançaram", offsets: { from: 160360, to: 160360 } }, { text: " as", offsets: { from: 160360, to: 160360 } }, { text: " redes,", offsets: { from: 160360, to: 165640 } }] });
  assert.equal(squeezed[2].endMs, 165640);
});

test("aspas do Whisper em volta da frase inteira saem; aspas de uma palavra ficam", () => {
  const tok = (list) => ({ transcription: list.map((text, i) => ({ text: " " + text, offsets: { from: i * 300, to: i * 300 + 290 } })) });
  assert.deepEqual(wordsFromWhisperJson(tok(["\"Hoje", "eu", "vou", "mostrar", "importante.\"", "Depois", "vem."])).map((w) => w.text),
    ["Hoje", "eu", "vou", "mostrar", "importante.", "Depois", "vem."]);
  assert.deepEqual(wordsFromWhisperJson(tok(["durante", "a", "\"passagem\".", "Fim."])).map((w) => w.text), ["durante", "a", "\"passagem\".", "Fim."]);
  assert.deepEqual(wordsFromWhisperJson(tok(["Ele", "disse:", "\"vem", "cá\"", "e", "saiu."])).map((w) => w.text), ["Ele", "disse:", "\"vem", "cá\"", "e", "saiu."]);
});

test("pré-treino e professor Carlos não se dividem", () => {
  const json = { transcription: [" eu", " vou", " tomar", " um", " pré-", " treino", " hoje"].map((text, i) => ({ text, offsets: { from: i * 300, to: i * 300 + 290 } })) };
  const words = wordsFromWhisperJson(json);
  assert.deepEqual(words.map((x) => x.text), ["eu", "vou", "tomar", "um", "pré-treino", "hoje"]);
  const names = "Parabenizo toda a equipe da escola, professor Carlos, fico feliz".split(" ").map((t, i) => w(t, i * 300, i * 300 + 290));
  const segs = buildSegments([{ index: 1, startMs: 0, endMs: 3290, text: names.map((x) => x.text).join(" "), words: names }], { maxWords: 2 }).segments;
  assert.ok(segs.some((s) => s.text === "professor Carlos,"), segs.map((s) => s.text).join(" | "));
});

test("palavra que começa no meio do silêncio e atravessa a volta da fala começa onde a fala volta", () => {
  // Roteiro 4 (fx-3, 20/10): "aliada" 1,1 s dentro do silêncio ficava inteira nele e o corte da pausa a levava
  const words = [w("ser", 37000, 37600), w("uma", 37600, 38100), w("aliada", 38130, 39340), w("da", 39340, 39400), w("sua", 39400, 40000)];
  const out = snapWordsToSpeech(words, [{ startMs: 37740, endMs: 39220 }]);
  assert.ok(out[2].startMs >= 39220, "aliada: " + out[2].startMs);
  assert.ok(out[2].endMs > out[2].startMs && out[2].endMs <= out[3].startMs);
});

test("palavras inteiras na pausa logo antes da volta da fala vão para a volta; com ponto final ficam", () => {
  // Roteiro 4 (fx-3): "e quando existe uma alteração" dito na volta da fala (71,0 s)
  const words = [w("mental.", 66700, 67700), w("quando", 67900, 69600), w("existe", 69600, 70300), w("uma", 70300, 70800), w("alteração", 70800, 72600)];
  const out = snapWordsToSpeech(words, [{ startMs: 67750, endMs: 71000 }]);
  assert.ok(out[1].startMs >= 71000, "quando: " + out[1].startMs);
  for (let i = 2; i < out.length; i += 1) assert.ok(out[i].startMs > out[i - 1].startMs && out[i].endMs > out[i].startMs);
  assert.ok(out[4].endMs <= 72600);
  // "excesso" inteira na pausa, "de" atravessando a volta
  const ex = snapWordsToSpeech([w("o", 62000, 62400), w("excesso", 62910, 63800), w("de", 63800, 64100)], [{ startMs: 62540, endMs: 63880 }]);
  assert.ok(ex[1].startMs >= 63880 && ex[2].startMs > ex[1].startMs);
  // 2.MOV: "conseguia pescar." no meio de 6,5 s de pausa é fim de frase atrasado, não vai para a volta
  const end = snapWordsToSpeech([w("ninguém", 154500, 155000), w("conseguia", 156850, 159790), w("pescar.", 159790, 161290), w("acreditando", 162660, 163300)],
    [{ startMs: 156120, endMs: 162660 }]);
  assert.ok(end[1].startMs < 162660 && end[2].startMs < 162660);
  // Roteiro 4: "bem com melhores resultados," ditos antes da pausa (o medium põe em 173-175 s); a que
  // atravessa tem vírgula, então o grupo é fim de frase atrasado e volta para antes da pausa
  const late = snapWordsToSpeech([w("funcionar", 175240, 176630), w("bem", 176630, 177070), w("com", 177070, 177740), w("melhores", 177740, 178810),
    w("resultados,", 178810, 180460), w("conseguindo", 180460, 180900)], [{ startMs: 175750, endMs: 179080 }]);
  assert.ok(late.slice(1, 5).every((x) => x.startMs < 175750), late.map((x) => x.startMs).join(" "));
});

test("palavra estimada encaixada na volta da fala deixa de ser estimada (a frase regravada depois da pausa sai)", () => {
  // bruto da cliente 1 (20/10): "Não pergunte apenas..." largada e regravada depois de 3 s de pausa, as duas
  // com o tempo espalhado; a trava de tempo não deixava cortar a primeira
  const { findRetakes } = require("../src/core/captions/disfluency.js");
  const est = (text, startMs, endMs) => Object.assign(w(text, startMs, endMs), { estimated: true });
  const words = [w("Certo.", 9000, 9600), est("Não", 10000, 10300), est("pergunte", 10300, 10600), est("apenas", 10600, 10900), est("isso.", 10900, 11500),
    est("Não", 12300, 12600), est("pergunte", 12800, 13100), est("apenas", 13100, 13400), est("aquilo.", 13400, 14000)];
  const out = snapWordsToSpeech(words, [{ startMs: 11600, endMs: 12500 }]);
  assert.equal(out[5].startMs, 12500);
  assert.equal(out[5].estimated, undefined, "o começo veio do áudio");
  assert.ok(out[4].estimated && out[6].estimated, "as outras continuam estimadas");
  const r = findRetakes(out);
  assert.equal(r.length, 1);
  assert.equal(r[0].startMs, 10000 - 40, "pega 40 ms antes da palavra que sai");
  assert.equal(r[0].endMs, 12500 - 120, "acaba com o respiro antes da tomada que fica");
});

test("o ajuste pelo áudio não perde o quiet da 2ª escuta (o Autocorte poupa a frase baixa por ele)", () => {
  // painel: transcribeWav -> snapToSpeech -> palavra com quiet; sem ele, o keepQuietWords não poupava nada
  const q = (text, startMs, endMs) => Object.assign(w(text, startMs, endMs), { quiet: true });
  const out = snapWordsToSpeech([w("Olá", 0, 300), q("frase", 6100, 6300), q("baixa", 6300, 6700)], [{ startMs: 400, endMs: 6000 }]);
  assert.deepEqual(out.map((x) => [x.text, x.startMs, !!x.quiet]), [["Olá", 0, false], ["frase", 6000, true], ["baixa", 6300, true]]);
});

test("palavras espremidas no mesmo instante: o tempo se espalha e fica marcado como estimado", () => {
  // cliente 2, bruto 2: 7 palavras em 160,36 s com duração zero e "redes," levando 160,36-165,64 s
  const text = "pescar. Eles acreditando que teriam sorte, lançaram as redes, lançaram".split(" ");
  const words = text.map((t, i) => (i === 0 ? w(t, 149250, 150960) : i <= 8 ? w(t, 160360, i === 8 ? 165640 : 160360) : w(t, 165640, 166540)));
  const out = spreadCollapsed(words);
  const run = out.slice(1, 9);
  assert.ok(run.every((x) => x.estimated));
  assert.equal(run[0].startMs, 160360);
  assert.equal(run[7].endMs, 165640);
  for (let i = 1; i < run.length; i += 1) assert.ok(run[i].startMs > run[i - 1].startMs);
  assert.ok(run[1].endMs - run[1].startMs > run[3].endMs - run[3].startMs, "palavra maior, mais tempo");
  assert.equal(out[0].estimated, undefined);
  assert.equal(out[9].startMs, 165640);
  // o ajuste pelo áudio guarda a marca
  assert.ok(snapWordsToSpeech(words, []).slice(1, 9).every((x) => x.estimated));
  // sem nada para dividir (tudo zerado e sem próxima palavra): ritmo de fala
  const tail = spreadCollapsed([w("a", 1000, 1000), w("b", 1000, 1000)]);
  assert.deepEqual(tail.map((x) => x.startMs), [1000, 1250]);
});

test("frase inteira atrasada pelo Whisper numa pausa longa com um estalo no meio volta para o trecho de fala de antes", () => {
  // 2.MOV (fx-3): "nada, ninguém conseguia pescar." dito em 150,8–152,6 s; o Whisper pôs ~4 s depois, numa pausa
  // de 152,59 a 162,66 s cortada por um estalo de 90 ms em 156,03 s
  const silences = [{ startMs: 150240, endMs: 150790 }, { startMs: 152590, endMs: 156030 }, { startMs: 156120, endMs: 162660 }];
  const out = snapWordsToSpeech([w("estava", 148720, 151580), w("dando", 151580, 152410), w("nada,", 152410, 154460), w("ninguém", 154460, 156850),
    w("conseguia", 156850, 159790), w("pescar.", 159790, 161290), w("acreditando", 162840, 163740)], silences);
  for (const x of out.slice(1, 6)) assert.ok(x.startMs >= 150790 && x.endMs <= 152590, x.text + " " + x.startMs + "-" + x.endMs + " fora da fala de 150,79–152,59 s");
  assert.ok(out.slice(1, 6).every((x) => x.estimated));
  assert.deepEqual(out.map((x) => x.text), ["estava", "dando", "nada,", "ninguém", "conseguia", "pescar.", "acreditando"]);
  assert.equal(out[6].startMs, 162660, "a frase seguinte começa onde a fala volta");
  // pausa curta dos dois lados não é estalo: as duas continuam separadas (a palavra no meio é fala)
  const short = snapWordsToSpeech([w("é", 1520, 1600), w("isso", 1600, 2400)], [{ startMs: 900, endMs: 1500 }, { startMs: 1560, endMs: 3000 }]);
  assert.equal(short[0].startMs, 1500, "começa na volta da fala de 1,5 s (juntando as pausas, iria para 3 s)");
});

test("palavra que contém uma pausa inteira termina onde a pausa começa (não some no corte da pausa)", () => {
  // 2.MOV (fx-3): "lançaram as redes, mas ela voltou vazia"; o Whisper esticou "redes," sobre 690 ms de silêncio
  // até o "mas", e o corte dessa pausa levava a palavra (o meio dela caía no corte)
  const silences = [{ startMs: 164920, endMs: 165710 }, { startMs: 167300, endMs: 167990 }];
  const out = snapWordsToSpeech([w("Lançaram", 164980, 166500), w("as", 166500, 166880), w("redes,", 166880, 168170), w("mas", 168170, 168400), w("ela", 168400, 168600)], silences);
  const redes = out[2];
  assert.equal(redes.endMs, 167300, "termina quando a pausa começa");
  assert.ok(redes.startMs < redes.endMs && redes.startMs >= out[1].startMs);
  assert.equal(out[3].startMs, 167990, "\"mas\" começa na volta da fala");
  // pausa curta (< 300 ms) dentro da palavra fica (consoante, respiro)
  const short = snapWordsToSpeech([w("estresse", 1000, 2000)], [{ startMs: 1400, endMs: 1600 }]);
  assert.equal(short[0].endMs, 2000);
});

test("palavra na pausa curta antes de uma com vírgula vai para a volta da fala (vírgula do meio da frase)", () => {
  // Roteiro 4 (fx-3): "Se você é empresário," com o "é" posto num respiro de 0,78 s; a regra do fim de frase
  // atrasado (pontuação na que atravessa) o deixava no silêncio e o corte o levava: "Se você empresário"
  const out = snapWordsToSpeech([w("Se", 11990, 12040), w("você", 12040, 12200), w("é", 12470, 12760), w("empresário,", 12760, 14050), w("executivo,", 14050, 14950)],
    [{ startMs: 12200, endMs: 12980 }]);
  assert.ok(out[2].startMs >= 12980, "é em " + out[2].startMs);
  assert.ok(out[3].startMs > out[2].startMs && out[3].endMs <= 14050);
});

test("palavra no começo de uma pausa longa vai para o vão de fala sem palavra antes da seguinte (bug 10)", () => {
  // 2.MOV (reel:check, 21/10): "Lançaram" no começo de 5,7 s de pausa; a fala volta em 175,43 e "pela" só em 176,80
  const words = [w("voltou", 168590, 169090), w("vazia.", 169090, 169850), w("Lançaram", 169850, 171350), w("pela", 176800, 177040), w("segunda", 177040, 177500)];
  const out = snapWordsToSpeech(words, [{ startMs: 169550, endMs: 175430 }]);
  assert.ok(out[2].startMs >= 175430 && out[2].endMs <= 176800, "Lançaram: " + out[2].startMs + "-" + out[2].endMs);
  assert.equal(out[3].startMs, 176800, "a seguinte fica");
  // como no áudio de verdade: um estalo de 90 ms e mais 370 ms de pausa antes da volta
  const click = snapWordsToSpeech(words, [{ startMs: 169550, endMs: 175430 }, { startMs: 175520, endMs: 175890 }]);
  assert.ok(click[2].startMs >= 175890 && click[2].endMs <= 176800, "Lançaram: " + click[2].startMs + "-" + click[2].endMs);
  // 1.MOV: "contar" na pausa de 95,78 a 101,52 s, "essa" em 102,28
  const c = snapWordsToSpeech([w("pena", 95130, 97340), w("contar", 97340, 98840), w("essa", 102280, 102870)], [{ startMs: 95780, endMs: 101520 }]);
  assert.ok(c[1].startMs >= 101520 && c[1].endMs <= 102280, "contar: " + c[1].startMs + "-" + c[1].endMs);
  // com outra pausa no vão (a fala não voltou de vez), ou vão longo demais (frase perdida inteira): fica
  const two = snapWordsToSpeech([w("x.", 0, 500), w("E", 69610, 71110), w("depois", 76500, 77000)], [{ startMs: 67510, endMs: 73130 }, { startMs: 73270, endMs: 75520 }]);
  assert.ok(two[1].startMs < 73130, "E: " + two[1].startMs);
  const far = snapWordsToSpeech([w("x.", 0, 500), w("Lançaram", 169850, 171350), w("pela", 179000, 179500)], [{ startMs: 169550, endMs: 175430 }]);
  assert.ok(far[1].startMs < 175430);
});

test("palavra numa pausa longa sem espaço até o fim da seguinte divide com as próximas (\"Mas havia um\")", () => {
  // 2.MOV (fx-3): "Mas" posto numa pausa de 8,3 s; "havia" atravessa a volta da fala e só tem 130 ms depois dela
  const out = snapWordsToSpeech([w("Paraíba.", 131530, 132520), w("Mas", 139040, 139710), w("havia", 139710, 140830), w("um", 140830, 141900), w("grande", 141900, 142630)],
    [{ startMs: 132350, endMs: 140700 }]);
  assert.ok(out[1].startMs >= 140700, "Mas em " + out[1].startMs);
  assert.ok(out[1].endMs <= out[2].startMs && out[2].endMs <= out[3].startMs && out[3].endMs <= 141900);
  assert.equal(out[4].startMs, 141900, "a de depois fica");
});
