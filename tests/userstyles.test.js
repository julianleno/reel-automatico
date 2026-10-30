const test = require("node:test");
const assert = require("node:assert/strict");
const { cleanUserStyles, upsertUserStyles } = require("../src/core/captions/userstyles.js");

const FIELDS = ["preset", "fontFamily", "fontSize", "highlight"];
const PRESETS = { clean: {}, compose: {} };

test("meus estilos: importação só aceita campos conhecidos, valores simples e base existente", () => {
  const list = cleanUserStyles(
    [
      { name: "  Cliente   X ", style: { preset: "compose", fontFamily: "Poppins", fontSize: 120, highlight: true, evil: "x", fontSize2: 1 } },
      { name: "Sem base", style: { preset: "nao-existe" } },
      { name: "", style: { preset: "clean" } },
      { name: "Objeto", style: { preset: "clean", fontFamily: { toString: 1 }, fontSize: Infinity } },
      null,
    ],
    FIELDS,
    PRESETS,
  );
  assert.deepEqual(list, [
    { name: "Cliente X", style: { preset: "compose", fontFamily: "Poppins", fontSize: 120, highlight: true } },
    { name: "Objeto", style: { preset: "clean" } },
  ]);
  assert.deepEqual(cleanUserStyles("lixo", FIELDS, PRESETS), []);
});

test("meus estilos: mesmo nome substitui, nome novo entra no fim", () => {
  const a = { name: "Jota", style: { preset: "compose" } };
  const b = { name: "Cliente", style: { preset: "clean" } };
  const merged = upsertUserStyles([a, b], [{ name: "JOTA", style: { preset: "clean" } }, { name: "Novo", style: { preset: "clean" } }]);
  assert.deepEqual(merged.map((s) => s.name), ["JOTA", "Cliente", "Novo"]);
  assert.equal(merged[0].style.preset, "clean");
});
