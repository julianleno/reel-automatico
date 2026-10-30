const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const P = require("../src/adobe/cep/js/services/person-matte.js");

test("recorte: a máscara vira bytes de alfa com borda macia", () => {
  // fundo, abaixo da faixa, meio, acima da faixa, pessoa
  const a = P.maskBytes({ width: 5, height: 1, data: Float32Array.from([0, 0.3, 0.5, 0.7, 1]) });
  assert.deepEqual(Array.from(a), [0, 0, 128, 255, 255]);
  assert.ok(a instanceof Uint8Array);
});

test("recorte: a média com o quadro anterior segura a borda", () => {
  const a = { width: 2, height: 1, data: Float32Array.from([0, 1]) };
  const b = P.smoothMask(a, { width: 2, height: 1, data: Float32Array.from([1, 1]) }, 0.5);
  assert.deepEqual(Array.from(b.data), [0.5, 1]);
  const c = { width: 1, height: 1, data: Float32Array.from([0.2]) };
  assert.equal(P.smoothMask(null, c), c);
});

test("recorte: tamanho do vídeo pela saída do ffmpeg, com a rotação do celular", () => {
  const plain = "Stream #0:0(und): Video: h264 (High), yuv420p(tv, bt709), 1080x1920 [SAR 1:1 DAR 9:16], 30 fps";
  assert.deepEqual(P.videoSize(plain), { width: 1080, height: 1920 });
  const rotated = "Stream #0:0: Video: hevc (Main 10), yuv420p10le, 1920x1080, 29.97 fps\n      Side data:\n        displaymatrix: rotation of -90.00 degrees";
  assert.deepEqual(P.videoSize(rotated), { width: 1080, height: 1920 });
  assert.deepEqual(P.videoSize("Video: h264, 1920x1080\n rotate          : 180"), { width: 1920, height: 1080 });
  assert.equal(P.videoSize("Audio: aac"), null);
});

test("recorte: o leitor entrega quadros inteiros, mesmo vindo em pedaços", async () => {
  const s = new PassThrough();
  const r = P.frameReader(s, 4);
  s.write(Buffer.from([1, 2, 3]));
  s.write(Buffer.from([4, 5]));
  s.write(Buffer.from([6, 7, 8, 9]));
  s.end();
  assert.deepEqual(Array.from(await r.next()), [1, 2, 3, 4]);
  assert.deepEqual(Array.from(await r.next()), [5, 6, 7, 8]);
  assert.equal(await r.next(), null, "o resto incompleto não vira quadro");
});

test("recorte: o leitor pausa o ffmpeg com uns quadros guardados e retoma quando eles saem", async () => {
  const s = new PassThrough();
  const r = P.frameReader(s, 4);
  for (let i = 0; i < 10; i += 1) s.write(Buffer.from([i, i, i, i]));
  await new Promise((done) => setImmediate(done));
  assert.equal(s.isPaused(), true, "10 quadros na frente: pausa");
  for (let i = 0; i < 6; i += 1) assert.deepEqual(Array.from(await r.next()), [i, i, i, i]);
  assert.equal(s.isPaused(), false, "com 4 guardados, retoma");
  s.end();
  for (let i = 6; i < 10; i += 1) assert.deepEqual(Array.from(await r.next()), [i, i, i, i]);
  assert.equal(await r.next(), null);
});

test("recorte: os arquivos do MediaPipe têm versão, tamanho e hash fixos", () => {
  assert.equal(P.FILES.length, 4);
  P.FILES.forEach((f) => {
    assert.match(f.sha256, /^[0-9a-f]{64}$/);
    assert.ok(f.size > 1000);
    assert.match(f.url, /^https:\/\/(cdn\.jsdelivr\.net\/npm\/@mediapipe\/tasks-vision@1\.0\.1\/|storage\.googleapis\.com\/mediapipe-models\/.*\/1\/)/);
  });
});

