const test = require("node:test");
const assert = require("node:assert/strict");
const F = require("../src/adobe/cep/js/services/face-box.js");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, execFile } = require("node:child_process");
const ffmpeg = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return "ffmpeg"; } catch (e) { return null; } })();

// o que o FaceDetector devolveu no Premiere real (quadro 540x960 da pessoa, 19/10)
const REAL = [{ boundingBox: { x: 179, y: 237, width: 180, height: 228 } }, { boundingBox: { x: 62, y: 394, width: 38, height: 51 } }];

test("rosto: a caixa principal em fração do quadro, sem o engano pequeno", () => {
  assert.deepEqual(F.pick(REAL, 540, 960), { x: 0.331, y: 0.247, w: 0.333, h: 0.238 });
});

test("rosto: duas pessoas de tamanho parecido entram as duas na área livre", () => {
  const two = [{ boundingBox: { x: 100, y: 200, width: 150, height: 180 } }, { boundingBox: { x: 320, y: 220, width: 130, height: 160 } }];
  // .main: o maior rosto sozinho, para enquadrar uma pessoa (o meio da área livre seria o vão entre as duas)
  assert.deepEqual(F.pick(two, 540, 960), { x: 0.185, y: 0.208, w: 0.648, h: 0.188, main: { x: 0.185, y: 0.208, w: 0.278, h: 0.188 } });
});

test("rosto: nada, caixa minúscula, tamanho inválido ou caixa fora do quadro", () => {
  assert.equal(F.pick([], 540, 960), null);
  assert.equal(F.pick(null, 540, 960), null);
  assert.equal(F.pick(REAL, 0, 960), null);
  assert.equal(F.pick([{ boundingBox: { x: 10, y: 10, width: 8, height: 9 } }], 540, 960), null);
  assert.deepEqual(F.pick([{ boundingBox: { x: -20, y: 900, width: 200, height: 200 } }], 540, 960), { x: 0, y: 0.938, w: 0.333, h: 0.063 }, "só a parte dentro do quadro");
});

test("rosto: sem FaceDetector (Node, navegador sem o recurso) devolve null sem erro", async () => {
  assert.equal(await F.detect("data:image/jpeg;base64,AAAA"), null);
});

test("rosto coberto: tempos a cada 0,2 s e o maior trecho seguido acima de 20%", () => {
  assert.deepEqual(F.coverTimes(1), [0, 0.2, 0.4, 0.6, 0.8]);
  const s = [0, 0.1, 0.3, 0.5, 0.1, 0.25, 0.3, 0.4, 0].map((share, i) => ({ t: i / 5, share }));
  assert.deepEqual(F.verdict(s), { share: 0.4, from: 1, to: 1.4 });
});

test("rosto coberto: um quadro de passagem ou nada acima do limite não avisa", () => {
  assert.equal(F.verdict([{ t: 0, share: 0 }, { t: 0.2, share: 0.9 }, { t: 0.4, share: 0 }]), null);
  assert.equal(F.verdict([{ t: 0, share: 0.1 }, { t: 0.2, share: 0.19 }]), null);
  assert.equal(F.verdict([]), null);
  assert.equal(F.verdict(null), null);
});

test("rosto coberto: o pedido de ajuste sai em px da sequência", () => {
  assert.equal(F.adjustText({ x: 0.331, y: 0.247, w: 0.333, h: 0.238 }, 1080, 1920),
    "Tire os elementos de cima do rosto (de 357 a 717 px na horizontal e de 474 a 931 px na vertical) e mantenha o resto da cena.");
});

