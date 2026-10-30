// Letras do Jota (render.js: letterLayout, drawLetter, letreiro): a disposição, o destaque que só entra quando é
// falado e a palavra 3D parada que vira uma imagem guardada.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function load() {
  const core = Object.assign({}, require("../src/core/captions/frames.js"), require("../src/core/captions/compose.js"));
  const self = { AppLegendasCore: core };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/adobe/cep/js/services/render.js"), "utf8"), { self, require });
  return self.AppLegendasRender;
}

// contexto 2D de mentira: anota as chamadas; a largura do texto é 0,6 do tamanho da fonte por letra
function fakeCtx(log) {
  const ctx = {
    log,
    measureText(t) { return { width: String(t).length * 0.6 * Number((/([\d.]+)px/.exec(ctx.font) || [0, 10])[1]) }; },
    createLinearGradient() { return { addColorStop() {} }; },
  };
  ["fillText", "strokeText", "fillRect", "drawImage", "translate"].forEach((name) => {
    ctx[name] = (...args) => log.push([name].concat(args));
  });
  ["clearRect", "strokeRect", "save", "restore", "rotate", "scale", "beginPath", "rect", "clip", "moveTo", "lineTo", "stroke"].forEach((name) => {
    ctx[name] = () => {};
  });
  return ctx;
}
function canvasOf(ctx, doc) {
  return { width: 1080, height: 1920, getContext: () => ctx, ownerDocument: doc };
}
const WORDS = ["eu", "ganhei", "dinheiro", "rápido"];
const KEYS = [false, false, true, false];
const STARTS = [0, 0.3, 0.6, 0.9];

test("letras do Jota: frase em cima e embaixo, destaque no meio, só depois de falado", () => {
  const render = load();
  const style = Object.assign({ preset: "jotaMarker" }, render.PRESETS.jotaMarker);
  const log = [];
  render.drawFrame(canvasOf(fakeCtx(log)), { words: WORDS, keys: KEYS, active: 3, starts: STARTS }, style, { ageSeconds: 3, elapsed: 4 });
  const y = (w) => log.filter((c) => c[0] === "fillText" && c[1] === w).map((c) => c[3]);
  assert.equal(y("eu").length, 3, "a frase com o halo (duas vezes) e a letra");
  assert.equal(y("dinheiro").length, 1, "o destaque inteiro de uma vez, no marca-texto");
  assert.ok(y("eu")[0] < y("dinheiro")[0] && y("dinheiro")[0] < y("rápido")[0], "eu ganhei / dinheiro / rápido");
  assert.equal(log.filter((c) => c[0] === "fillRect").length, 2, "a faixa com o halo");

  // a 2ª palavra sendo falada: o destaque ainda não entrou
  const before = [];
  render.drawFrame(canvasOf(fakeCtx(before)), { words: WORDS, keys: KEYS, active: 1, starts: STARTS }, style, { ageSeconds: 0.1, elapsed: 0.4 });
  assert.ok(!before.some((c) => c[1] === "dinheiro") && !before.some((c) => c[0] === "fillRect"));

  // --sem-halo (app): a faixa sai uma vez só e a frase sem o halo
  const plain = [];
  render.drawFrame(canvasOf(fakeCtx(plain)), { words: WORDS, keys: KEYS, active: 3, starts: STARTS }, Object.assign({}, style, { halo: false }), { ageSeconds: 3, elapsed: 4 });
  assert.equal(plain.filter((c) => c[0] === "fillRect").length, 1);
  assert.equal(plain.filter((c) => c[0] === "fillText" && c[1] === "eu").length, 1);
});

test("letras do Jota: o destaque maior deixa mais folga; legenda sem destaque usa a palavra mais longa", () => {
  const render = load();
  const gap = (id) => {
    const log = [];
    render.drawFrame(canvasOf(fakeCtx(log)), { words: WORDS, keys: KEYS, active: 3, starts: STARTS }, Object.assign({ preset: id }, render.PRESETS[id]), { ageSeconds: 3, elapsed: 4 });
    const y = (w) => log.find((c) => c[0] === "fillText" && c[1] === w)[3];
    return y("rápido") - y("eu");
  };
  assert.ok(gap("jotaSerif") > gap("jotaMarker"), "a serifa editorial é 1,25x o tamanho");
  const whole = (words) => {
    const log = [];
    render.drawFrame(canvasOf(fakeCtx(log)), { words, active: words.length - 1, starts: words.map((w, i) => i * 0.3) }, Object.assign({ preset: "jotaMarker" }, render.PRESETS.jotaMarker), { ageSeconds: 3, elapsed: 4 });
    return log.filter((c) => c[0] === "fillText" && c[2] === 540).map((c) => c[1]); // o marca-texto desenha no meio
  };
  assert.deepEqual(whole(WORDS), ["dinheiro"]);
  assert.deepEqual(whole(["isso", "muda", "tudo!"]), ["tudo!"], "empate: a última");
});

test("letras do Jota: 3D parado vira imagem guardada; entrando, desenha letra por letra", () => {
  const render = load();
  const style = Object.assign({ preset: "jotaSticker" }, render.PRESETS.jotaSticker);
  const made = [];
  const doc = { createElement() { const log = []; const c = { getContext: () => fakeCtx(log), log }; made.push(c); return c; } };
  const frame = { words: WORDS, keys: KEYS, active: 3, starts: STARTS };
  const draw = (elapsed) => {
    const log = [];
    render.drawFrame(canvasOf(fakeCtx(log), doc), frame, style, { ageSeconds: elapsed - 0.9, elapsed });
    return log;
  };
  const letters = (log) => log.filter((c) => c[0] === "fillText" && "dinheiro".includes(c[1]) && c[1].length === 1).length;

  const entering = draw(0.8); // o destaque entrou em 0,6 s: as letras ainda chegando da direita
  assert.ok(letters(entering) > 8 && !entering.some((c) => c[0] === "drawImage"));
  assert.equal(made.length, 0);

  const still = draw(3);
  assert.equal(made.length, 1, "uma imagem para a palavra parada");
  assert.ok(letters(made[0].log) > 8 * 20, "contorno, extrusão e face desenhados nela");
  assert.equal(letters(still), 0);
  const image = still.filter((c) => c[0] === "drawImage");
  assert.equal(image.length, 1);
  assert.ok(Number.isInteger(image[0][2]) && Number.isInteger(image[0][3]), "no pixel inteiro: não borra quando para");

  const again = draw(3.5);
  assert.equal(made.length, 1, "o quadro seguinte reaproveita a mesma imagem");
  assert.equal(again.filter((c) => c[0] === "drawImage")[0][1], image[0][1]);
});

test("letras do Jota: palavra 3D comprida cabe na largura", () => {
  const render = load();
  const style = Object.assign({ preset: "jotaSticker" }, render.PRESETS.jotaSticker, { motion: "none" });
  const log = [];
  const word = "inconstitucionalmente";
  render.drawFrame(canvasOf(fakeCtx(log)), { words: [word], keys: [true], active: 0 }, style);
  // sem tela para guardar a imagem: a face de cada letra é o último translate dela (x relativo ao meio)
  const faces = log.filter((c) => c[0] === "translate").slice(-word.length).map((c) => c[1]);
  assert.equal(faces.length, word.length);
  assert.ok(Math.max(...faces) - Math.min(...faces) <= 1080 * 0.86, "de " + Math.min(...faces) + " a " + Math.max(...faces));
});