test("contorno: a linha do ffmpeg usa a cor do kit, o tamanho do recorte e o codec escolhido", () => {
  const a = P.outlineArgs({ input: "in.mov", output: "out.mov", width: 1080, height: 1920, fps: 30, color: "#FF3366", codec: "qtrle" });
  const filter = a[a.indexOf("-filter_complex") + 1];
  assert.match(filter, /color=c=0xff3366:s=1080x1920:r=30/);
  assert.match(filter, /scale=270:480,.*scale=1080:1920:flags=bicubic/);
  assert.match(filter, /\[o\]\[p\]overlay=format=auto:shortest=1$/); // a pessoa por cima do contorno
  assert.deepEqual(a.slice(a.indexOf("-c:v"), a.indexOf("-c:v") + 4), ["-c:v", "qtrle", "-pix_fmt", "argb"]);
  assert.equal(a[a.length - 1], "out.mov");
  // cor inválida cai no amarelo da marca; sem codec, ProRes com alfa
  const b = P.outlineArgs({ input: "i", output: "o", width: 720, height: 1280, fps: 99, color: "red" });
  assert.match(b[b.indexOf("-filter_complex") + 1], /color=c=0xffc828:s=720x1280:r=60/);
  assert.ok(b.includes("prores_ks"));
});

const { execFileSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const ffmpeg = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return "ffmpeg"; } catch (e) { return null; } })();

