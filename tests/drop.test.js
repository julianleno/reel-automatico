const test = require("node:test");
const assert = require("node:assert/strict");
const { analyzeMusic, placeDrop } = require("../src/core/audio/drop.js");

const SR = 22050;

// kick: seno de 60 caindo para 40 Hz, decaindo em ~120 ms; começa em `at` (fase 0)
function kick(x, at, amp) {
  const i0 = Math.round(at * SR);
  for (let k = 0; k < SR * 0.4 && i0 + k < x.length; k += 1) {
    const t = k / SR;
    x[i0 + k] += amp * Math.exp(-t / 0.12) * Math.sin(2 * Math.PI * (40 * t + 20 * 0.05 * (1 - Math.exp(-t / 0.05))));
  }
}

// música sintética: acorde (440 + 660 Hz) e chimbal (chiado curto) o tempo todo; kicks a 120 BPM a partir de `from`
function song(seconds, from, seed = 3) {
  const x = new Float32Array(seconds * SR);
  for (let i = 0; i < x.length; i += 1) {
    seed = (seed * 16807) % 2147483647;
    const t = i / SR;
    x[i] = 0.08 * Math.sin(2 * Math.PI * 440 * t) + 0.05 * Math.sin(2 * Math.PI * 660 * t) +
      (t % 0.25 < 0.02 ? 0.06 * (seed / 1073741823.5 - 1) : 0);
  }
  for (let t = from; t < seconds - 0.4; t += 0.5) kick(x, t, 0.8);
  return x;
}

test("drop: kicks em grade dão 120 BPM e as batidas caem nos golpes", () => {
  const m = analyzeMusic(song(20, 0.25), SR);
  assert.ok(Math.abs(m.bpm - 120) < 1.5, "bpm " + m.bpm);
  const truth = [];
  for (let t = 0.25; t < 19.6; t += 0.5) truth.push(t);
  const hit = truth.filter((t) => m.beats.some((b) => Math.abs(b - t) <= 0.02)).length / truth.length;
  assert.ok(hit > 0.95, "acertou " + hit);
  assert.equal(m.dur, 20);
});

test("drop: intro calma + parte densa -> o drop exato é o 1º kick (erro de poucos ms)", () => {
  const m = analyzeMusic(song(40, 8.13), SR);
  const d = m.drops.find((x) => x.exato != null && Math.abs(x.exato - 8.13) < 0.5);
  assert.ok(d, "sem drop perto de 8,13 s: " + JSON.stringify(m.drops));
  assert.ok(Math.abs(d.exato - 8.13) <= 0.01, "drop exato em " + d.exato + " (erro " + Math.round((d.exato - 8.13) * 1000) + " ms)");
  assert.ok(d.contraste >= 2, "contraste " + d.contraste);
  // partes: a intro sem grave, a parte densa com
  assert.ok(m.partes[0].grave < 0.1 && m.partes[m.partes.length - 2].grave > 0.3, JSON.stringify(m.partes));
  // o drop na 1ª palavra-chave (1,5 s do vídeo): a música começa 1,5 s antes do drop
  const p = placeDrop(m, { at: 1.5, seconds: 20 });
  assert.equal(p.drop, d);
  assert.ok(Math.abs(p.start - (d.exato - 1.5)) < 1e-9);
  // palavra-chave depois do drop: a música entra depois do 0 do vídeo (start negativo)
  assert.ok(placeDrop(m, { at: 10, seconds: 20 }).start < 0);
  // a música acaba antes do vídeo: sem drop (fica o jeito de hoje)
  assert.equal(placeDrop(m, { at: 1.5, seconds: 35 }), null);
});

test("drop: batida do começo ao fim não tem drop claro", () => {
  const m = analyzeMusic(song(30, 0.25), SR);
  assert.equal(placeDrop(m, { at: 1.5, seconds: 10 }), null, JSON.stringify(m.drops));
});

test("drop: silêncio não inventa drop nem batida", () => {
  const m = analyzeMusic(new Float32Array(10 * SR), SR);
  assert.deepEqual([m.bpm, m.beats, m.drops], [0, [], []]);
});
