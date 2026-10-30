const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const P = require("../prototypes/reel-sem-premiere/plan.js");
const { settleEdges } = require("../src/core/audio/silence.js");

test("reel sem Premiere: palavra de trecho cortado sai, a da borda é presa ao trecho que ficou", () => {
  const tm = P.timeMap([{ startMs: 0, endMs: 1000 }, { startMs: 3000, endMs: 4000 }]);
  assert.equal(tm.totalMs, 2000);
  assert.deepEqual([tm.at(500), tm.at(2000), tm.at(3500), tm.at(9000)], [500, 1000, 1500, 2000]);
  assert.deepEqual(tm.word({ text: "fica", startMs: 200, endMs: 600 }), { text: "fica", startMs: 200, endMs: 600 });
  assert.equal(tm.word({ text: "cortada", startMs: 1500, endMs: 2500 }), null);
  // meio em 3100: fica, com o começo preso em 3000 -> 1000 no vídeo cortado
  assert.deepEqual(tm.word({ text: "borda", startMs: 2900, endMs: 3300 }), { text: "borda", startMs: 1000, endMs: 1300 });
  // nenhuma palavra cortada vai parar no começo do trecho seguinte (o erro que empilhava legendas)
  const words = [{ text: "a", startMs: 1100, endMs: 1300 }, { text: "b", startMs: 1400, endMs: 1600 }, { text: "c", startMs: 2000, endMs: 2200 }];
  assert.deepEqual(words.map((w) => tm.word(w)), [null, null, null]);
});