test("contorno: com o ffmpeg de verdade, a borda sai na cor do kit e a pessoa fica por cima", { skip: !ffmpeg && "sem ffmpeg" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "contorno-"));
  try {
    const input = path.join(dir, "recorte.mov"), output = path.join(dir, "contorno.mov");
    // um "recorte" de 160x160: quadrado opaco branco de 60 px no meio, o resto transparente
    execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=black@0:s=160x160:r=30:d=0.2,format=rgba", "-f", "lavfi", "-i", "color=c=white:s=60x60:r=30:d=0.2,format=rgba",
      "-filter_complex", "[0][1]overlay=50:50:format=auto", "-c:v", "qtrle", "-pix_fmt", "argb", input]);
    await P.outlineCutout({ ffmpegPath: ffmpeg, input, output, width: 160, height: 160, fps: 30, color: "#ff0000", codec: "qtrle" });
    const px = execFileSync(ffmpeg, ["-v", "error", "-i", output, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"]);
    const at = (x, y) => Array.from(px.subarray((y * 160 + x) * 4, (y * 160 + x) * 4 + 4));
    assert.deepEqual(at(80, 80), [255, 255, 255, 255], "a pessoa por cima");
    const ring = at(80, 44); // 6 px acima do quadrado: contorno
    assert.ok(ring[0] > 200 && ring[1] < 60 && ring[3] > 200, "contorno vermelho: " + ring);
    assert.equal(at(2, 2)[3], 0, "longe da pessoa continua transparente");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("contorno de papel: branco, com a sombra deslocada embaixo do contorno e a pessoa por cima", { skip: !ffmpeg && "sem ffmpeg" }, async () => {
  const a = P.outlineArgs({ input: "i", output: "o", width: 1080, height: 1920, fps: 30, color: "#ff0000", style: "papel" });
  const filter = a[a.indexOf("-filter_complex") + 1];
  assert.match(filter, /color=c=0xffffff/, "papel é branco, a cor do kit não vale");
  assert.match(filter, /crop=1062:1896:0:0,pad=1080:1920:18:24/, "sombra 18 px para a direita e 24 para baixo");
  assert.match(filter, /\[sh\]\[o\]overlay.*\[o2\]\[p\]overlay=format=auto:shortest=1$/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "papel-"));
  try {
    const input = path.join(dir, "recorte.mov"), output = path.join(dir, "papel.mov");
    execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=black@0:s=360x360:r=30:d=0.2,format=rgba", "-f", "lavfi", "-i", "color=c=white:s=120x120:r=30:d=0.2,format=rgba",
      "-filter_complex", "[0][1]overlay=120:120:format=auto", "-c:v", "qtrle", "-pix_fmt", "argb", input]);
    await P.outlineCutout({ ffmpegPath: ffmpeg, input, output, width: 360, height: 360, fps: 30, style: "papel", codec: "qtrle" });
    const px = execFileSync(ffmpeg, ["-v", "error", "-i", output, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"]);
    const at = (x, y) => Array.from(px.subarray((y * 360 + x) * 4, (y * 360 + x) * 4 + 4));
    const top = at(180, 112); // acima do quadrado: borda branca
    assert.ok(top[0] > 230 && top[1] > 230 && top[2] > 230 && top[3] > 200, "borda branca: " + top);
    // embaixo e à direita, além da borda: sombra escura semitransparente; no lado oposto, nada
    const shadow = at(268, 268), opposite = at(92, 92);
    assert.ok(shadow[3] > 20 && shadow[3] < 200 && shadow[0] < 60, "sombra: " + shadow);
    assert.ok(opposite[3] < shadow[3], "sombra só para baixo e para a direita: " + opposite + " x " + shadow);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rabisco: uma linha na cor do kit afastada do corpo, que muda de lugar a cada 3 quadros", { skip: !ffmpeg && "sem ffmpeg" }, async () => {
  const a = P.outlineArgs({ input: "i", output: "o", width: 1080, height: 1920, fps: 30, color: "#00ff00", style: "rabisco" });
  const filter = a[a.indexOf("-filter_complex") + 1];
  assert.match(filter, /blend=all_mode=difference/, "o anel entre as duas engordadas");
  assert.match(filter, /overlay=x='6\*sin\(floor\(n\/3\)\*2\.3\)':y='6\*cos\(floor\(n\/3\)\*1\.7\)':eval=frame/, "treme a cada 3 quadros");
  assert.match(filter, /color=c=0x00ff00/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabisco-"));
  try {
    const input = path.join(dir, "recorte.mov"), output = path.join(dir, "rabisco.mov");
    execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=black@0:s=360x360:r=30:d=0.3,format=rgba", "-f", "lavfi", "-i", "color=c=white:s=120x120:r=30:d=0.3,format=rgba",
      "-filter_complex", "[0][1]overlay=120:120:format=auto", "-c:v", "qtrle", "-pix_fmt", "argb", input]);
    await P.outlineCutout({ ffmpegPath: ffmpeg, input, output, width: 360, height: 360, fps: 30, color: "#00ff00", style: "rabisco", codec: "qtrle" });
    const frames = execFileSync(ffmpeg, ["-v", "error", "-i", output, "-frames:v", "4", "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { maxBuffer: 16 * 1024 * 1024 });
    const size = 360 * 360 * 4;
    const green = (f) => { const b = frames.subarray(f * size, (f + 1) * size); const out = []; for (let i = 0; i < b.length; i += 4) if (b[i + 3] > 128 && b[i + 1] > 180 && b[i] < 80) out.push(i / 4); return out; };
    const f0 = green(0), f3 = green(3);
    assert.ok(f0.length > 200, "tem linha: " + f0.length);
    // a linha não encosta no corpo: nenhum pixel verde dentro do quadrado nem colado nele
    assert.ok(f0.every((p) => { const x = p % 360, y = Math.floor(p / 360); return x < 116 || x > 244 || y < 116 || y > 244; }), "linha afastada do corpo");
    assert.notDeepEqual(f0.slice(0, 50), f3.slice(0, 50), "a linha mudou de lugar entre o quadro 0 e o 3");
    const center = Array.from(frames.subarray((180 * 360 + 180) * 4, (180 * 360 + 180) * 4 + 4));
    assert.deepEqual(center, [255, 255, 255, 255], "a pessoa por cima");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("contorno: furo no recorte mostra o vídeo de baixo, não a cor do contorno vazando", { skip: !ffmpeg && "sem ffmpeg" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "furo-"));
  try {
    const input = path.join(dir, "recorte.mov"), output = path.join(dir, "contorno.mov");
    // quadrado opaco de 120 px com um furo transparente de 20 px no meio (a cadeira, o cabelo)
    execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=black@0:s=360x360:r=30:d=0.2,format=rgba", "-f", "lavfi",
      "-i", "color=c=white:s=120x120:r=30:d=0.2,format=rgba,geq=r=255:g=255:b=255:a='if(between(X,50,70)*between(Y,50,70),0,255)'",
      "-filter_complex", "[0][1]overlay=120:120:format=auto", "-c:v", "qtrle", "-pix_fmt", "argb", input]);
    for (const style of ["kit", "papel"]) {
      await P.outlineCutout({ ffmpegPath: ffmpeg, input, output, width: 360, height: 360, fps: 30, color: "#ff0000", style, codec: "qtrle" });
      const px = execFileSync(ffmpeg, ["-v", "error", "-i", output, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"]);
      const hole = Array.from(px.subarray((180 * 360 + 180) * 4, (180 * 360 + 180) * 4 + 4));
      assert.ok(hole[3] < 40, style + ": o furo fica transparente: " + hole);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("máscara: renderMask grava só a máscara (cinza, 256 px, sem perda), um quadro por quadro do trecho", { skip: !ffmpeg && "sem ffmpeg" }, async () => {
  // no painel o render-motion.js e o person-matte.js dividem o global; aqui, o self faz esse papel
  const hadSelf = "self" in globalThis;
  globalThis.self = globalThis;
  globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
  const files = ["render-motion.js", "person-matte.js"].map((f) => require.resolve("../src/adobe/cep/js/services/" + f));
  files.forEach((f) => delete require.cache[f]);
  require(files[0]);
  const PM = require(files[1]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mascara-"));
  try {
    const input = path.join(dir, "bruto.mp4"), output = path.join(dir, "mascara.mkv");
    execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc=s=640x360:r=30:d=1", "-pix_fmt", "yuv420p", input]);
    // recortador de mentira: metade da esquerda é pessoa
    const seen = [];
    const segmenter = { mask: (img) => { seen.push(img.width + "x" + img.height); return { width: img.width, height: img.height, data: Float32Array.from({ length: img.width * img.height }, (_, i) => (i % img.width < img.width / 2 ? 1 : 0)) }; } };
    const r = await PM.renderMask({ ffmpegPath: ffmpeg, mediaPath: input, sourceSeconds: 0.2, duration: 0.5, fps: 30, path: output, segmenter });
    assert.deepEqual(r, { frames: 15, width: 640, height: 360, maskWidth: 256, maskHeight: 144, crop: null });
    assert.equal(seen[0], "256x144", "o recortador recebe o quadro pequeno");
    const raw = execFileSync(ffmpeg, ["-v", "error", "-i", output, "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
    assert.equal(raw.length, 15 * 256 * 144, "15 quadros de 256x144");
    assert.deepEqual([raw[10], raw[250]], [255, 0], "sem perda: pessoa 255, fundo 0");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (!hadSelf) delete globalThis.self;
    delete globalThis.ImageData;
  }
});

test("recorte: o recortador olha só o pedaço da mídia que aparece na sequência", () => {
  const land = { width: 1920, height: 1080 }, vertical = { seqWidth: 1080, seqHeight: 1920 };
  // bruto deitado preenchendo a altura da sequência em pé: aparecem 607 px do meio, mais a folga
  assert.deepEqual(P.visibleCrop(land, { ...vertical, scale: 177.78, position: [0.5, 0.5], anchors: [[0.5, 0.5]] }), { x: 578, y: 0, w: 762, h: 1080 });
  // seguir quem fala: a âncora vai de um lado ao outro, vale a união
  const both = P.visibleCrop(land, { ...vertical, scale: 177.78, position: [0.5, 0.5], anchors: [[0.3, 0.5], [0.7, 0.5]] });
  assert.ok(both.x < 578 - 300 && both.x + both.w > 578 + 762 + 300, JSON.stringify(both));
  // mídia em pé na sequência em pé: aparece tudo, nada a recortar
  assert.equal(P.visibleCrop({ width: 1080, height: 1920 }, { ...vertical, scale: 100 }), null);
  assert.equal(P.visibleCrop(land, null), null);
});

test("máscara: com o view, o recortador vê só o pedaço visível e a máscara volta ao lugar", { skip: !ffmpeg && "sem ffmpeg" }, async () => {
  const hadSelf = "self" in globalThis;
  globalThis.self = globalThis;
  globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
  const files = ["render-motion.js", "person-matte.js"].map((f) => require.resolve("../src/adobe/cep/js/services/" + f));
  files.forEach((f) => delete require.cache[f]);
  require(files[0]);
  const PM = require(files[1]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mascara-vista-"));
  try {
    const input = path.join(dir, "deitado.mp4"), output = path.join(dir, "mascara.mkv");
    execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc=s=1920x1080:r=30:d=1", "-pix_fmt", "yuv420p", input]);
    const seen = [];
    const segmenter = { mask: (img) => { seen.push(img.width + "x" + img.height); return { width: img.width, height: img.height, data: new Float32Array(img.width * img.height).fill(1) }; } };
    const view = { scale: 177.78, position: [0.5, 0.5], anchors: [[0.5, 0.5]], seqWidth: 1080, seqHeight: 1920 };
    const r = await PM.renderMask({ ffmpegPath: ffmpeg, mediaPath: input, sourceSeconds: 0, duration: 0.2, fps: 30, path: output, segmenter, view });
    assert.equal(seen[0], "256x363", "o recortador recebe o pedaço do meio (762x1080) em 256 px");
    assert.deepEqual(r.crop, { w: 762, h: 1080, steps: [{ n: 0, x: 578, y: 0 }] });
    assert.deepEqual([r.maskWidth, r.maskHeight], [645, 363]);
    const raw = execFileSync(ffmpeg, ["-v", "error", "-i", output, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
    const at = (x) => raw[100 * 645 + x];
    assert.deepEqual([at(10), at(322), at(630)], [0, 255, 0], "fora do pedaço é fundo; o meio, a pessoa");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (!hadSelf) delete globalThis.self;
    delete globalThis.ImageData;
  }
});

test("recorte: o view sai do que o host diz do clipe (zoom pela menor escala, seguir quem fala pelas âncoras)", () => {
  const clip = { scale: 130, scaleMin: 100, position: [0.5, 0.5], anchor: [0.5, 0.5], anchorKeyed: true, anchorKeys: [{ seconds: 1, value: [0.3, 0.5] }, { seconds: 4, value: [0.7, 0.5] }] };
  assert.deepEqual(P.viewOf(clip, 1080, 1920), { scale: 100, position: [0.5, 0.5], anchors: [[0.3, 0.5], [0.7, 0.5]], seqWidth: 1080, seqHeight: 1920,
    spans: [{ from: -Infinity, anchor: [0.3, 0.5] }, { from: 4, anchor: [0.7, 0.5] }] });
  assert.deepEqual(P.viewOf({ scale: 110, position: [0.4, 0.5], anchor: [0.5, 0.5] }, 1080, 1920).anchors, [[0.5, 0.5]]);
  assert.equal(P.viewOf({ scale: 100, positionAnimated: true }, 1080, 1920), null, "o vídeo anda pela tela: quadro inteiro");
});

test("máscara: com o recortador em workers, as respostas fora de ordem saem na ordem dos quadros", { skip: !ffmpeg && "sem ffmpeg" }, async () => {
  const hadSelf = "self" in globalThis;
  globalThis.self = globalThis;
  globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
  const files = ["render-motion.js", "person-matte.js"].map((f) => require.resolve("../src/adobe/cep/js/services/" + f));
  files.forEach((f) => delete require.cache[f]);
  require(files[0]);
  const PM = require(files[1]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mascara-pool-"));
  try {
    const input = path.join(dir, "bruto.mp4"), output = path.join(dir, "mascara.mkv");
    execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc=s=640x360:r=30:d=1", "-pix_fmt", "yuv420p", input]);
    // quadro k vale k/20 (sobe sempre); cada resposta demora um tempo diferente, então chegam fora de ordem
    let k = 0, inFlight = 0, most = 0;
    const segmenter = { size: 3, maskAsync: (img) => {
      const v = Math.min(1, k++ / 20);
      inFlight += 1;
      most = Math.max(most, inFlight);
      return new Promise((resolve) => setTimeout(() => { inFlight -= 1; resolve({ width: img.width, height: img.height, data: new Float32Array(img.width * img.height).fill(v) }); }, (k * 7) % 11));
    } };
    const r = await PM.renderMask({ ffmpegPath: ffmpeg, mediaPath: input, sourceSeconds: 0, duration: 0.5, fps: 30, path: output, segmenter });
    assert.equal(r.frames, 15);
    assert.ok(most > 1 && most <= 6, "vários quadros ao mesmo tempo, no máximo 2 por worker: " + most);
    const raw = execFileSync(ffmpeg, ["-v", "error", "-i", output, "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
    const px = Array.from({ length: 15 }, (_, f) => raw[f * 256 * 144]);
    assert.ok(px.every((v, i) => !i || v >= px[i - 1]), "em ordem: " + px);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (!hadSelf) delete globalThis.self;
    delete globalThis.ImageData;
  }
});

test("máscara: clipe com a velocidade mudada lê a mídia na mesma velocidade", { skip: !ffmpeg && "sem ffmpeg" }, async () => {
  const hadSelf = "self" in globalThis;
  globalThis.self = globalThis;
  globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
  const files = ["render-motion.js", "person-matte.js"].map((f) => require.resolve("../src/adobe/cep/js/services/" + f));
  files.forEach((f) => delete require.cache[f]);
  require(files[0]);
  const PM = require(files[1]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mascara-vel-"));
  try {
    // o brilho sobe com o tempo (0 no começo, 255 em 1 s); o recortador de mentira devolve o brilho como confiança
    const input = path.join(dir, "rampa.mp4");
    execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=30:d=2,format=gray,geq=lum='min(255,T*255)'", "-pix_fmt", "yuv420p", input]);
    const segmenter = { mask: (img) => {
      let sum = 0;
      for (let i = 0; i < img.data.length; i += 4) sum += img.data[i];
      return { width: img.width, height: img.height, data: new Float32Array(img.width * img.height).fill(sum / (img.data.length / 4) / 255) };
    } };
    const last = async (speed) => {
      const out = path.join(dir, "m" + speed + ".mkv");
      const r = await PM.renderMask({ ffmpegPath: ffmpeg, mediaPath: input, sourceSeconds: 0, duration: 0.5, fps: 30, path: out, segmenter, speed });
      assert.equal(r.frames, 15, "a duração é na sequência");
      const raw = execFileSync(ffmpeg, ["-v", "error", "-i", out, "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
      return raw[raw.length - 1];
    };
    const normal = await last(1), double = await last(2);
    // no fim do trecho: a 1x a mídia está em ~0,47 s (meio claro), a 2x em ~0,93 s (quase branco)
    assert.ok(double > normal + 60, "a 2x a mídia andou o dobro: " + normal + " -> " + double);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (!hadSelf) delete globalThis.self;
    delete globalThis.ImageData;
  }
});

test("máscara: com matte, um MOV branco com o alfa invertido (opaco onde não é a pessoa), para o Track Matte", { skip: !ffmpeg && "sem ffmpeg" }, async () => {
  const hadSelf = "self" in globalThis;
  globalThis.self = globalThis;
  globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
  const files = ["render-motion.js", "person-matte.js"].map((f) => require.resolve("../src/adobe/cep/js/services/" + f));
  files.forEach((f) => delete require.cache[f]);
  require(files[0]);
  const PM = require(files[1]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fosco-"));
  try {
    const input = path.join(dir, "bruto.mp4"), output = path.join(dir, "fosco.mov");
    execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc=s=640x360:r=30:d=1", "-pix_fmt", "yuv420p", input]);
    // metade da esquerda é a pessoa
    const segmenter = { mask: (img) => ({ width: img.width, height: img.height, data: Float32Array.from({ length: img.width * img.height }, (_, i) => (i % img.width < img.width / 2 ? 1 : 0)) }) };
    const r = await PM.renderMask({ ffmpegPath: ffmpeg, mediaPath: input, sourceSeconds: 0, duration: 0.2, fps: 30, path: output, segmenter, matte: true });
    assert.deepEqual([r.frames, r.maskWidth, r.maskHeight], [6, 512, 288], "o dobro da máscara, com a borda aplicada depois de esticar");
    const px = execFileSync(ffmpeg, ["-v", "error", "-i", output, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"]);
    const at = (x) => Array.from(px.subarray((140 * 512 + x) * 4, (140 * 512 + x) * 4 + 4));
    assert.deepEqual(at(40), [255, 255, 255, 0], "na pessoa: transparente");
    assert.deepEqual(at(460), [255, 255, 255, 255], "fora da pessoa: branco opaco");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (!hadSelf) delete globalThis.self;
    delete globalThis.ImageData;
  }
});

test("borda: o EDGE do ffmpeg é a mesma curva do maskBytes (para aplicar depois de esticar a máscara)", { skip: !ffmpeg && "sem ffmpeg" }, () => {
  const values = [0, 60, 90, 110, 128, 150, 166, 200, 255];
  // uma linha cinza com os valores, passada pelo EDGE
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "borda-"));
  try {
    const raw = path.join(dir, "in.gray");
    fs.writeFileSync(raw, Buffer.from(values));
    const out = execFileSync(ffmpeg, ["-v", "error", "-f", "rawvideo", "-pix_fmt", "gray", "-s", values.length + "x1", "-i", raw, "-vf", P.EDGE, "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
    const table = P.maskBytes({ data: Float32Array.from(values, (v) => v / 255) });
    Array.from(out).forEach((v, i) => assert.ok(Math.abs(v - table[i]) <= 3, values[i] + ": ffmpeg " + v + " x painel " + table[i]));
    assert.deepEqual(Array.from(P.rawBytes({ data: Float32Array.from([0, 0.5, 1, 2]) })), [0, 128, 255, 255]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("recorte: seguindo quem fala, o pedaço acompanha a pessoa de cada trecho (do mesmo tamanho)", () => {
  const land = { width: 1920, height: 1080 };
  const view = { scale: 177.78, position: [0.5, 0.5], seqWidth: 1080, seqHeight: 1920, anchors: [[0.25, 0.5], [0.75, 0.5]],
    spans: [{ from: -Infinity, anchor: [0.25, 0.5] }, { from: 4, anchor: [0.75, 0.5] }, { from: 9, anchor: [0.25, 0.5] }] };
  // a união das duas pessoas cobre quase tudo: sem trechos, o recortador olharia o quadro inteiro
  assert.equal(P.visibleCrop(land, view), null);
  const plan = P.cropPlan(land, view, { fps: 30, sourceSeconds: 2, speed: 1 });
  assert.equal(plan.w, 762);
  assert.deepEqual(plan.steps.map((s) => [s.n, s.x]), [[0, 98], [60, 1058], [210, 98]], "quadro 0 (segundo 2 da mídia), 60 (4 s) e 210 (9 s)");
  // a 2x, o segundo 4 da mídia chega no quadro 30
  assert.equal(P.cropPlan(land, view, { fps: 30, sourceSeconds: 2, speed: 2 }).steps[1].n, 30);
  // trechos antes do começo do recorte: vale o último deles
  assert.deepEqual(P.cropPlan(land, view, { fps: 30, sourceSeconds: 5, speed: 1 }).steps.map((s) => [s.n, s.x]), [[0, 1058], [120, 98]]);
});

test("máscara: seguindo quem fala, cada pedaço da máscara volta ao lugar da pessoa daquele trecho", { skip: !ffmpeg && "sem ffmpeg" }, async () => {
  const hadSelf = "self" in globalThis;
  globalThis.self = globalThis;
  globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
  const files = ["render-motion.js", "person-matte.js"].map((f) => require.resolve("../src/adobe/cep/js/services/" + f));
  files.forEach((f) => delete require.cache[f]);
  require(files[0]);
  const PM = require(files[1]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mascara-trechos-"));
  try {
    const input = path.join(dir, "podcast.mp4"), output = path.join(dir, "mascara.mkv");
    execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc=s=1920x1080:r=30:d=2", "-pix_fmt", "yuv420p", input]);
    const segmenter = { mask: (img) => ({ width: img.width, height: img.height, data: new Float32Array(img.width * img.height).fill(1) }) };
    const view = { scale: 177.78, position: [0.5, 0.5], seqWidth: 1080, seqHeight: 1920, anchors: [[0.25, 0.5], [0.75, 0.5]],
      spans: [{ from: -Infinity, anchor: [0.25, 0.5] }, { from: 1, anchor: [0.75, 0.5] }] };
    const r = await PM.renderMask({ ffmpegPath: ffmpeg, mediaPath: input, sourceSeconds: 0, duration: 2, fps: 30, path: output, segmenter, view });
    assert.deepEqual([r.maskWidth, r.maskHeight], [645, 363]);
    const raw = execFileSync(ffmpeg, ["-v", "error", "-i", output, "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer: 1 << 26 });
    const at = (frame, x) => raw[frame * 645 * 363 + 180 * 645 + x];
    // antes do segundo 1: a pessoa da esquerda (pedaço em x 98 de 1920 = 33 da máscara); depois, a da direita
    assert.deepEqual([at(10, 100), at(10, 500)], [255, 0], "1º trecho: a máscara está à esquerda");
    assert.deepEqual([at(40, 100), at(40, 500)], [0, 255], "2º trecho: a máscara foi para a direita");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (!hadSelf) delete globalThis.self;
    delete globalThis.ImageData;
  }
});

test("recortador: download corrompido é recusado e não sobra .part; com os arquivos certos, a 2ª vez não baixa nada", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recortador-"));
  try {
    const bad = (url, dest) => { fs.writeFileSync(dest, "não é o arquivo"); return Promise.resolve(); };
    await assert.rejects(P.ensureFiles(dir, bad), /veio diferente do esperado/);
    assert.deepEqual(fs.readdirSync(dir), [], "nem o .part nem o arquivo ficam");
    // o caminho certo só onde o painel já baixou os arquivos de verdade (este PC); no CI fica de fora
    const real = path.join(process.env.APPDATA || os.homedir(), "AppLegendas", "recortador");
    if (!P.FILES.every((f) => fs.existsSync(path.join(real, f.name)))) return;
    const got = [];
    const copy = (url, dest) => { const f = P.FILES.find((x) => x.url === url); got.push(f.name); fs.copyFileSync(path.join(real, f.name), dest); return Promise.resolve(); };
    await P.ensureFiles(dir, copy);
    assert.deepEqual(got, P.FILES.map((f) => f.name));
    assert.deepEqual(fs.readdirSync(dir).sort(), P.FILES.map((f) => f.name).sort());
    await P.ensureFiles(dir, copy);
    assert.equal(got.length, P.FILES.length, "tudo conferido pelo hash: não baixa de novo");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("recorte: renderCutout grava o MOV com a pessoa opaca e o fundo transparente, nas cores e no tamanho da mídia", { skip: !ffmpeg && "sem ffmpeg" }, async () => {
  const hadSelf = "self" in globalThis;
  globalThis.self = globalThis;
  globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
  const files = ["render-motion.js", "person-matte.js"].map((f) => require.resolve("../src/adobe/cep/js/services/" + f));
  files.forEach((f) => delete require.cache[f]);
  require(files[0]);
  const PM = require(files[1]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recorte-"));
  try {
    const input = path.join(dir, "bruto.mp4"), output = path.join(dir, "pessoa.mov");
    execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=0x3080c0:s=640x360:r=30:d=1", "-pix_fmt", "yuv420p", input]);
    // recortador de mentira: metade da esquerda é pessoa
    const segmenter = { mask: (img) => ({ width: img.width, height: img.height, data: Float32Array.from({ length: img.width * img.height }, (_, i) => (i % img.width < img.width / 2 ? 1 : 0)) }) };
    const r = await PM.renderCutout({ ffmpegPath: ffmpeg, mediaPath: input, sourceSeconds: 0.2, duration: 0.5, fps: 30, path: output, segmenter });
    assert.deepEqual(r, { frames: 15, width: 640, height: 360 });
    const px = execFileSync(ffmpeg, ["-v", "error", "-i", output, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { maxBuffer: 64 << 20 });
    assert.equal(px.length, 15 * 640 * 360 * 4, "15 quadros no tamanho da mídia");
    const at = (x, y) => Array.from(px.subarray((y * 640 + x) * 4, (y * 640 + x) * 4 + 4));
    const person = at(100, 180), back = at(540, 180);
    assert.equal(person[3], 255, "pessoa opaca");
    assert.ok(person.slice(0, 3).every((v, k) => Math.abs(v - [0x30, 0x80, 0xc0][k]) <= 3), "a cor da filmagem: " + person);
    assert.equal(back[3], 0, "fundo transparente");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (!hadSelf) delete globalThis.self;
    delete globalThis.ImageData;
  }
});
