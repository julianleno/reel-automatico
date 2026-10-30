const test = require("node:test");
const assert = require("node:assert/strict");
const { speakerTurns, shiftTurns } = require("../src/core/audio/speakers.js");

// Dois microfones, 10 ms por janela. Quem fala: -18 dB no próprio microfone e -33 no do outro
// (vazamento); sílabas com pausas curtas; silêncio de fundo em -60.
function podcast(script, seconds) {
  const n = seconds * 100;
  const mics = [new Array(n).fill(-60), new Array(n).fill(-60)];
  for (const [who, from, to] of script) {
    for (let i = from * 100; i < to * 100; i += 1) {
      if (i % 25 >= 18) continue; // pausa entre sílabas
      mics[who][i] = -18;
      mics[1 - who][i] = Math.max(mics[1 - who][i], -33);
    }
  }
  return mics;
}

test("quem fala: troca a vez em cada fala longa, ignora o aham no meio e a pausa", () => {
  const mics = podcast([[0, 0.5, 6], [1, 3, 3.4], [1, 7, 14], [0, 14.5, 20]], 20);
  const turns = speakerTurns(mics, 10);
  assert.deepEqual(turns.map((t) => t.track), [0, 1, 0]);
  assert.equal(turns[0].startMs, 0);
  assert.ok(Math.abs(turns[1].startMs - 7000) <= 50, "B começa em 7 s: " + turns[1].startMs);
  assert.ok(Math.abs(turns[2].startMs - 14500) <= 50, "A volta em 14,5 s: " + turns[2].startMs);
  assert.equal(turns[2].endMs, 20000);
});

test("quem fala: três microfones, fala por cima curta e microfone mais baixo que os outros", () => {
  // C fala mais baixo no próprio microfone (-24), mas ainda bem acima do vazamento dos outros
  const n = 3000;
  const mics = [0, 1, 2].map(() => new Array(n).fill(-60));
  const talk = (who, from, to, level) => {
    for (let i = from * 100; i < to * 100; i += 1) {
      if (i % 25 >= 18) continue;
      mics[who][i] = Math.max(mics[who][i], level);
      for (const o of [0, 1, 2]) if (o !== who) mics[o][i] = Math.max(mics[o][i], level - 15);
    }
  };
  talk(0, 0, 8, -18);
  talk(1, 7.5, 8.5, -18); // B entra por cima no fim da fala de A, por 1 s: não troca
  talk(2, 10, 20, -24);
  talk(1, 21, 30, -18);
  const turns = speakerTurns(mics, 10);
  assert.deepEqual(turns.map((t) => t.track), [0, 2, 1]);
  assert.ok(Math.abs(turns[1].startMs - 10000) <= 50 && Math.abs(turns[2].startMs - 21000) <= 50, JSON.stringify(turns));
});

test("quem fala: silêncio total não inventa vez", () => {
  assert.deepEqual(speakerTurns([new Array(500).fill(-90), new Array(500).fill(-90)], 10), []);
});

test("shiftTurns: J-cut atrasa a troca, L-cut adianta; vez curta demais não muda", () => {
  const turns = [{ startMs: 0, endMs: 2000, track: 0 }, { startMs: 2000, endMs: 5000, track: 1 }, { startMs: 5000, endMs: 5200, track: 0 }];
  const j = shiftTurns(turns, 300);
  assert.deepEqual([j[0].endMs, j[1].startMs], [2300, 2300]);
  assert.deepEqual([j[1].endMs, j[2].startMs], [5000, 5000]); // a última ficaria com 0 s: fica
  const l = shiftTurns(turns, -300);
  assert.deepEqual([l[0].endMs, l[1].startMs, l[1].endMs, l[2].startMs], [1700, 1700, 4700, 4700]);
  assert.equal(turns[1].startMs, 2000); // não mexe na lista de entrada
});