test("reel sem Premiere: quadros do corte, tamanho girado e zoom", () => {
  // 0..1 s e 2..2,5 s a 30 q/s: quadros [0, 30) e [60, 75) = 30 + 15, menos 1 de folga
  assert.equal(P.keptFrameCount([{ startMs: 0, endMs: 1000 }, { startMs: 2000, endMs: 2500 }], 30), 44);
  const deitado = "Stream #0:0: Video: hevc (Main 10), yuv420p10le, 1920x1080, 30 fps\n    displaymatrix: rotation of -90.00 degrees";
  assert.deepEqual(P.videoSize(deitado), { W: 1080, H: 1920 });
  assert.deepEqual(P.videoSize("Stream #0:0: Video: h264, yuv420p, 1080x1920, 30 fps"), { W: 1080, H: 1920 });
  assert.equal(P.zoomExpr([], 0.12, 0.25), "1");
  assert.match(P.zoomExpr([{ inSeconds: 1, outSeconds: 2 }], 0.12, 0.25), /^\(1\+0\.12\*\(between\(t\\,1\.000\\,2\.000\)/);
});

test("reel sem Premiere: bruto deitado vira Reel em pé (recorte central 9:16)", (t) => {
  assert.deepEqual(P.reframe(1080, 1920), { crop: "", W: 1080, H: 1920 });
  const rf = P.reframe(1920, 1080);
  assert.equal(rf.crop, "crop=608:1080:(in_w-608)/2:0,scale=1080:1920,setsar=1");
  assert.deepEqual([rf.W, rf.H], [1080, 1920]);
  // rosto à esquerda (19% da largura): o recorte vai até a borda e não passa dela
  assert.equal(P.reframe(1920, 1080, 0.19).crop.split(",")[0], "crop=608:1080:60:0");
  assert.equal(P.reframe(1920, 1080, 0.02).crop.split(",")[0], "crop=608:1080:0:0");
  assert.equal(P.reframe(1920, 1080, 0.99).crop.split(",")[0], "crop=608:1080:1312:0");
  // feed 4:5 e quadrado: em pé corta em cima e embaixo (guarda o alto, onde fica o rosto);
  // deitado corta dos lados; no formato certo só escala
  assert.equal(P.reframe(1080, 1920, undefined, "feed").crop, "crop=1080:1350:0:(in_h-1350)*0.3,scale=1080:1350,setsar=1");
  assert.deepEqual([P.reframe(1080, 1920, undefined, "quadrado").W, P.reframe(1080, 1920, undefined, "quadrado").H], [1080, 1080]);
  assert.equal(P.reframe(1920, 1080, 0.5, "quadrado").crop.split(",")[0], "crop=1080:1080:420:0");
  assert.equal(P.reframe(1080, 1350, undefined, "feed").crop, "");
  // 4K em pé vira 1080x1920 (o máximo que os apps entregam); 3:4 em pé é recortado para 9:16
  assert.deepEqual(P.reframe(2160, 3840, undefined, "reels"), { crop: "scale=1080:1920,setsar=1", W: 1080, H: 1920 });
  assert.equal(P.reframe(1440, 1920, 0.5, "reels").crop, "crop=1080:1920:180:0,scale=1080:1920,setsar=1");
  // mediana: um quadro errado não puxa o recorte
  assert.equal(P.faceCenter([{ x: 260, width: 90 }, { x: 250, width: 100 }, { x: 1400, width: 80 }], 1600), 0.190625);
  assert.equal(P.faceCenter([], 1600), null);
  // zoom: sem rosto, centro um pouco acima; com rosto em pé, o centro do rosto
  assert.deepEqual(P.zoomFocus([], 640, 1138, null), { x: 0.5, y: 0.35 });
  assert.deepEqual(P.zoomFocus([{ x: 280, y: 300, width: 80, height: 100 }], 640, 1138, null), { x: 0.5, y: 350 / 1138 });
  // deitado: rosto a 22% do bruto, recorte guardou de 3% a 35% -> 59% do quadro em pé
  const f = P.zoomFocus([{ x: 120.8, y: 150, width: 40, height: 60 }], 640, 360, { x0: 0.03, w: 0.32 });
  assert.ok(Math.abs(f.x - 0.59375) < 1e-9 && Math.abs(f.y - 0.5) < 1e-9, JSON.stringify(f));
  assert.match(P.finalGraph({ W: 1080, H: 1920, band: { y: 0, h: 2 }, cut: null, zoom: "1", fx: [], music: false, focus: { x: 0.4, y: 0.3 } }),
    /crop=1080:1920:\(in_w-1080\)\*0\.400:\(in_h-1920\)\*0\.300/);
  const bundled = path.join(__dirname, "../src/adobe/cep/bin/ffmpeg.exe");
  const ffmpeg = process.platform === "win32" && fs.existsSync(bundled) ? bundled : "ffmpeg";
  if (spawnSync(ffmpeg, ["-version"]).status !== 0) return t.skip("ffmpeg ausente");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-reel-deitado-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const small = P.reframe(320, 180);
  const file = path.join(dir, "g.txt");
  fs.writeFileSync(file, P.finalGraph({ W: small.W, H: small.H, band: { y: 900, h: 120 }, cut: null, reframe: small.crop, zoom: "1", fx: [], music: false }));
  const lavfi = (spec) => ["-f", "lavfi", "-i", spec];
  const bruto = path.join(dir, "deitado.mp4");
  const out = path.join(dir, "empe.mp4");
  spawnSync(ffmpeg, ["-hide_banner", "-v", "error", "-y"].concat(lavfi("testsrc2=size=320x180:rate=30:duration=1"),
    lavfi("sine=duration=1"), ["-c:v", "mpeg4", "-c:a", "aac", "-shortest", bruto]));
  const r = spawnSync(ffmpeg, ["-hide_banner", "-v", "error", "-y", "-i", bruto].concat(lavfi("color=c=white@0.0:s=1080x120:r=30:d=1,format=rgba"),
    lavfi("anullsrc=d=0.1"), lavfi("anullsrc=d=0.1"), ["-/filter_complex", file, "-map", "[v]", "-map", "[a]", "-c:v", "mpeg4", "-c:a", "aac", out]), { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(spawnSync(ffmpeg, ["-hide_banner", "-i", out], { encoding: "utf8" }).stderr, /1080x1920/);
});

test("reel sem Premiere: o grafo da passada final roda no ffmpeg (corte, zoom, legenda, sons, música)", (t) => {
  const bundled = path.join(__dirname, "../src/adobe/cep/bin/ffmpeg.exe");
  const ffmpeg = process.platform === "win32" && fs.existsSync(bundled) ? bundled : "ffmpeg";
  if (spawnSync(ffmpeg, ["-version"]).status !== 0) {
    t.skip("ffmpeg ausente");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-reel-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const W = 180, H = 320, band = { y: 120, h: 80 };
  const keep = [{ startMs: 0, endMs: 1000 }, { startMs: 2000, endMs: 3000 }];
  const graph = P.finalGraph({
    W, H, band, cut: P.cutFilters(keep), zoom: P.zoomExpr([{ inSeconds: 0.2, outSeconds: 0.9 }], 0.12, 0.25),
    fx: [{ at: 0.1, input: 2, vol: 0.3 }, { at: 0.5, input: 2, vol: 0.3 }, { at: 0.2, input: 3, vol: 0.45 }], music: true,
    frameInput: 5, // moldura da marca: PNG transparente na entrada 5
  });
  const file = path.join(dir, "final.txt");
  fs.writeFileSync(file, graph);
  const out = path.join(dir, "reel.mp4");
  const lavfi = (spec) => ["-f", "lavfi", "-i", spec];
  // bruto com vídeo e áudio na entrada 0, como o de verdade; música curta em arquivo (em loop)
  const bruto = path.join(dir, "bruto.mp4");
  const musica = path.join(dir, "musica.wav");
  spawnSync(ffmpeg, ["-hide_banner", "-v", "error", "-y"].concat(lavfi("testsrc2=size=" + W + "x" + H + ":rate=30:duration=4"),
    lavfi("sine=frequency=300:sample_rate=48000:duration=4"), ["-c:v", "mpeg4", "-c:a", "aac", "-shortest", bruto]));
  spawnSync(ffmpeg, ["-hide_banner", "-v", "error", "-y"].concat(lavfi("sine=frequency=220:duration=1"), [musica]));
  // moldura da marca: PNG transparente do tamanho do quadro (no app, desenhado no canvas)
  const moldura = path.join(dir, "moldura.png");
  spawnSync(ffmpeg, ["-hide_banner", "-v", "error", "-y"].concat(lavfi("color=c=red@0.5:s=" + W + "x" + H + ",format=rgba"), ["-frames:v", "1", moldura]));
  // 1 = legenda transparente (no pipeline vem do canvas), 2 = estalo, 3 = batida, 4 = música
  const run = spawnSync(ffmpeg, ["-hide_banner", "-v", "error", "-y", "-i", bruto]
    .concat(lavfi("color=c=white@0.0:s=" + W + "x" + band.h + ":r=30:d=2,format=rgba"),
      lavfi("sine=frequency=2000:duration=0.2"), lavfi("sine=frequency=80:duration=0.3"),
      ["-stream_loop", "-1", "-i", musica],
      ["-loop", "1", "-i", moldura],
      ["-/filter_complex", file, "-map", "[v]", "-map", "[a]", "-c:v", "mpeg4", "-c:a", "aac", out]), { encoding: "utf8" });
  assert.equal(run.status, 0, "ffmpeg recusou o grafo: " + run.stderr);
  const info = spawnSync(ffmpeg, ["-hide_banner", "-i", out], { encoding: "utf8" }).stderr;
  const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(info);
  const secs = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);
  assert.ok(Math.abs(secs - 2) < 0.15, "o corte deixou " + secs + " s (esperado 2 s)");
  assert.match(info, new RegExp(W + "x" + H));
});

test("reel sem Premiere: o drop da música cai na palavra-chave do gancho (a partir de 1 s) ou no fim do gancho", () => {
  const w = (text, a, key) => ({ text, inSeconds: a, outSeconds: a + 0.3, key });
  assert.deepEqual(P.hookMoment([{ words: [w("Você", 0.1, true), w("sabia", 0.5)] }, { words: [w("o", 0.9), w("segredo", 1.2, true), w("disso?", 1.6)] }, { words: [w("Hoje", 2.2, true)] }]),
    { at: 1.2, text: "segredo" });
  // sem palavra-chave no gancho (a do começo, antes de 1 s, não conta): o fim do gancho
  assert.deepEqual(P.hookMoment([{ words: [w("Olha", 0.1, true), w("isso.", 0.5)] }, { words: [w("Agora", 1.2, true)] }]), { at: 0.8, text: "fim de \"isso.\"" });
  assert.equal(P.hookMoment([]), null);
});

test("reel sem Premiere: batida no momento certo (Jota): drop no lugar, 20 dB abaixo da voz, abafa no fim", (t) => {
  const bundled = path.join(__dirname, "../src/adobe/cep/bin/ffmpeg.exe");
  const ffmpeg = process.platform === "win32" && fs.existsSync(bundled) ? bundled : "ffmpeg";
  if (spawnSync(ffmpeg, ["-version"]).status !== 0) return t.skip("ffmpeg ausente");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-reel-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lavfi = (spec) => ["-f", "lavfi", "-i", spec];
  const ff = (args) => spawnSync(ffmpeg, ["-hide_banner", "-v", "error", "-y"].concat(args), { encoding: "utf8", maxBuffer: 1 << 26 });
  const W = 180, H = 320, band = { y: 120, h: 80 }, D = 6;
  // música: acorde e chimbal (3 kHz) o tempo todo; kicks a 120 BPM a partir de 3,0 s (o drop)
  const musica = path.join(dir, "musica.wav");
  ff(lavfi("aevalsrc=exprs='0.03*sin(2*PI*440*t)+0.03*sin(2*PI*3000*t)+if(gte(t\\,3)\\,0.8*exp(-mod(t-3\\,0.5)/0.12)*sin(2*PI*50*mod(t-3\\,0.5))\\,0)':d=12:s=48000").concat([musica]));
  const loud = require("../src/motion-jota/trilha-jota.js").lufs(spawnSync(ffmpeg, ["-hide_banner", "-ss", "2", "-t", String(D), "-i", musica, "-af", "ebur128=framelog=quiet", "-f", "null", "-"], { encoding: "utf8" }).stderr);
  // drop (3,0 s da faixa) na palavra-chave em 1,0 s: a música começa em 2,0 s; abafa de 4 s em diante
  const plan = { start: 2, gainDb: P.MUSIC_LUFS - loud, dur: D, abafar: [[4, D + 1, 700]], fade: 1.6 };
  const file = path.join(dir, "final.txt");
  fs.writeFileSync(file, P.finalGraph({ W, H, band, cut: null, zoom: "1", fx: [], music: plan }));
  // voz: seno de 300 Hz; e a mesma rodada com a voz muda, para medir só a música
  const render = (voz, out) => {
    const r = ff(lavfi("testsrc2=size=" + W + "x" + H + ":rate=30:duration=" + D).concat(lavfi(voz), ["-shortest", path.join(dir, "bruto.mp4")]));
    assert.equal(r.status, 0, r.stderr);
    const run = ff(["-i", path.join(dir, "bruto.mp4")].concat(lavfi("color=c=white@0.0:s=" + W + "x" + band.h + ":r=30:d=" + D + ",format=rgba"),
      lavfi("anullsrc=d=0.1"), lavfi("anullsrc=d=0.1"), ["-i", musica, "-/filter_complex", file, "-map", "[v]", "-map", "[a]", "-c:v", "mpeg4", "-c:a", "pcm_s16le", out]));
    assert.equal(run.status, 0, "ffmpeg recusou o grafo: " + run.stderr);
    return Number(/I:\s+(-?[\d.]+) LUFS/.exec(spawnSync(ffmpeg, ["-hide_banner", "-i", out, "-af", "ebur128=framelog=quiet", "-f", "null", "-"], { encoding: "utf8" }).stderr)[1]);
  };
  const comVoz = render("sine=frequency=300:sample_rate=48000:duration=" + D, path.join(dir, "reel.mov"));
  const soMusica = render("anullsrc=r=48000:cl=stereo:d=" + D, path.join(dir, "musica.mov"));
  assert.ok(Math.abs(comVoz - -14) < 1, "Reel em " + comVoz + " LUFS");
  assert.ok(Math.abs(comVoz - soMusica - 20) < 1.5, "música " + (comVoz - soMusica).toFixed(1) + " dB abaixo da voz");
  // o 1º kick (grave) da música sozinha cai em 1,0 s do Reel
  const pcm = (af) => {
    const b = spawnSync(ffmpeg, ["-hide_banner", "-v", "error", "-i", path.join(dir, "musica.mov"), "-af", af, "-ac", "1", "-f", "f32le", "-"], { maxBuffer: 1 << 26 }).stdout;
    return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
  };
  const grave = pcm("lowpass=f=120,lowpass=f=120");
  let top = 0;
  for (let i = 0; i < grave.length; i += 1) top = Math.max(top, Math.abs(grave[i]));
  const first = grave.findIndex((v) => Math.abs(v) > top * 0.25) / 48000;
  assert.ok(Math.abs(first - 1.0) < 0.012, "o drop caiu em " + first.toFixed(3) + " s (esperado 1,0)");
  // abafada no fim: o chimbal de 3 kHz cai mais de 15 dB entre 2,5-3,5 s e 4,6-5,0 s (o fade só tira ~2 dB aí)
  const hi = pcm("highpass=f=2000,highpass=f=2000");
  const rms = (a, b) => { let s = 0; for (let i = Math.round(a * 48000); i < b * 48000; i += 1) s += hi[i] * hi[i]; return 10 * Math.log10(s / ((b - a) * 48000)); };
  assert.ok(rms(2.5, 3.5) - rms(4.6, 5.0) > 15, "abafou " + (rms(2.5, 3.5) - rms(4.6, 5.0)).toFixed(1) + " dB");
  t.diagnostic("drop em " + first.toFixed(4) + " s; Reel " + comVoz + " LUFS, música " + (comVoz - soMusica).toFixed(1) + " dB abaixo; abafou " + (rms(2.5, 3.5) - rms(4.6, 5.0)).toFixed(1) + " dB");
});

test("reel sem Premiere: o silêncio dentro da frase baixa da 2ª escuta não é cortado; o de fora continua", () => {
  const silences = [{ startMs: 1000, endMs: 3000 }, { startMs: 4000, endMs: 4800 }, { startMs: 9000, endMs: 10000 }];
  const words = [{ text: "x", startMs: 500, endMs: 900 }, { text: "Como", startMs: 2500, endMs: 3200, quiet: true }, { text: "escola", startMs: 3500, endMs: 5200, quiet: true }];
  assert.deepEqual(P.keepQuietSpeech(silences, words, 0), [{ startMs: 1000, endMs: 2500 }, { startMs: 9000, endMs: 10000 }]);
  // com o respiro (120 ms) a palavra baixa fica inteira mesmo com o tempo do Whisper um pouco cedo
  assert.deepEqual(P.keepQuietSpeech(silences, words), [{ startMs: 1000, endMs: 2380 }, { startMs: 9000, endMs: 10000 }]);
});

test("reel sem Premiere: a pausa entre duas palavras da frase baixa sai como as outras (palavra a palavra, não até 2 s)", () => {
  // 1 (1).mov aos 87 s: "Como" baixinho, 1,7 s parado, "que a escola…" (tempos já afinados pelo áudio)
  const words = [{ text: "Como", startMs: 87030, endMs: 87160, quiet: true }, { text: "que", startMs: 88820, endMs: 88990, quiet: true }, { text: "a", startMs: 88990, endMs: 89080, quiet: true }];
  const silences = [{ startMs: 87400, endMs: 88600 }];
  assert.deepEqual(P.keepQuietSpeech(silences, words), silences);
  // o silêncio que encosta na palavra perde só o pedaço do respiro dela
  assert.deepEqual(P.keepQuietSpeech([{ startMs: 87200, endMs: 88800 }], words), [{ startMs: 87280, endMs: 88700 }]);
});

test("reel sem Premiere: a folga da emenda conta do fim da voz, não do fim da palavra do Whisper", () => {
  // Roteiro 4: o Whisper fecha "essencial." em 80,07 s e a voz (-15 a -24 dB) vai até ~80,5 s; o corte em 80,17 comia o "-cial"
  const keep = [{ startMs: 79000, endMs: 81500 }, { startMs: 83000, endMs: 85000 }];
  const words = [{ text: "essencial.", startMs: 79500, endMs: 80070 }, { text: "depois", startMs: 83500, endMs: 84000 }];
  const voiced = (ms) => (ms >= 79400 && ms < 80520) || (ms >= 83300 && ms < 84000);
  assert.deepEqual(P.hugWords(keep, words, 80, 100, 500)[0], { startMs: 79420, endMs: 80170 });
  assert.deepEqual(P.hugWords(keep, words, 80, 100, 500, voiced), [{ startMs: 79320, endMs: 80620 }, { startMs: 83220, endMs: 84500 }]);
});

// envelope de teste (dB a cada 10 ms) a partir de [desde ms, dB] em ordem
const envelope = (totalMs, marks) => Array.from({ length: totalMs / 10 }, (_, k) => marks.filter(([from]) => from <= k * 10).pop()[1]);

test("reel sem Premiere: a folga da emenda para a 40 ms da voz clara que sai (chiado baixo não conta)", () => {
  const level = (db, dB) => (ms) => db[Math.floor(ms / 10)] >= dB;
  const later = { startMs: 3000, endMs: 3500 };
  // 1.MOV, 39,9 s: ensaio colado em "Nossa" (vale de 30 ms) e o Whisper atrasado; a folga de 80 ms entrava no ensaio
  let db = envelope(3500, [[0, -80], [500, -20], [1000, -58], [1030, -20], [2000, -80]]);
  const nossa = [{ text: "Nossa", startMs: 1500, endMs: 1900 }];
  assert.deepEqual(P.hugWords([{ startMs: 200, endMs: 2800 }, later], nossa, 80, 100, 500, level(db, -56), level(db, -44))[0], { startMs: 1030, endMs: 2100 });
  assert.equal(P.hugWords([{ startMs: 200, endMs: 2800 }, later], nossa, 80, 100, 500, level(db, -56))[0].startMs, 950);
  // Roteiro 4, 80,7 s: depois de "essencial." um vale de 50 ms e fala sem palavra; a folga de 100 ms entrava nela
  db = envelope(3500, [[0, -20], [1000, -66], [1050, -20], [1500, -80]]);
  const essencial = [{ text: "essencial.", startMs: 400, endMs: 700 }];
  assert.equal(P.hugWords([{ startMs: 0, endMs: 1700 }, later], essencial, 80, 100, 500, level(db, -60), level(db, -48))[0].endMs, 1010);
  // Patrícia, 17,4 s: o "-s" de "perguntas." (-57 dB, logo acima do limite) não é voz clara: a folga passa por ele
  db = envelope(3500, [[0, -20], [1000, -72], [1030, -57], [1200, -85]]);
  const perguntas = [{ text: "perguntas.", startMs: 400, endMs: 1000 }];
  assert.equal(P.hugWords([{ startMs: 0, endMs: 1700 }, later], perguntas, 80, 100, 500, level(db, -65), level(db, -53))[0].endMs, 1100);
});

test("reel sem Premiere: emenda dentro da voz vai para o silêncio do resto da palavra, ou para o vale entre palavras coladas", () => {
  const next = { startMs: 3000, endMs: 4000 };
  // Roteiro 4: "essencial." fecha em 80,07 s no Whisper e a voz vai até 80,66; o trecho da duração acabava em 80,22
  let db = envelope(4000, [[0, -20], [1440, -80]]);
  const tail = [{ text: "essencial.", startMs: 400, endMs: 700 }, { text: "Na", startMs: 3000, endMs: 3300 }];
  assert.deepEqual(settleEdges([{ startMs: 0, endMs: 1000 }, next], tail, db, 10, -60, 120, 500)[0], { startMs: 0, endMs: 1440 });
  // Roteiro 4, 95,4 s: "concentração | e da própria…", coladas; o retake começa no "e" e o vale (-54 dB) está 90 ms antes
  db = envelope(4000, [[0, -16], [910, -54], [930, -16]]);
  const glued = [{ text: "concentração", startMs: 400, endMs: 1000 }, { text: "e", startMs: 1000, endMs: 1140 }];
  assert.equal(settleEdges([{ startMs: 0, endMs: 1000 }, next], glued, db, 10, -60, 120, 500)[0].endMs, 910);
  // sem silêncio nem vale (no meio da vogal) e outra palavra no caminho: fica; no silêncio, nunca muda
  db = envelope(4000, [[0, -20]]);
  assert.equal(settleEdges([{ startMs: 0, endMs: 1000 }, next], glued, db, 10, -60, 120, 500)[0].endMs, 1000);
  db = envelope(4000, [[0, -20], [950, -80], [1100, -20]]);
  assert.equal(settleEdges([{ startMs: 0, endMs: 1000 }, next], glued, db, 10, -60, 120, 500)[0].endMs, 1000);
  // o começo do trecho anda para trás, até o silêncio antes do resto da palavra
  db = envelope(4000, [[0, -80], [2700, -20]]);
  assert.equal(settleEdges([{ startMs: 0, endMs: 1000 }, next], [{ text: "Na", startMs: 3100, endMs: 3300 }], db, 10, -60, 120, 500)[1].startMs, 2700);
});

test("reel sem Premiere: plano curto entre dois cortes cresce para dentro do silêncio que sai", () => {
  const keep = [{ startMs: 0, endMs: 5000 }, { startMs: 6970, endMs: 7270 }, { startMs: 7300, endMs: 9000 }, { startMs: 9500, endMs: 9600 }];
  const out = P.holdShots(keep, 400);
  // "Como" (0,3 s): sobra só 30 ms depois, o resto vem de antes
  assert.deepEqual(out[1], { startMs: 6900, endMs: 7300 });
  assert.deepEqual(out[0], keep[0]);
  // o último cresce só para trás (não passa do anterior)
  assert.deepEqual(out[3], { startMs: 9200, endMs: 9600 });
});

test("reel sem Premiere: trecho sem palavra sai (curto ou longo), curto com palavra fica", () => {
  const keep = [{ startMs: 0, endMs: 5000 }, { startMs: 6000, endMs: 6300 }, { startMs: 7000, endMs: 7400 }, { startMs: 9000, endMs: 12000 }];
  const words = [{ text: "oi", startMs: 100, endMs: 400 }, { text: "sim", startMs: 7050, endMs: 7350 }];
  assert.deepEqual(P.dropStrayNoise(keep, words).map((r) => r.startMs), [0, 7000]);
});

test("reel sem Premiere: quadro igual é reconhecido (legenda parada)", () => {
  const a = new Uint8ClampedArray(16).fill(7);
  assert.equal(P.samePixels(a, a.slice()), true);
  const b = a.slice();
  b[13] = 8;
  assert.equal(P.samePixels(a, b), false);
  assert.equal(P.samePixels(a, new Uint8ClampedArray(8)), false);
});

test("reel sem Premiere: altura do rosto para a legenda desviar", () => {
  assert.deepEqual(P.faceSpan([{ y: 100, height: 200 }, { y: 120, height: 200 }, { y: 400, height: 100 }], 1000), { top: 0.12, bottom: 0.32 });
  assert.equal(P.faceSpan([], 1000), null);
});

test("reel sem Premiere: prévia rápida em metade do tamanho", () => {
  assert.deepEqual(P.reframe(1080, 1920, undefined, "reels", 0.5), { crop: "scale=540:960,setsar=1", W: 540, H: 960 });
  assert.equal(P.reframe(1920, 1080, 0.5, "reels", 0.5).crop, "crop=608:1080:656:0,scale=540:960,setsar=1");
});

test("reel sem Premiere: legenda atrás da pessoa (máscara vira alfa, pessoa por cima da legenda)", (t) => {
  const bundled = path.join(__dirname, "../src/adobe/cep/bin/ffmpeg.exe");
  const ffmpeg = process.platform === "win32" && fs.existsSync(bundled) ? bundled : "ffmpeg";
  if (spawnSync(ffmpeg, ["-version"]).status !== 0) return t.skip("ffmpeg ausente");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-reel-atras-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const W = 180, H = 320, band = { y: 120, h: 80 };
  const lavfi = (spec) => ["-f", "lavfi", "-i", spec];
  const bruto = path.join(dir, "bruto.mp4"), mask = path.join(dir, "mascara.mkv"), out = path.join(dir, "reel.mp4"), file = path.join(dir, "g.txt");
  // vídeo verde (a "pessoa" e o fundo); máscara pequena: pessoa na metade esquerda
  spawnSync(ffmpeg, ["-hide_banner", "-v", "error", "-y"].concat(lavfi("color=c=green:s=" + W + "x" + H + ":r=30:d=3"),
    lavfi("sine=duration=3"), ["-c:v", "mpeg4", "-q:v", "2", "-c:a", "aac", "-shortest", bruto]));
  spawnSync(ffmpeg, ["-hide_banner", "-v", "error", "-y"].concat(lavfi("color=c=black:s=64x114:r=30:d=3"),
    ["-vf", "drawbox=x=0:y=0:w=32:h=114:color=white:t=fill,format=gray", "-c:v", "ffv1", mask]));
  fs.writeFileSync(file, P.finalGraph({ W, H, band, cut: P.cutFilters([{ startMs: 0, endMs: 1000 }, { startMs: 2000, endMs: 3000 }]), zoom: "1",
    fx: [], music: false, maskInput: 4, fps: 30, src: { w: W, h: H }, edge: require("../src/adobe/cep/js/services/person-matte.js").EDGE }));
  const r = spawnSync(ffmpeg, ["-hide_banner", "-v", "error", "-y", "-i", bruto]
    .concat(lavfi("color=c=red:s=" + W + "x" + band.h + ":r=30:d=2,format=rgba"), lavfi("anullsrc=d=0.1"), lavfi("anullsrc=d=0.1"),
      ["-i", mask, "-/filter_complex", file, "-map", "[v]", "-map", "[a]", "-c:v", "mpeg4", "-q:v", "2", "-c:a", "aac", out]), { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  // um quadro depois do corte (1,5 s do Reel = 2,5 s do bruto), linha do meio da faixa
  const px = (x) => spawnSync(ffmpeg, ["-hide_banner", "-v", "error", "-ss", "1.5", "-i", out, "-frames:v", "1",
    "-vf", "crop=2:2:" + x + ":" + (band.y + band.h / 2), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).stdout; // 2x2: a cor do yuv420p vem em blocos
  const left = px(30), right = px(150);
  assert.ok(left[1] > 100 && left[0] < 80, "pessoa (esquerda) devia estar por cima da legenda: " + [...left]);
  assert.ok(right[0] > 180 && right[1] < 80, "fundo (direita) devia mostrar a legenda vermelha: " + [...right]);
});

test("reel sem Premiere: legenda atrás da pessoa com bruto deitado (máscara cortada no tamanho dela, x que muda)", (t) => {
  const bundled = path.join(__dirname, "../src/adobe/cep/bin/ffmpeg.exe");
  const ffmpeg = process.platform === "win32" && fs.existsSync(bundled) ? bundled : "ffmpeg";
  if (spawnSync(ffmpeg, ["-version"]).status !== 0) return t.skip("ffmpeg ausente");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-reel-atras-deitado-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const W = 180, H = 320, band = { y: 120, h: 80 };
  const lavfi = (spec) => ["-f", "lavfi", "-i", spec];
  const bruto = path.join(dir, "bruto.mp4"), mask = path.join(dir, "mascara.mkv"), out = path.join(dir, "reel.mp4"), file = path.join(dir, "g.txt");
  // bruto 640x360; máscara 64x36 (um décimo): pessoa só nos 160 px da esquerda do bruto
  spawnSync(ffmpeg, ["-hide_banner", "-v", "error", "-y"].concat(lavfi("color=c=green:s=640x360:r=30:d=3"),
    lavfi("sine=duration=3"), ["-c:v", "mpeg4", "-q:v", "2", "-c:a", "aac", "-shortest", bruto]));
  spawnSync(ffmpeg, ["-hide_banner", "-v", "error", "-y"].concat(lavfi("color=c=black:s=64x36:r=30:d=3"),
    ["-vf", "drawbox=x=0:y=0:w=16:h=36:color=white:t=fill,format=gray", "-c:v", "ffv1", mask]));
  // seguir quem fala: até 1,5 s o pedaço em pé começa no x 0 (pega a pessoa), depois no x 300 (só fundo)
  const reframe = "crop=200:360:'if(lt(t\\,1.5)\\,0\\,300)':0,scale=" + W + ":" + H + ",setsar=1";
  const graph = P.finalGraph({ W, H, band, cut: null, reframe, zoom: "1", fx: [], music: false, maskInput: 4, fps: 30,
    src: { w: 640, h: 360 }, edge: require("../src/adobe/cep/js/services/person-matte.js").EDGE });
  assert.ok(graph.includes("yuva420p") && !graph.includes("rgba"), "devia cortar antes de ganhar alfa: " + graph);
  fs.writeFileSync(file, graph);
  const r = spawnSync(ffmpeg, ["-hide_banner", "-v", "error", "-y", "-i", bruto]
    .concat(lavfi("color=c=red:s=" + W + "x" + band.h + ":r=30:d=3,format=rgba"), lavfi("anullsrc=d=0.1"), lavfi("anullsrc=d=0.1"),
      ["-i", mask, "-/filter_complex", file, "-map", "[v]", "-map", "[a]", "-c:v", "mpeg4", "-q:v", "2", "-c:a", "aac", out]), { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const px = (ss, x) => spawnSync(ffmpeg, ["-hide_banner", "-v", "error", "-ss", String(ss), "-i", out, "-frames:v", "1",
    "-vf", "crop=2:2:" + x + ":" + (band.y + band.h / 2), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).stdout;
  const person = px(0.5, 30), bg = px(0.5, 170), later = px(2.5, 30);
  assert.ok(person[1] > 100 && person[0] < 80, "pessoa (x 0 do pedaço) devia estar por cima da legenda: " + [...person]);
  assert.ok(bg[0] > 180 && bg[1] < 80, "fundo (direita do pedaço) devia mostrar a legenda: " + [...bg]);
  assert.ok(later[0] > 180 && later[1] < 80, "depois que o pedaço anda para o x 300 a pessoa sai: " + [...later]);
});

test("reel sem Premiere: trechos presos à grade de quadros (o que encosta vira um só)", () => {
  assert.deepEqual(P.snapKeep([{ startMs: 1517, endMs: 3333 }, { startMs: 3340, endMs: 4000 }, { startMs: 5000, endMs: 5010 }], 30),
    [{ startMs: (46 * 1000) / 30, endMs: (120 * 1000) / 30 }]);
  const k = P.snapKeep([{ startMs: 0, endMs: 1000 }, { startMs: 2000, endMs: 2500 }], 30);
  assert.deepEqual(k, [{ startMs: 0, endMs: 1000 }, { startMs: 2000, endMs: 2500 }]);
  // punch-in no 2º trecho: de 1 s (quadro 30) até 1,5 s, com o degrau no meio entre dois quadros
  assert.equal(P.punchExpr(k, 30, 0.1), "(1+0.1*(between(t\\,0.98333\\,1.48333)))");
  assert.equal(P.punchExpr(k.slice(0, 1), 30, 0.1), "1", "sem corte não há punch-in");
  // som: cada trecho na amostra exata, com micro fade, e emendado
  const cf = P.cutFilters(k, 30);
  assert.match(cf.video, /^fps=30,select='between\(t\\,-0\.01667\\,0\.98333\)\+between\(t\\,1\.98333\\,2\.48333\)'/);
  assert.match(cf.audio, /^asplit=2\[c0\]\[c1\];\[c0\]atrim=start=0\.000000:end=1\.000000,asetpts=PTS-STARTPTS,afade=t=in:d=0\.0080,afade=t=out:st=0\.992000:d=0\.0080\[d0\];/);
  assert.match(cf.audio, /concat=n=2:v=0:a=1$/);
  // trecho com a voz mais baixa (tomada longe do microfone) ganha o volume que falta
  const leveled = P.cutFilters([k[0], Object.assign({}, k[1], { gainDb: 6.5 })], 30);
  assert.match(leveled.audio, /\[c1\]atrim=start=2\.000000:end=2\.500000,asetpts=PTS-STARTPTS,volume=6\.5dB,afade/);
  assert.doesNotMatch(leveled.audio, /\[c0\][^;]*volume/);
});

test("reel sem Premiere: legenda não pisca (segura 0,5 s e cobre buraco curto até a seguinte)", () => {
  const segs = [{ inSeconds: 8.76, outSeconds: 8.96 }, { inSeconds: 9.28, outSeconds: 10.5 }, { inSeconds: 10.7, outSeconds: 11.2 }, { inSeconds: 13, outSeconds: 13.1 }];
  assert.deepEqual(P.holdCaptions(segs, 0.5).map((s) => [s.inSeconds, s.outSeconds]),
    [[8.76, 9.28], [9.28, 10.7], [10.7, 11.2], [13, 13.5]]);
  // a seguinte logo depois: não passa por cima dela
  assert.deepEqual(P.holdCaptions([{ inSeconds: 1, outSeconds: 1.1 }, { inSeconds: 1.2, outSeconds: 2 }], 0.5)[0].outSeconds, 1.2);
});

test("reel sem Premiere: imagem e som cortam no mesmo quadro (flash e bipe juntos depois de 3 cortes, em 30, 29,97 e 24 q/s)", (t) => {
  const bundled = path.join(__dirname, "../src/adobe/cep/bin/ffmpeg.exe");
  const ffmpeg = process.platform === "win32" && fs.existsSync(bundled) ? bundled : "ffmpeg";
  if (spawnSync(ffmpeg, ["-version"]).status !== 0) return t.skip("ffmpeg ausente");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-reel-sinc-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // antes: 7, 49 e 73 ms de diferença em 30 q/s (cada trecho arredondava a imagem para um lado e o som cortava em pacotes)
  for (const [rate, real] of [["30", 30], ["30000/1001", 30000 / 1001], ["24", 24]]) {
    const fps = Math.round(real);
    const marks = [2.0, 5.0, 8.0];
    const bruto = path.join(dir, "bruto.mov"), out = path.join(dir, "reel.mkv"), file = path.join(dir, "g.txt");
    const flash = marks.map((m) => "between(T," + (m - 0.001) + "," + (m + 1 / real - 0.002) + ")").join("+");
    const beep = marks.map((m) => "between(t," + m + "," + (m + 0.02) + ")").join("+");
    let r = spawnSync(ffmpeg, ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=" + rate + ":d=10,format=yuv420p,geq=lum='if(" + flash + ",235,16)':cb=128:cr=128",
      "-f", "lavfi", "-i", "aevalsrc='if(" + beep + ",0.8*sin(2*PI*1000*t),0)':s=48000:d=10", "-c:v", "mpeg4", "-q:v", "2", "-c:a", "pcm_s16le", bruto], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const keep = P.snapKeep([{ startMs: 0, endMs: 1517 }, { startMs: 1950, endMs: 3333 }, { startMs: 4903, endMs: 6210 }, { startMs: 7871, endMs: 9500 }], fps);
    fs.writeFileSync(file, P.finalGraph({ W: 64, H: 64, band: { y: 0, h: 16 }, cut: P.cutFilters(keep, fps), zoom: "1", fx: [], music: false, fps }));
    // como no app: o bruto lido só até 1 s depois do último trecho (P.readUntil), e nada do último trecho se perde
    assert.equal(P.readUntil(keep, fps), (Math.round(9.5 * fps) / fps + 1).toFixed(3));
    r = spawnSync(ffmpeg, ["-hide_banner", "-v", "error", "-y", "-t", P.readUntil(keep, fps), "-i", bruto, "-f", "lavfi", "-i", "color=c=white@0.0:s=64x16:r=" + fps + ":d=8,format=rgba",
      "-f", "lavfi", "-i", "anullsrc=d=0.1", "-f", "lavfi", "-i", "anullsrc=d=0.1", "-/filter_complex", file, "-map", "[v]", "-map", "[a]", "-c:v", "ffv1", "-c:a", "pcm_s16le", out], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const v = spawnSync(ffmpeg, ["-hide_banner", "-v", "error", "-i", out, "-vf", "scale=8:8,format=gray", "-f", "rawvideo", "-"], { maxBuffer: 1 << 24 }).stdout;
    const flashes = [];
    for (let i = 0; i < v.length / 64; i += 1) if (v.subarray(i * 64, i * 64 + 64).reduce((s, x) => s + x, 0) / 64 > 120) flashes.push(i / fps);
    const a = spawnSync(ffmpeg, ["-hide_banner", "-v", "error", "-i", out, "-ac", "1", "-f", "f32le", "-"], { maxBuffer: 1 << 26 }).stdout;
    const s = new Float32Array(a.buffer, a.byteOffset, a.length >> 2);
    const beeps = [];
    for (let i = 0; i < s.length; i += 1) if (Math.abs(s[i]) > 0.1 && (!beeps.length || i / 48000 - beeps[beeps.length - 1] > 0.5)) beeps.push(i / 48000);
    assert.equal(flashes.length, 3, rate + ": " + flashes);
    assert.equal(v.length / 64, P.keptFrameCount(keep, fps) + 1, rate + ": todos os quadros dos trechos");
    beeps.forEach((b, i) => assert.ok(Math.abs(b - flashes[i]) < 0.002, rate + ": o som do corte " + (i + 1) + " está " + Math.round((b - flashes[i]) * 1000) + " ms fora da imagem"));
    assert.ok(Math.abs(v.length / 64 / fps - s.length / 48000) < 0.002, rate + ": imagem e som com a mesma duração");
  }
});

test("reel sem Premiere: HDR do iPhone (HLG) sai em SDR BT.709, com as cores mais vivas; SDR fica como está", (t) => {
  const hlg = "Stream #0:0[0x1](und): Video: hevc (Main 10) (hvc1 / 0x31637668), yuv420p10le(tv, bt2020nc/bt2020/arib-std-b67), 1920x1080, 30 fps";
  assert.match(P.toneFilter(hlg), /^colorspace=all=bt709:iall=bt2020/);
  assert.match(P.toneFilter("Video: hevc (Main 10), yuv420p10le(tv, bt2020nc/bt2020/smpte2084), 3840x2160"), /tonemap=tonemap=hable/);
  assert.equal(P.toneFilter("Video: h264 (High), yuv420p(tv, bt709, progressive), 1080x1920"), "");
  assert.equal(P.toneFilter("Video: h264 (High), yuv420p(tv, progressive), 1080x1920"), "");
  assert.match(P.finalGraph({ W: 180, H: 320, band: { y: 0, h: 2 }, cut: P.cutFilters([{ startMs: 0, endMs: 500 }]), tone: P.toneFilter(hlg), zoom: "1", fx: [], music: false }),
    /^\[0:v\]fps=30,select=[^;]*setpts=N\/FRAME_RATE\/TB,scale=w=[^;]*crop=[^;]*,colorspace=all=bt709/, "a cor muda depois do zoom, já no tamanho do Reel");
  // 4K em pé: a escala do reframe sai e o zoom parte do bruto (punch-in sem perder nitidez)
  const g4k = P.finalGraph({ W: 1080, H: 1920, band: { y: 0, h: 2 }, cut: null, reframe: P.reframe(2160, 3840).crop, zoom: "(1+0.12)", fx: [], music: false });
  assert.match(g4k, /^\[0:v\]scale=w='1080\*\(1\+0\.12\)':h='1920\*\(1\+0\.12\)':eval=frame,crop=1080:1920:[^,]*,setsar=1\[z\]/);
  assert.doesNotMatch(g4k, /scale=1080:1920/);
  const bundled = path.join(__dirname, "../src/adobe/cep/bin/ffmpeg.exe");
  const ffmpeg = process.platform === "win32" && fs.existsSync(bundled) ? bundled : "ffmpeg";
  if (spawnSync(ffmpeg, ["-version"]).status !== 0) return t.skip("ffmpeg ausente");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-reel-hdr-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lavfi = (spec) => ["-f", "lavfi", "-i", spec];
  // bruto marcado como o do iPhone (10 bits, BT.2020, HLG): barras de cor
  const bruto = path.join(dir, "bruto.mkv"), out = path.join(dir, "reel.mkv"), file = path.join(dir, "g.txt");
  spawnSync(ffmpeg, ["-hide_banner", "-v", "error", "-y"].concat(lavfi("smptebars=s=180x320:r=30:d=1,setparams=color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc"),
    lavfi("sine=duration=1"), ["-pix_fmt", "yuv420p10le", "-c:v", "ffv1", "-c:a", "pcm_s16le", "-shortest", bruto]));
  const probeText = spawnSync(ffmpeg, ["-hide_banner", "-i", bruto], { encoding: "utf8" }).stderr;
  assert.match(probeText, /bt2020nc\/bt2020\/arib-std-b67/, "bruto de teste marcado como HLG");
  fs.writeFileSync(file, P.finalGraph({ W: 180, H: 320, band: { y: 0, h: 80 }, cut: null, tone: P.toneFilter(probeText), zoom: "1", fx: [], music: false }));
  const r = spawnSync(ffmpeg, ["-hide_banner", "-v", "error", "-y", "-i", bruto].concat(lavfi("color=c=white@0.0:s=180x80:r=30:d=1,format=rgba"),
    lavfi("anullsrc=d=0.1"), lavfi("anullsrc=d=0.1"), ["-/filter_complex", file, "-map", "[v]", "-map", "[a]", "-c:v", "ffv1", "-c:a", "pcm_s16le", out]), { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(spawnSync(ffmpeg, ["-hide_banner", "-i", out], { encoding: "utf8" }).stderr, /yuv420p\(tv, bt709[,)]/, "saída marcada BT.709");
  // a barra vermelha (5ª de 7, x ~ 115) fica mais saturada que lida como se já fosse 709
  const px = (f, extra) => spawnSync(ffmpeg, ["-hide_banner", "-v", "error", "-i", f, "-frames:v", "1", "-vf", (extra || "") + "crop=2:2:115:60", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).stdout;
  const before = px(bruto, "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709,");
  const after = px(out);
  const sat = (p) => Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2]);
  assert.ok(sat(after) > sat(before) + 10, "cor convertida devia ficar mais viva: " + [...before] + " -> " + [...after]);
});

test("reel sem Premiere: palavras guardadas por vídeo (mesmo bruto = mesma chave; outro modelo, trecho ou arquivo mexido = outra)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reel-palavras-"));
  try {
    const st = { size: 1000, mtimeMs: 5 };
    const file = P.wordsFile(dir, "D:/bruto.mp4", st, "small-q8", 0);
    assert.equal(P.wordsFile(dir, "D:/bruto.mp4", { size: 1000, mtimeMs: 5 }, "small-q8", undefined), file);
    const others = [
      P.wordsFile(dir, "D:/bruto.mp4", st, "medium", 0),
      P.wordsFile(dir, "D:/bruto.mp4", st, "small-q8", 30),
      P.wordsFile(dir, "D:/bruto.mp4", { size: 1000, mtimeMs: 6 }, "small-q8", 0),
      P.wordsFile(dir, "D:/outro.mp4", st, "small-q8", 0),
    ];
    assert.equal(new Set(others.concat(file)).size, 5);
    assert.equal(P.savedWords(file), null, "nada guardado ainda");
    P.saveWords(file, []);
    assert.equal(fs.existsSync(file), false, "vazio não guarda");
    const words = [{ text: "Olá", startMs: 0, endMs: 400 }, { text: "mundo", startMs: 400, endMs: 900 }];
    P.saveWords(file, words);
    assert.deepEqual(P.savedWords(file), words);
    assert.deepEqual(fs.readdirSync(dir), [path.basename(file)], "sem sobra .part");
    fs.writeFileSync(file, "{quebrado");
    assert.equal(P.savedWords(file), null);
    fs.writeFileSync(file, JSON.stringify([{ text: "x" }]));
    assert.equal(P.savedWords(file), null, "palavra sem tempo não vale");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reel sem Premiere: começo de frase com maiúscula depois do corte (a 1ª do Reel e depois de ponto)", () => {
  const w = (t) => ({ text: t, startMs: 0, endMs: 1 });
  const out = P.sentenceCase(["e", "memoriza", "\"passagem\".", "a", "Câmara", "de", "vila?", "“é", "ótimo"].map(w)).map((x) => x.text);
  assert.deepEqual(out, ["E", "memoriza", "\"passagem\".", "A", "Câmara", "de", "vila?", "“É", "ótimo"]);
});

test("reel sem Premiere: aspa sem par na frase sai; com par fica (\"A Câmara… sem fechar, 2.MOV)", () => {
  const w = (t) => ({ text: t, startMs: 0, endMs: 1 });
  const out = P.oddQuotes(["A", "palavra", "é", "\"passagem\".", "\"A", "Câmara", "de", "Vila", "Rica.", "Ele", "disse", "“sim”", "e", "\"", "foi."].map(w)).map((x) => x.text);
  assert.deepEqual(out, ["A", "palavra", "é", "\"passagem\".", "A", "Câmara", "de", "Vila", "Rica.", "Ele", "disse", "sim", "e", "foi."]);
});