test("rosto: o detector que não responde não trava o pedido (vira null no tempo limite)", async () => {
  const saved = { FaceDetector: global.FaceDetector, Image: global.Image };
  global.Image = class { decode() { return Promise.resolve(); } get naturalWidth() { return 540; } get naturalHeight() { return 960; } };
  global.FaceDetector = class { detect() { return new Promise(() => {}); } };
  try {
    const t0 = Date.now();
    assert.equal(await F.detect("data:image/jpeg;base64,AAAA", 50), null);
    assert.ok(Date.now() - t0 < 1000);
    global.FaceDetector = class { detect() { return Promise.resolve(REAL); } };
    assert.deepEqual(await F.detect("data:image/jpeg;base64,AAAA", 50), { x: 0.331, y: 0.247, w: 0.333, h: 0.238 });
  } finally {
    global.FaceDetector = saved.FaceDetector;
    global.Image = saved.Image;
  }
});

test("rosto: a imagem que não decodifica também não trava", async () => {
  const saved = { FaceDetector: global.FaceDetector, Image: global.Image };
  global.Image = class { decode() { return new Promise(() => {}); } };
  global.FaceDetector = class { detect() { return Promise.resolve(REAL); } };
  try {
    assert.equal(await F.detect("data:image/jpeg;base64,AAAA", 50), null);
  } finally {
    global.FaceDetector = saved.FaceDetector;
    global.Image = saved.Image;
  }
});

