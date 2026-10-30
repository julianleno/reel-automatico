// Para onde a pessoa olha (prototypes/reel-sem-premiere/olhar.js): as contas, sem Electron nem MediaPipe.
const test = require("node:test");
const assert = require("node:assert/strict");
const O = require("../prototypes/reel-sem-premiere/olhar.js");

// matrizes que a malha do rosto deu no 2.MOV (quadros-chave olhados um a um)
const FRONT = [0.9808, 0.0361, 0.1916, 0, -0.0141, 0.9932, -0.1154, 0, -0.1945, 0.1104, 0.9747, 0, -1.3105, 0.6737, -34.3574, 1]; // 3,7 s: "e memoriza essa palavra"
const FRONT2 = [0.9949, 0.0461, 0.0901, 0, -0.0312, 0.9867, -0.1594, 0, -0.0962, 0.1558, 0.9831, 0, -11.8584, 8.6286, -33.9286, 1]; // 108,3 s
const DOWN = [0.6452, -0.0729, -0.7605, 0, 0.3589, 0.9077, 0.2175, 0, 0.6744, -0.4133, 0.6118, 0, 0.0143, -0.2713, -45.949, 1]; // 104,5 s: olha o paletó
const SIDE = [0.7347, -0.1915, -0.6508, 0, 0.3354, 0.9364, 0.1032, 0, 0.5897, -0.2941, 0.7522, 0, 10.4391, -6.2684, -33.6554, 1]; // 62,5 s: "Tem uma palavra"

const sample = (t, m) => Object.assign({ t, face: !!m }, m ? O.pose(m) : { pitch: 0, yaw: 0 });

test("olhar: a pose sai da matriz do MediaPipe (pitch > 0 é a cabeça para baixo)", () => {
  // rotação pura de 20° no eixo x (para baixo) e de 30° no eixo y, coluna por coluna
  const a = (20 * Math.PI) / 180, b = (30 * Math.PI) / 180;
  const pitchOnly = [1, 0, 0, 0, 0, Math.cos(a), Math.sin(a), 0, 0, -Math.sin(a), Math.cos(a), 0, 0, 0, -40, 1];
  const yawOnly = [Math.cos(b), 0, -Math.sin(b), 0, 0, 1, 0, 0, Math.sin(b), 0, Math.cos(b), 0, 0, 0, -40, 1];
  assert.ok(Math.abs(O.pose(pitchOnly).pitch - 20) < 0.01);
  assert.ok(Math.abs(O.pose(yawOnly).yaw - 30) < 0.01);
  // os quadros de verdade: de frente fica dentro, olhando o paletó fica fora
  assert.equal(O.facing(sample(3.7, FRONT)), true);
  assert.equal(O.facing(sample(108.3, FRONT2)), true);
  assert.equal(O.facing(sample(104.5, DOWN)), false);
  assert.equal(O.facing(sample(62.5, SIDE)), false);
  assert.equal(O.facing(sample(63.5, null)), false); // cabeça baixa demais: nem rosto acha
});

// palavras de 300 ms, 50 ms entre elas; frases separadas por 1 s
function speech(sizes) {
  const words = [];
  const sentences = [];
  let t = 0;
  sizes.forEach((n) => {
    const from = words.length;
    for (let k = 0; k < n; k += 1) {
      words.push({ text: "p" + words.length + (k === n - 1 ? "." : ""), startMs: t, endMs: t + 300 });
      t += 350;
    }
    sentences.push({ from, to: words.length - 1 });
    t += 1000;
  });
  return { words, sentences };
}

test("olhar: a frase inteira dita sem olhar a câmera é marcada; a de frente e a curta demais não", () => {
  const { words, sentences } = speech([6, 6, 6, 2]); // 0-2,05 s; 3,05-5,1 s; 6,1-8,15 s; 9,15-9,8 s
  const samples = [
    sample(0.5, FRONT), sample(1.5, FRONT), // 1ª de frente
    sample(2.6, null), // na pausa: não conta para nenhuma
    sample(3.3, SIDE), sample(4.2, null), sample(5.0, DOWN), // 2ª: olhando o paletó
    sample(6.5, FRONT), sample(7.4, DOWN), // 3ª: metade de frente, fica
    sample(9.5, DOWN), // 4ª: uma amostra só, um piscar decidiria
    sample(11, FRONT), sample(12, FRONT), sample(13, FRONT), sample(14, FRONT),
  ];
  assert.deepEqual(O.awaySentences(sentences, words, samples), [sentences[1]]);
});

test("olhar: vídeo sem pessoa (rosto em menos da metade dos quadros) não marca nada", () => {
  const { words, sentences } = speech([6, 6]);
  const samples = [sample(0.5, null), sample(1.5, null), sample(3.3, null), sample(4.2, FRONT)];
  assert.deepEqual(O.awaySentences(sentences, words, samples), []);
  assert.deepEqual(O.awaySentences(sentences, words, []), []);
});
