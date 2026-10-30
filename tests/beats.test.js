const test = require("node:test");
const assert = require("node:assert/strict");
const { findBeats } = require("../src/core/audio/beats.js");

// Envelope de 10 ms: chiado de fundo em -40 dB e um golpe (sobe para -10 e decai) em cada batida.
function song(bpm, phaseMs, seconds, seed = 7) {
  const db = new Array(seconds * 100).fill(0).map(() => {
    seed = (seed * 16807) % 2147483647;
    return -40 + (seed / 2147483647) * 4;
  });
  const truth = [];
  for (let t = phaseMs; t < seconds * 1000; t += 60000 / bpm) {
    truth.push(t);
    const i = Math.round(t / 10);
    for (let k = 0; k < 12 && i + k < db.length; k += 1) db[i + k] = Math.max(db[i + k], -10 - k * 2.5);
  }
  return { db, truth };
}

function matched(beats, truth, tol = 20) {
  return truth.filter((t) => beats.some((b) => Math.abs(b - t) <= tol)).length / truth.length;
}

test("batidas: acha 120 BPM e cai em cima de cada golpe", () => {
  const { db, truth } = song(120, 230, 20);
  const r = findBeats(db, 10);
  assert.ok(Math.abs(r.bpm - 120) < 1.5, "bpm " + r.bpm);
  assert.ok(matched(r.beats, truth) > 0.95);
  assert.ok(r.beats.length <= truth.length + 1, "sem batidas a mais");
});

test("batidas: 95 BPM não vira o dobro nem a metade, e andamento quebrado segue a música", () => {
  const { db, truth } = song(95, 410, 30);
  const r = findBeats(db, 10);
  assert.ok(Math.abs(r.bpm - 95) < 1.5, "bpm " + r.bpm);
  assert.ok(matched(r.beats, truth) > 0.95);
  // 128 BPM fracionário (468,75 ms): a grade de 10 ms não pode escorregar
  const odd = song(128, 0, 30);
  assert.ok(matched(findBeats(odd.db, 10).beats, odd.truth) > 0.95);
});

test("batidas: andamento que acelera devagar (118 → 124 BPM) continua em cima dos golpes", () => {
  const seconds = 30;
  const db = new Array(seconds * 100).fill(-40);
  const truth = [];
  for (let t = 300; t < seconds * 1000; ) {
    truth.push(t);
    const i = Math.round(t / 10);
    for (let k = 0; k < 12 && i + k < db.length; k += 1) db[i + k] = Math.max(db[i + k], -10 - k * 2.5);
    const bpm = 118 + 6 * (t / (seconds * 1000));
    t += 60000 / bpm;
  }
  const r = findBeats(db, 10);
  assert.ok(r.bpm > 116 && r.bpm < 126, "bpm " + r.bpm);
  assert.ok(matched(r.beats, truth, 30) > 0.9, "acertou " + matched(r.beats, truth, 30));
});

test("batidas: silêncio não inventa batida", () => {
  assert.deepEqual(findBeats(new Array(2000).fill(-100), 10), { bpm: 0, beats: [] });
});