test("rosto: o detector roda num worker; worker preso vira null no tempo limite e o próximo pedido abre outro", async () => {
  // no Premiere real (20/10) um detect() parou o painel inteiro: no worker, só o worker fica preso
  const saved = { Worker: global.Worker, FaceDetector: global.FaceDetector, Image: global.Image };
  const made = [], sizes = [];
  let stuck = false;
  global.FaceDetector = class {};
  global.Image = class {};
  global.Worker = class {
    constructor() { made.push(this); }
    postMessage(d) {
      if (d.hello) return setTimeout(() => this.onmessage({ data: { hello: true } }));
      sizes.push(d.bytes.length);
      if (!stuck) setTimeout(() => this.onmessage({ data: { id: d.id, width: 540, height: 960, faces: REAL.map((f) => f.boundingBox) } }));
    }
    terminate() { this.terminated = true; }
  };
  const file = require.resolve("../src/adobe/cep/js/services/face-box.js");
  delete require.cache[file];
  const W = require(file);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rosto-worker-"));
  try {
    const jpg = path.join(dir, "q.jpg");
    fs.writeFileSync(jpg, Buffer.from([1, 2, 3]));
    const url = "file:///" + jpg.replace(/\\/g, "/") + "?123";
    assert.deepEqual(await W.detect(url, 500), { x: 0.331, y: 0.247, w: 0.333, h: 0.238 });
    stuck = true;
    const t0 = Date.now();
    assert.equal(await W.detect(url, 50), null);
    assert.ok(Date.now() - t0 < 1000, "não espera o detector preso");
    assert.ok(made[0].terminated, "o worker preso sai");
    stuck = false;
    assert.deepEqual(await W.detect("data:image/jpeg;base64,AAAA", 500), { x: 0.331, y: 0.247, w: 0.333, h: 0.238 });
    assert.equal(made.length, 2, "um worker novo depois do preso");
    assert.deepEqual(sizes, [3, 3, 3], "os bytes do arquivo e do data: URL vão para o worker");
    assert.equal(await W.detect("file:///" + dir.replace(/\\/g, "/") + "/nao-existe.jpg", 50), null, "quadro que não abre: null");
    // a capa passa o img.src, que o navegador devolve codificado (a pasta "App Legendas" tem espaço)
    const spaced = path.join(dir, "App Legendas", "ção.jpg");
    fs.mkdirSync(path.dirname(spaced));
    fs.writeFileSync(spaced, Buffer.from([1, 2, 3, 4]));
    const encoded = new URL("file:///" + spaced.replace(/\\/g, "/") + "?9").href;
    assert.ok(/App%20Legendas/.test(encoded));
    assert.deepEqual(await W.detect(encoded, 500), { x: 0.331, y: 0.247, w: 0.333, h: 0.238 }, "caminho codificado do img.src");
    assert.equal(sizes[sizes.length - 1], 4);
  } finally {
    Object.assign(global, saved);
    ["Worker", "FaceDetector", "Image"].forEach((k) => { if (saved[k] === undefined) delete global[k]; });
    delete require.cache[file];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rosto: da mídia para a sequência com o Movimento padrão", () => {
  const face = { x: 0.4, y: 0.2, w: 0.2, h: 0.3 };
  // a mídia enche a sequência (mesmo tamanho, 100%): igual
  assert.deepEqual(F.toSequence(face, { width: 1080, height: 1920, scale: 100 }, { width: 1080, height: 1920 }), face);
  // bruto deitado 1920x1080 a 100% numa sequência 1080x1920: faixa do meio, e o que passa da tela é cortado
  // x: 0,5 + (0,4 - 0,5) x 1,778 = 0,322 até 0,5 + (0,6 - 0,5) x 1,778 = 0,678; y: 0,5 + (0,2 - 0,5) x 0,5625 = 0,331 até 0,5 + (0,5 - 0,5) x 0,5625 = 0,5
  assert.deepEqual(F.toSequence(face, { width: 1920, height: 1080, scale: 100 }, { width: 1080, height: 1920 }), { x: 0.322, y: 0.331, w: 0.356, h: 0.169 });
  // o mesmo bruto a 177,78% (enchendo a altura): o rosto cresce em volta do centro
  const filled = F.toSequence(face, { width: 1920, height: 1080, scale: 177.78 }, { width: 1080, height: 1920 });
  assert.equal(filled.y, 0.2);
  assert.equal(filled.h, 0.3);
  assert.equal(filled.x, 0.184); // 0,5 - 0,1 x (1920/1080 x 1,7778 = 3,16)
  assert.equal(filled.w, 0.632);
  // rosto inteiro fora da tela: null
  assert.equal(F.toSequence({ x: 0, y: 0.4, w: 0.1, h: 0.2 }, { width: 1920, height: 1080, scale: 177.78 }, { width: 1080, height: 1920 }), null);
});

test("quadros: uma chamada do ffmpeg com uma entrada por instante e um JPEG por saída", () => {
  const a = F.grabFramesArgs({ path: "C:/v.mp4", seconds: [1.5, -2, 10.12345], outputs: ["a.jpg", "b.jpg", "c.jpg"], width: 480 });
  assert.deepEqual(a.slice(0, 4), ["-hide_banner", "-v", "error", "-y"]);
  // busca rápida: -ss antes de cada -i; instante negativo vira 0
  assert.deepEqual(a.slice(4, 16), ["-ss", "1.500", "-i", "C:/v.mp4", "-ss", "0.000", "-i", "C:/v.mp4", "-ss", "10.123", "-i", "C:/v.mp4"]);
  assert.deepEqual(a.slice(16, 25), ["-map", "0:v:0", "-frames:v", "1", "-vf", "scale='min(480,iw)':-2", "-q:v", "4", "a.jpg"]);
  assert.equal(a[a.length - 1], "c.jpg");
  assert.equal(a.filter((x) => x === "-map").length, 3);
  assert.match(F.grabFramesArgs({ path: "v", seconds: [0], outputs: ["o"] }).join(" "), /min\(720,iw\)/, "720 px de largura por padrão");
});

test("quadros: com o ffmpeg de verdade, um lote só, e o instante depois do fim volta null sem derrubar os outros", { skip: !ffmpeg && "sem ffmpeg" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quadros-"));
  try {
    const video = path.join(dir, "v.mp4");
    execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=4", "-c:v", "libx264", "-g", "50", "-pix_fmt", "yuv420p", video]);
    const got = await F.grabFrames({ ffmpegPath: ffmpeg, path: video, seconds: [0.5, 2, 9], width: 160, dir });
    assert.equal(got.length, 3);
    assert.ok(got[0] && fs.statSync(got[0]).size > 0 && got[1] && fs.statSync(got[1]).size > 0, "os dois instantes dentro do vídeo saem");
    assert.equal(got[2], null, "depois do fim: null");
    assert.deepEqual(fs.readdirSync(dir).filter((f) => /realfx-quadro-.*-2\.jpg$/.test(f)), [], "o vazio não fica na pasta");
    const probe = execFileSync(ffmpeg, ["-v", "error", "-i", got[0], "-f", "null", "-"], { encoding: "utf8" });
    assert.equal(probe, "");
    F.dropFrames(got);
    assert.ok(!fs.existsSync(got[0]), "dropFrames apaga");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rosto: a escala de verdade com a mídia encaixada no quadro (a Escala aparece 100%)", () => {
  // 4K (3840x2160) numa sequência 1920x1080 a "100%": é o encaixe, metade
  assert.equal(F.effectiveScale(3840, 2160, 1920, 1080, 100), 0.5);
  // 4K deitado numa sequência em pé a 100%: a altura passa só 1,125x a da sequência; encaixado ele viraria uma
  // faixa minúscula, que ninguém deixa assim, então vale a Escala (recorte de 1080x1920 no meio do 4K)
  assert.equal(F.effectiveScale(3840, 2160, 1080, 1920, 100), 1);
  // Escala mexida (o "Definir para o tamanho do quadro" muda a Escala) ou mídia do tamanho da sequência: vale a Escala
  assert.equal(F.effectiveScale(3840, 2160, 1920, 1080, 50), 0.5);
  assert.equal(F.effectiveScale(1920, 1080, 1080, 1920, 100), 1, "bruto deitado em pé a 100%: não é encaixe");
  assert.equal(F.effectiveScale(1920, 1080, 1920, 1080, 120), 1.2);
  // e o rosto de um 4K encaixado cai no mesmo lugar que num 1080 a 100%
  const face = { x: 0.4, y: 0.2, w: 0.2, h: 0.3 };
  assert.deepEqual(F.toSequence(face, { width: 3840, height: 2160, scale: 100 }, { width: 1920, height: 1080 }), face);
});

test("rosto: com Posição e Âncora do clipe (sequência em pé, seguir quem fala)", () => {
  const face = { x: 0.6, y: 0.3, w: 0.1, h: 0.2 };
  // bruto 1920x1080 a 177,78% em 1080x1920, com a âncora no rosto (seguir quem fala): o rosto vai para o meio
  const r = F.toSequence(face, { width: 1920, height: 1080, scale: 177.78, position: [0.5, 0.5], anchor: [0.65, 0.5] }, { width: 1080, height: 1920 });
  const rx = (1920 / 1080) * 1.7778;
  assert.ok(Math.abs(r.x - (0.5 + (0.6 - 0.65) * rx)) < 0.002 && Math.abs(r.x + r.w / 2 - 0.5) < 0.002, "rosto no meio da tela: " + JSON.stringify(r));
  // Posição parada fora do centro, âncora no meio: o rosto anda o mesmo tanto
  const moved = F.toSequence(face, { width: 1080, height: 1920, scale: 100, position: [0.4, 0.5] }, { width: 1080, height: 1920 });
  assert.deepEqual(moved, { x: 0.5, y: 0.3, w: 0.1, h: 0.2 });
});

test("quadros: com vários lotes em paralelo, cada JPEG é do instante pedido (na ordem)", { skip: !ffmpeg && "sem ffmpeg" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quadros-lotes-"));
  try {
    // o brilho sobe com o tempo: o quadro de um instante mais tarde é mais claro
    const video = path.join(dir, "rampa.mp4");
    execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=25:d=8,format=gray,geq=lum='min(255,T*30)'", "-pix_fmt", "yuv420p", video]);
    const seconds = Array.from({ length: 40 }, (_, i) => 0.1 + i * 0.19); // 40 instantes: 4 lotes, 3 ao mesmo tempo
    const got = await F.grabFrames({ ffmpegPath: ffmpeg, path: video, seconds, width: 64, dir });
    assert.equal(got.filter(Boolean).length, 40);
    const light = got.map((f) => execFileSync(ffmpeg, ["-v", "error", "-i", f, "-f", "rawvideo", "-pix_fmt", "gray", "-"])[32 * 64 + 32]);
    assert.ok(light.every((v, i) => !i || v >= light[i - 1] - 2), "em ordem: " + light.join(","));
    assert.ok(light[39] - light[0] > 150, "do escuro ao claro: " + light[0] + " -> " + light[39]);
    F.dropFrames(got);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rosto em vários instantes: blocos em paralelo e 3 detecções juntas não trocam a ordem (rosto do quadro k vai para a legenda k)", { skip: !ffmpeg && "sem ffmpeg" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rostos-"));
  const saved = { window: globalThis.window, FaceDetector: globalThis.FaceDetector, Image: globalThis.Image };
  try {
    // vídeo cujo brilho cresce com o tempo: o "rosto" achado em cada quadro diz de que instante ele é
    const input = path.join(dir, "bruto.mp4");
    execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=320x180:r=30:d=4,format=yuv444p,geq=lum='20+T*55':cb=128:cr=128", "-pix_fmt", "yuv420p", input]);
    globalThis.window = { AppLegendasPersonMatte: require("../src/adobe/cep/js/services/person-matte.js") };
    let busy = 0, most = 0;
    // assíncrono: com o execFileSync, num PC ocupado (outro ffmpeg ou whisper rodando) 3 leituras em fila
    // travavam o processo e a detecção passava dos 3 s do limite (rosto null, falso erro)
    const lumaOf = (src) => new Promise((resolve, reject) => execFile(ffmpeg, ["-v", "error", "-i", decodeURI(src.replace(/^file:\/\/\//, "").replace(/\?\d+$/, "")), "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "gray", "-"], { encoding: "buffer" }, (err, out) => (err ? reject(err) : resolve(out[0]))));
    globalThis.Image = class { async decode() { most = Math.max(most, ++busy); this.luma = await lumaOf(this.src); this.naturalWidth = 320; this.naturalHeight = 180; } };
    globalThis.FaceDetector = class {
      async detect(img) {
        // em uso desde o decode(): cada pista lê o quadro e detecta
        await new Promise((r) => setTimeout(r, 5 + (img.luma % 7))); // cada detecção leva um tempo diferente
        busy -= 1;
        return [{ boundingBox: { x: img.luma, y: 20, width: 60, height: 60 } }];
      }
    };
    // 40 instantes fora de ordem: passa de um bloco (36) e cada um tem um brilho diferente
    const seconds = Array.from({ length: 40 }, (_, k) => ((k * 37) % 40) * 0.095);
    // limite folgado: aqui vale a ordem, não o tempo (num PC ocupado cada leitura do ffmpeg passa de 3 s)
    const faces = await F.detectInVideoMany({ ffmpegPath: ffmpeg, path: input, seconds, timeoutMs: 60000 });
    assert.equal(faces.length, 40);
    // o brilho certo de cada instante, lido direto no vídeo
    const truth = (t) => execFileSync(ffmpeg, ["-v", "error", "-ss", t.toFixed(3), "-i", input, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "gray", "-"])[0];
    faces.forEach((f, k) => {
      assert.ok(f, "rosto no instante " + seconds[k]);
      assert.deepEqual([f.width, f.height], [320, 180], "tamanho da mídia");
      const want = truth(seconds[k]), got = Math.round(f.x * 320);
      assert.ok(Math.abs(got - want) <= 2, "quadro " + k + " (" + seconds[k].toFixed(3) + " s): brilho " + got + ", esperado " + want);
    });
    assert.equal(most, 3, "3 detecções ao mesmo tempo");
  } finally {
    Object.assign(globalThis, saved);
    if (saved.window === undefined) delete globalThis.window;
    if (saved.FaceDetector === undefined) delete globalThis.FaceDetector;
    if (saved.Image === undefined) delete globalThis.Image;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
