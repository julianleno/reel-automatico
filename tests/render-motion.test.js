const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");

function motionService(drawFrame) {
  const self = { AppLegendasRender: { drawFrame } };
  const context = { self, require, setTimeout, Promise, isFinite };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/adobe/cep/js/services/render-motion.js"), "utf8"), context);
  return self.AppLegendasMotion;
}

test("o clipe animado conserva alpha, duração e troca de palavra", async (t) => {
  const bundled = path.join(__dirname, "../src/adobe/cep/bin/ffmpeg.exe");
  const ffmpeg = process.platform === "win32" && fs.existsSync(bundled) ? bundled : "ffmpeg";
  if (spawnSync(ffmpeg, ["-version"]).status !== 0 || spawnSync("ffprobe", ["-version"]).status !== 0) {
    t.skip("ffmpeg/ffprobe ausentes");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "applegendas-motion-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "legenda.mov");
  const width = 160, height = 90;
  const pixels = new Uint8ClampedArray(width * height * 4);
  const seen = [];
  const canvas = {
    width, height,
    getContext: () => ({ getImageData: () => ({ data: pixels }) }),
  };
  const motion = motionService((unused, frame) => {
    seen.push(frame.active);
    pixels.fill(0);
    for (let y = 30; y < 60; y++) {
      for (let x = 30; x < 130; x++) {
        const i = (y * width + x) * 4;
        pixels[i] = 255; pixels[i + 3] = 255;
      }
    }
  });
  const segment = {
    inSeconds: 1, outSeconds: 1.2,
    words: [{ text: "duas", inSeconds: 1 }, { text: "palavras", inSeconds: 1.1 }],
  };
  assert.equal(motion.activeAt(segment, 0.11).index, 1);
  const result = await motion.renderSegment({ ffmpegPath: ffmpeg, canvas, segment, style: { motion: "pop" }, path: file, fps: 30 });
  assert.equal(result.frames, 6);
  assert.deepEqual(seen, [0, 0, 0, 1, 1, 1]);
  const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,pix_fmt,nb_frames", "-of", "json", file], { encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  const stream = JSON.parse(probe.stdout).streams[0];
  assert.equal(stream.codec_name, "prores");
  assert.match(stream.pix_fmt, /^yuva/);
  assert.equal(Number(stream.nb_frames), 6);
  const decoded = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]);
  assert.equal(decoded.status, 0, String(decoded.stderr));
  const alphaAt = (x, y) => decoded.stdout[(y * width + x) * 4 + 3];
  assert.equal(alphaAt(0, 0), 0);
  assert.equal(alphaAt(60, 40), 255);

  // Animation (mais leve): mesmo alpha e mesma contagem de quadros
  const light = path.join(dir, "leve.mov");
  await motion.renderSegment({ ffmpegPath: ffmpeg, canvas, segment, style: { motion: "pop" }, path: light, fps: 30, codec: "qtrle" });
  const lp = JSON.parse(spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,pix_fmt,nb_frames", "-of", "json", light], { encoding: "utf8" }).stdout).streams[0];
  assert.deepEqual([lp.codec_name, lp.pix_fmt, Number(lp.nb_frames)], ["qtrle", "argb", 6]);
  const ld = spawnSync("ffmpeg", ["-v", "error", "-i", light, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]).stdout;
  assert.deepEqual([ld[3], ld[(40 * width + 60) * 4 + 3]], [0, 255]);
});

