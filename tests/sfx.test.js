const test = require("node:test");
const assert = require("node:assert/strict");
const { wordTimes, sfxSlots } = require("../src/core/captions/sfx.js");

test("um clique por palavra, na ordem da fala", () => {
  const segs = [
    { words: [{ text: "Oi", inSeconds: 0.2 }, { text: "pessoal,", inSeconds: 0.48 }] },
    { words: [{ text: "então,", inSeconds: 1.3 }] },
  ];
  assert.deepEqual(wordTimes(segs), [0.2, 0.48, 1.3]);
});

test("som seguinte apara o anterior; no mesmo quadro fica sem som", () => {
  const slots = sfxSlots([1.0, 0.0, 0.05, 1.02, 2], { seconds: 0.12, minSeconds: 1 / 24 });
  assert.deepEqual(slots.map((s) => [s.inSeconds, Number(s.outSeconds.toFixed(3))]), [
    [0, 0.05],
    [0.05, 0.17],
    [1, 1.12],
    [2, 2.12],
  ]);
  // lead: o whoosh começa antes para o pico cair na palavra, nunca antes de 0
  assert.deepEqual(sfxSlots([0.2, 3], { lead: 0.35, seconds: 0.5 }).map((s) => s.inSeconds), [0, 2.65]);
});

// snap.wav e tick-soft.wav ficaram mudos de 16/10 a 22/10 (o corte no ataque caiu depois do som): nenhum som
// do app pode ser só silêncio
test("sons do app: nenhum arquivo mudo (pico acima de -20 dB)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = path.join(__dirname, "../src/adobe/cep/sfx");
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith(".wav"))) {
    const buf = fs.readFileSync(path.join(dir, name));
    const at = buf.indexOf("data") + 8;
    let peak = 0;
    for (let i = at; i + 1 < buf.length; i += 2) peak = Math.max(peak, Math.abs(buf.readInt16LE(i)));
    assert.ok(peak / 32768 > 0.1, name + ": pico " + (20 * Math.log10(peak / 32768 || 1e-9)).toFixed(1) + " dB");
  }
});
