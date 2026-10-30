const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const speed = require("../src/adobe/cep/js/services/speed.js");

const PROBE = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'a.MOV':
  Duration: 00:01:08.10, start: 0.000000, bitrate: 9077 kb/s
  Stream #0:0[0x1]: Video: hevc (Main 10) (hvc1 / 0x31637668), yuv420p10le(tv), 1920x1080, 8505 kb/s, 29.97 fps, 29.97 tbr, 19200 tbn (default)
  Stream #0:1[0x2]: Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 100 kb/s (default)
  Stream #0:2[0x3]: Video: mjpeg (Baseline), yuvj420p, 320x240, 90k tbr (attached pic)`;

test("acelerar: nome da cópia, cadeia de atempo e leitura do ffmpeg", () => {
  assert.equal(speed.outputName("D:/brutos/fala.MOV", 1.25), "fala 1.25x.mp4");
  assert.equal(speed.outputName("C:\\x\\narração.wav", 1.5), "narração 1.5x.wav");
  assert.equal(speed.label(2), "2x");
  assert.equal(speed.atempoChain(1.25), "atempo=1.25");
  assert.equal(speed.atempoChain(3), "atempo=2,atempo=1.5");
  const p = speed.parseProbe(PROBE);
  assert.equal(p.duration, 68.1);
  assert.equal(p.fps, 29.97);
  assert.equal(p.videoKbps, 8505);
  assert.ok(p.hasVideo && p.hasAudio);
});

test("acelerar: vídeo com quadros constantes e áudio no mesmo tom; áudio sozinho sai em wav", () => {
  const probe = speed.parseProbe(PROBE);
  const v = speed.buildArgs({ input: "a.MOV", output: "a 1.25x.mp4", speed: 1.25, probe, encoder: "h264_amf" });
  assert.equal(v[v.indexOf("-filter:v") + 1], "setpts=PTS/1.25,fps=29.97");
  assert.equal(v[v.indexOf("-filter:a") + 1], "atempo=1.25");
  assert.equal(v[v.indexOf("-c:v") + 1], "h264_amf");
  assert.equal(v[v.indexOf("-b:v") + 1], "8505k");
  const a = speed.buildArgs({ input: "a.wav", output: "a 1.5x.wav", speed: 1.5, probe: { hasAudio: true } });
  assert.ok(!a.includes("-c:v"));
  assert.equal(a[a.indexOf("-c:a") + 1], "pcm_s16le");
});

// frequência pelo cruzamento de zero de um PCM s16le mono
function frequency(file, ffmpeg) {
  const r = spawnSync(ffmpeg, ["-v", "error", "-i", file, "-ac", "1", "-ar", "48000", "-f", "s16le", "-"], { maxBuffer: 1 << 26 });
  const pcm = new Int16Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length >> 1);
  let cross = 0;
  for (let i = 1; i < pcm.length; i++) if (pcm[i - 1] < 0 && pcm[i] >= 0) cross++;
  return { hz: cross / (pcm.length / 48000), seconds: pcm.length / 48000 };
}

test("acelerar de verdade: 6 s viram 4 s e o tom de 440 Hz continua 440 Hz", async (t) => {
  const bundled = path.join(__dirname, "../src/adobe/cep/bin/ffmpeg.exe");
  const ffmpeg = process.platform === "win32" && fs.existsSync(bundled) ? bundled : "ffmpeg";
  if (spawnSync(ffmpeg, ["-version"]).status !== 0) {
    t.skip("ffmpeg ausente");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-speed-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const wav = path.join(dir, "tom.wav");
  const mp4 = path.join(dir, "video.mp4");
  spawnSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=6", wav]);
  spawnSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=6", "-f", "lavfi",
    "-i", "sine=frequency=440:duration=6", "-shortest", "-c:v", "mpeg4", "-c:a", "aac",
    // metadados longos como os do iPhone 16 (~5 kB antes da duração): o probe não pode perder a duração
    "-metadata", "comment=" + "x".repeat(6000), mp4]);

  const a = await speed.speedUp({ ffmpegPath: ffmpeg, input: wav, outDir: path.join(dir, "out"), speed: 1.5 });
  const fa = frequency(a.path, ffmpeg);
  assert.ok(Math.abs(fa.seconds - 4) < 0.05, "áudio com " + fa.seconds + " s");
  assert.ok(Math.abs(fa.hz - 440) < 5, "tom mudou para " + fa.hz + " Hz");

  const v = await speed.speedUp({ ffmpegPath: ffmpeg, input: mp4, outDir: path.join(dir, "out"), speed: 1.5 });
  assert.ok(v.path.endsWith("video 1.5x.mp4"));
  assert.ok(Math.abs(v.seconds - 4) < 0.1, "duração prevista " + v.seconds + " s (o probe perdeu a duração?)");

  // só o trecho que o clipe usa (In 1 s, Out 4 s): 3 s em 1,5x viram 2 s, com outro nome
  const part = await speed.speedUp({ ffmpegPath: ffmpeg, input: mp4, outDir: path.join(dir, "out"), speed: 1.5, start: 1, duration: 3, suffix: " (2)" });
  assert.ok(part.path.endsWith("video 1.5x (2).mp4"));
  assert.ok(Math.abs(part.seconds - 2) < 0.05, "previsto " + part.seconds + " s");
  const fp = frequency(part.path, ffmpeg);
  assert.ok(Math.abs(fp.seconds - 2) < 0.1, "trecho com " + fp.seconds + " s");
  assert.ok(Math.abs(fp.hz - 440) < 5, "tom do trecho mudou para " + fp.hz + " Hz");

  // de novo, mesma velocidade: não sobrescreve a cópia que já existe (o Premiere a deixa aberta)
  const again = await speed.speedUp({ ffmpegPath: ffmpeg, input: mp4, outDir: path.join(dir, "out"), speed: 1.5 });
  assert.ok(again.path.endsWith("video 1.5x 2.mp4"), again.path);
  assert.ok(fs.existsSync(v.path));
  const fv = frequency(v.path, ffmpeg);
  assert.ok(Math.abs(fv.seconds - 4) < 0.1, "vídeo com " + fv.seconds + " s");
  assert.ok(Math.abs(fv.hz - 440) < 5, "tom do vídeo mudou para " + fv.hz + " Hz");
});
