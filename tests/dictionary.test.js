const test = require("node:test");
const assert = require("node:assert/strict");
const { parseCorrections, applyCorrections } = require("../src/core/captions/dictionary.js");

test("parseCorrections: uma por linha, com =, -> ou →; linhas inválidas ignoradas", () => {
  const e = parseCorrections("jota = Jota\nbom jardim -> Bom Jardim\n\nsem sinal\nwhite House → Casa Branca");
  assert.deepEqual(e, [
    { from: ["jota"], to: "Jota" },
    { from: ["bom", "jardim"], to: "Bom Jardim" },
    { from: ["white", "house"], to: "Casa Branca" },
  ]);
});

test("applyCorrections mantém o quiet da frase baixa da 2ª escuta (o Autocorte do painel a protege por ele)", () => {
  const items = [{ index: 1, startMs: 0, endMs: 900, text: "como a escola", words: [
    { text: "como", startMs: 0, endMs: 300, quiet: true }, { text: "a", startMs: 300, endMs: 500, quiet: true }, { text: "escola", startMs: 500, endMs: 900, quiet: true }] }];
  assert.deepEqual(applyCorrections(items, parseCorrections("escola = Escola")).items[0].words.map((w) => [w.text, !!w.quiet]), [["como", true], ["a", true], ["Escola", true]]);
});

test("applyCorrections troca palavra inteira, ignora maiúsculas e mantém a pontuação e o tempo", () => {
  const items = [
    {
      index: 1, startMs: 0, endMs: 1200, text: "o jota foi no bom jardim.",
      words: [
        { text: "o", startMs: 0, endMs: 200 }, { text: "jota", startMs: 200, endMs: 400 },
        { text: "foi", startMs: 400, endMs: 600 }, { text: "no", startMs: 600, endMs: 800 },
        { text: "bom", startMs: 800, endMs: 1000 }, { text: "jardim.", startMs: 1000, endMs: 1200 },
      ],
    },
  ];
  const r = applyCorrections(items, parseCorrections("jota = Jota\nbom jardim = Bom Jardim"));
  assert.equal(r.count, 2);
  assert.equal(r.items[0].text, "o Jota foi no Bom Jardim.");
  assert.deepEqual(r.items[0].words.slice(4).map((w) => [w.text, w.startMs, w.endMs]), [["Bom", 800, 1000], ["Jardim.", 1000, 1200]]);
  // o original não muda
  assert.equal(items[0].words[1].text, "jota");
  // "jotas" não é "jota"
  assert.equal(applyCorrections([{ text: "jotas" }], parseCorrections("jota = Jota")).count, 0);
});

test("nº de palavras diferente junta o trecho numa palavra com o tempo do trecho todo", () => {
  const items = [{ startMs: 0, endMs: 900, text: "falou com white house hoje", words: "falou com white house hoje".split(" ").map((t, i) => ({ text: t, startMs: i * 100, endMs: i * 100 + 100 })) }];
  const r = applyCorrections(items, parseCorrections("white house = Casa Branca dos EUA"));
  assert.equal(r.items[0].text, "falou com Casa Branca dos EUA hoje");
  assert.deepEqual(r.items[0].words.map((w) => w.text), ["falou", "com", "Casa Branca dos EUA", "hoje"]);
  assert.deepEqual([r.items[0].words[2].startMs, r.items[0].words[2].endMs], [200, 400]);
  // legenda sem tempo por palavra (SRT) também troca
  assert.equal(applyCorrections([{ text: "Oi jota, tudo bem?" }], parseCorrections("jota = Jota")).items[0].text, "Oi Jota, tudo bem?");
});

test("nome solto troca as grafias parecidas, sem mexer em palavra curta nem no que já está certo", () => {
  const dict = parseCorrections("Guaratinguetá\nInstagram\nPorto\nEscola\nClientes");
  assert.deepEqual(dict[0], { from: ["guaratingueta"], to: "Guaratinguetá", near: true });
  assert.equal(parseCorrections("Nomes:")[0].to, "Nomes");
  assert.equal(applyCorrections([{ text: "vim de guaratinguetá." }], dict).items[0].text, "vim de Guaratinguetá.");
  // palavra comum perto de um nome curto ou só no plural fica como está (medido em fala real)
  const items = [{ text: "Em Guaratingheta, guaratingueta e Guaratinguetá. No instagran, a porta do Porto, a escolha e o cliente.", startMs: 0, endMs: 9000 }];
  const r = applyCorrections(items, dict);
  assert.equal(r.items[0].text, "Em Guaratinguetá, Guaratinguetá e Guaratinguetá. No Instagram, a porta do Porto, a escolha e o cliente.");
  assert.equal(r.count, 3);
  // com tempo por palavra, o tempo continua o mesmo
  const timed = [{ text: "oi guaratingeta", startMs: 0, endMs: 900, words: [{ text: "oi", startMs: 0, endMs: 300 }, { text: "guaratingeta", startMs: 300, endMs: 900 }] }];
  assert.deepEqual(applyCorrections(timed, dict).items[0].words[1], { text: "Guaratinguetá", startMs: 300, endMs: 900 });
});