test("entrada com desfoque: começa deslocada e borrada e assenta nítida", () => {
  const self = { AppLegendasCore: require("../src/core/captions/frames.js") };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/adobe/cep/js/services/render.js"), "utf8"), { self, require, isFinite, Math, Number });
  const render = self.AppLegendasRender;
  function paint(age) {
    const calls = [];
    const ctx = {
      set filter(v) { calls.push(["filter", v]); },
      translate(x, y) { calls.push(["translate", x, y]); },
      measureText: (t) => ({ width: t.length * 60 }),
      clearRect() {}, save() {}, restore() {}, rotate() {}, scale() {}, fillText() {}, strokeText() {},
      fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, closePath() {}, fill() {}, stroke() {},
    };
    const style = Object.assign({ preset: "glide" }, render.PRESETS.glide);
    render.drawFrame({ width: 1080, height: 1920, getContext: () => ctx }, { words: ["SUA", "IDEIA"], active: 0 }, style, { ageSeconds: age });
    return calls;
  }
  const start = paint(0), end = paint(1);
  assert.ok(start.some(([k, v]) => k === "filter" && /blur\(2\d/.test(v)), "deveria começar desfocada");
  assert.ok(!end.some(([k]) => k === "filter"), "deveria terminar nítida");
  const xs = (calls) => calls.filter(([k]) => k === "translate").map(([, x]) => x);
  assert.ok(xs(start)[0] - xs(end)[0] > 100, "o bloco inteiro entra vindo da direita");
});

test("subida suave: palavras ainda não faladas ficam fora da tela", () => {
  const self = { AppLegendasCore: require("../src/core/captions/frames.js") };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/adobe/cep/js/services/render.js"), "utf8"), { self, require, isFinite, Math, Number });
  const render = self.AppLegendasRender;
  function drawn(active) {
    const texts = [];
    const ctx = {
      measureText: (t) => ({ width: t.length * 60 }),
      fillText(t) { texts.push(t); },
      clearRect() {}, save() {}, restore() {}, rotate() {}, scale() {}, translate() {}, strokeText() {},
      fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, closePath() {}, fill() {}, stroke() {},
    };
    const style = Object.assign({ preset: "lift" }, render.PRESETS.lift);
    render.drawFrame({ width: 1080, height: 1920, getContext: () => ctx }, { words: ["promoções", "de", "casa"], active }, style, { ageSeconds: 0.1 });
    return texts;
  }
  assert.deepEqual(drawn(-1), []);
  assert.deepEqual(drawn(0), ["promoções"]);
  assert.deepEqual(drawn(2), ["promoções", "de", "casa"]);
});

test("composição: linhas com tamanhos diferentes e palavra revelada ao ser falada", () => {
  const self = { AppLegendasCore: Object.assign({}, require("../src/core/captions/frames.js"), require("../src/core/captions/compose.js")) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/adobe/cep/js/services/render.js"), "utf8"), { self, require, isFinite, Math, Number, String });
  const render = self.AppLegendasRender;
  function drawn(active) {
    const out = [];
    const ctx = {
      font: "",
      measureText(t) { return { width: t.length * parseInt(this.font.split(" ")[1], 10) * 0.6 }; },
      fillText(t) { out.push([t, parseInt(this.font.split(" ")[1], 10), this.fillStyle]); },
      clearRect() {}, save() {}, restore() {}, rotate() {}, scale() {}, translate() {}, strokeText() {},
    };
    const style = Object.assign({ preset: "compose" }, render.PRESETS.compose);
    render.drawFrame({ width: 1080, height: 1920, getContext: () => ctx }, { words: ["Se", "gostou", "desse", "vídeo,"], active }, style, { ageSeconds: 1 });
    return out;
  }
  assert.deepEqual(drawn(1).map((d) => d[0]), ["Se", "gostou"]);
  const all = drawn(3);
  const size = Object.fromEntries(all.map((d) => [d[0], d[1]]));
  assert.ok(size.Se < size["vídeo,"] && size["vídeo,"] < size.desse, "apoio < destaque < principal");
  assert.equal(all.find((d) => d[0] === "vídeo,")[2], render.PRESETS.compose.activeColor);
});

test("destaques maiores: só a palavra-chave sai 20% maior", () => {
  const self = { AppLegendasCore: require("../src/core/captions/frames.js") };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/adobe/cep/js/services/render.js"), "utf8"), { self, require, isFinite, Math, Number, String });
  const render = self.AppLegendasRender;
  function drawn(keyBig) {
    const out = [];
    let font = "";
    const ctx = {
      set font(v) { font = v; }, get font() { return font; },
      measureText: (t) => ({ width: t.length * Number(/(\d+)px/.exec(font)[1]) * 0.6 }),
      fillText(t, x) { out.push({ t, size: Number(/(\d+)px/.exec(font)[1]), x }); },
      clearRect() {}, save() {}, restore() {}, rotate() {}, scale() {}, translate() {}, strokeText() {},
      fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, closePath() {}, fill() {}, stroke() {},
    };
    const style = Object.assign({ preset: "clean" }, render.PRESETS.clean, { motion: "none", keyBig, highlight: false, reveal: false });
    render.drawFrame({ width: 1080, height: 1920, getContext: () => ctx }, { words: ["ganhei", "500", "reais"], keys: [false, true, false], active: 0 }, style);
    return out;
  }
  const plain = drawn(false), big = drawn(true);
  assert.equal(big.length, 3, JSON.stringify(big));
  assert.equal(big[1].size, Math.round(plain[1].size * 1.2));
  assert.equal(big[0].size, plain[0].size, "o resto não muda");

  // palavra sozinha maior: só quando o bloco tem uma palavra
  const sizeOf = (words, soloBig) => {
    let size = 0, font = "";
    const ctx = {
      set font(v) { font = v; }, get font() { return font; },
      measureText: (t) => ({ width: t.length * 10 }),
      fillText() { size = Number(/(\d+)px/.exec(font)[1]); },
      clearRect() {}, save() {}, restore() {}, rotate() {}, scale() {}, translate() {}, strokeText() {},
      fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, closePath() {}, fill() {}, stroke() {},
    };
    const style = Object.assign({ preset: "clean" }, render.PRESETS.clean, { motion: "none", soloBig, highlight: false, reveal: false });
    render.drawFrame({ width: 1080, height: 1920, getContext: () => ctx }, { words, active: 0 }, style);
    return size;
  };
  assert.equal(sizeOf(["UAU"], true), Math.round(sizeOf(["UAU"], false) * 1.3));

  // contador sem "destacar cada palavra": o número sobe junto com a entrada do bloco
  const texts = [];
  const ctx2 = {
    measureText: (t) => ({ width: t.length * 10 }), fillText(t) { texts.push(t); },
    clearRect() {}, save() {}, restore() {}, rotate() {}, scale() {}, translate() {}, strokeText() {},
    fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, closePath() {}, fill() {}, stroke() {},
  };
  const counterStyle = Object.assign({ preset: "clean" }, render.PRESETS.clean, { motion: "counter", highlight: false, reveal: false });
  render.drawFrame({ width: 1080, height: 1920, getContext: () => ctx2 }, { words: ["ganhei", "1.500"], active: 0 }, counterStyle, { ageSeconds: 0 });
  assert.deepEqual(texts, ["ganhei", "0"]);
  assert.equal(sizeOf(["oi", "gente"], true), sizeOf(["oi", "gente"], false));
});

test("entradas novas: mola passa do tamanho e assenta; embaralhar e contador terminam no texto certo", () => {
  const self = { AppLegendasCore: require("../src/core/captions/frames.js") };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/adobe/cep/js/services/render.js"), "utf8"), { self, require, isFinite, Math, Number, String });
  const render = self.AppLegendasRender;
  const spring = (age) => render.motionState({ motion: "spring" }, age, 1).scale;
  assert.ok(spring(0) < 0.5);
  assert.ok([0.1, 0.15, 0.2, 0.25].some((a) => spring(a) > 1.05), "passa do tamanho");
  assert.ok(Math.abs(spring(1) - 1) < 0.01);
  const blur = (age) => render.motionState({ motion: "blurin" }, age, 1).blur;
  assert.ok(blur(0) > 10 && blur(0.4) === 0);

  const scramble = (age) => render.animatedText({ motion: "scramble" }, "Ideia, já!", age);
  assert.notEqual(scramble(0.05), "Ideia, já!");
  assert.equal(scramble(0.05).length, "Ideia, já!".length);
  assert.equal(scramble(0.05), scramble(0.05), "mesmo quadro, mesmas letras");
  assert.equal(scramble(0.05)[5], ",", "pontuação fica");
  assert.equal(scramble(0.4), "Ideia, já!");

  const counter = (text, age) => render.animatedText({ motion: "counter" }, text, age);
  assert.equal(counter("R$ 1.500", 0), "R$ 0");
  assert.equal(counter("R$ 1.500", 0.7), "R$ 1.500");
  assert.match(counter("R$ 1.500", 0.3), /^R\$ \d/);
  assert.equal(counter("3,5x", 0), "0,0x");
  assert.equal(counter("3,5x", 1), "3,5x");
  assert.equal(counter("sem número", 0.1), "sem número");
  assert.equal(render.animatedText({ motion: "rise" }, "oi", 0), "oi");
});

test("mostruário do Jota: diagonal e sobe-e-assenta assentam; palavra já revelada termina o movimento", () => {
  const self = { AppLegendasCore: require("../src/core/captions/frames.js") };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/adobe/cep/js/services/render.js"), "utf8"), { self, require, isFinite, Math, Number, String });
  const render = self.AppLegendasRender;
  const diag = (age) => render.motionState({ motion: "diagonal" }, age, 1);
  assert.deepEqual([diag(0).dx, diag(0).dy], [270, 326]);
  assert.deepEqual([diag(1.6).dx, diag(1.6).dy, diag(1.6).blur, diag(1.6).opacity], [0, 0, 0, 1]);
  const settle = (age) => render.motionState({ motion: "settle" }, age, 1).dy;
  assert.equal(settle(0), 62);
  assert.ok([0.25, 0.28, 0.3].some((a) => settle(a) < -1), "passa um pouco para cima");
  assert.equal(settle(0.42) + 0, 0);
  assert.equal(render.motionState({ motion: "slideblurleft" }, 0, 1).dx, -108);

  // a 1ª palavra entrou em 0 s; aos 0,3 s a 2ª é a da vez e a 1ª ainda está chegando na diagonal
  const moves = [];
  const ctx = {
    measureText: (t) => ({ width: t.length * 10 }), fillText() {}, strokeText() {},
    clearRect() {}, save() {}, restore() {}, rotate() {}, scale() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, closePath() {}, fill() {}, stroke() {},
    translate(x, y) { moves.push([x, y]); },
  };
  const style = Object.assign({ preset: "diagonal" }, render.PRESETS.diagonal);
  const frame = { words: ["sua", "legenda"], active: 1, starts: [0, 0.2] };
  render.drawFrame({ width: 1080, height: 1920, getContext: () => ctx }, frame, style, { ageSeconds: 0.1, elapsed: 0.3 });
  const still = [];
  ctx.translate = (x, y) => still.push([x, y]);
  render.drawFrame({ width: 1080, height: 1920, getContext: () => ctx }, frame, style, { ageSeconds: 1.6, elapsed: 3 });
  assert.ok(moves[0][0] - still[0][0] > 50, "1ª palavra ainda longe do lugar");
});

test("cancelar no meio e ffmpeg que falha: erro claro e o MOV pela metade é apagado", async (t) => {
  const bundled = path.join(__dirname, "../src/adobe/cep/bin/ffmpeg.exe");
  const ffmpeg = process.platform === "win32" && fs.existsSync(bundled) ? bundled : "ffmpeg";
  if (spawnSync(ffmpeg, ["-version"]).status !== 0) {
    t.skip("ffmpeg ausente");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "applegendas-motion-erro-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const motion = motionService(() => {});
  const canvas = { width: 64, height: 36 };
  const frame = () => new Uint8ClampedArray(64 * 36 * 4);
  // cancelar depois do 3º quadro
  const cancelled = path.join(dir, "cancelado.mov");
  let drawn = 0;
  await assert.rejects(
    motion.renderFrames({ ffmpegPath: ffmpeg, canvas, count: 30, fps: 30, path: cancelled, draw: () => { drawn += 1; return frame(); }, cancel: () => drawn >= 3 }),
    /cancelada/,
  );
  assert.equal(fs.existsSync(cancelled), false, "o arquivo cancelado sai");
  // o ffmpeg recusa a linha (codec que não existe): o erro chega com o texto dele e nada fica no disco
  const broken = path.join(dir, "quebrado.mov");
  await assert.rejects(
    motion.renderFrames({ ffmpegPath: ffmpeg, canvas, count: 5, fps: 30, path: broken, draw: frame,
      args: ["-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "64x36", "-i", "pipe:0", "-c:v", "naoexiste", broken] }),
    (err) => /naoexiste|encoder/i.test(String(err && err.message)), // o Error vem de outro contexto (vm): confere pelo texto
  );
  assert.equal(fs.existsSync(broken), false, "o arquivo quebrado sai");
});
