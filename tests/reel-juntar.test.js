const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const J = require("../prototypes/reel-sem-premiere/juntar.js");

test("juntar: nome do Reel com vários arquivos", () => {
  assert.equal(J.joinName(["1", "2"]), "1 + 2");
  assert.equal(J.joinName(["a", "b", "c", "d", "e"]), "a + b + c +2");
});

test("juntar: trecho que atravessa a emenda das tomadas é dividido nela (2 quadros do fim de uma piscavam)", () => {
  assert.deepEqual(J.splitAt([{ startMs: 2730, endMs: 9220 }, { startMs: 19930, endMs: 37460 }], [20000]),
    [{ startMs: 2730, endMs: 9220 }, { startMs: 19930, endMs: 20000 }, { startMs: 20000, endMs: 37460 }]);
  assert.deepEqual(J.splitAt([{ startMs: 0, endMs: 50000 }], [10000, 30000]).map((r) => [r.startMs, r.endMs]), [[0, 10000], [10000, 30000], [30000, 50000]]);
  assert.deepEqual(J.splitAt([{ startMs: 0, endMs: 1000 }], []), [{ startMs: 0, endMs: 1000 }]);
});

test("juntar: tomadas do mesmo celular juntam sem recodificar; outro tamanho ou som, não", () => {
  const probe = (size, kbps, hz) => "  Stream #0:0[0x1](und): Video: hevc (Main 10) (hvc1 / 0x31637668), yuv420p10le(tv, bt2020nc/bt2020/arib-std-b67), " + size + ", " + kbps +
    " kb/s, 30 fps, 30 tbr, 600 tbn (default)\n      Display Matrix: rotation of -90.00 degrees\n  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), " + hz + " Hz, stereo, fltp, 95 kb/s (default)";
  const a = J.signature(probe("1920x1080", 8528, 48000));
  assert.equal(a, "hevc yuv420p10le 1920x1080 30|-90.00|aac 48000 stereo");
  assert.equal(J.signature(probe("1920x1080", 8714, 48000)), a); // só a taxa muda: junta copiando
  assert.notEqual(J.signature(probe("3840x2160", 8528, 48000)), a);
  assert.notEqual(J.signature(probe("1920x1080", 8528, 44100)), a);
  assert.equal(J.concatList(["D:\\Vídeos\\it's.mov", "b.mov"], 20), "file 'D:/Vídeos/it'\\''s.mov'\noutpoint 20\nfile 'b.mov'\noutpoint 20\n");
});

test("juntar: tomadas de tamanho, quadros e som diferentes viram um vídeo só no ffmpeg", (t) => {
  const bundled = path.join(__dirname, "../src/adobe/cep/bin/ffmpeg.exe");
  const ffmpeg = process.platform === "win32" && fs.existsSync(bundled) ? bundled : "ffmpeg";
  if (spawnSync(ffmpeg, ["-version"]).status !== 0) return t.skip("ffmpeg ausente");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "juntar-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const make = (name, args) => {
    const file = path.join(dir, name);
    const r = spawnSync(ffmpeg, ["-hide_banner", "-v", "error", "-y"].concat(args, ["-c:v", "libopenh264", file]), { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return file;
  };
  // em pé com som a 44,1 kHz; deitado a 60 q/s sem som (a 2ª tomada entra com silêncio)
  const a = make("a.mp4", ["-f", "lavfi", "-i", "testsrc2=size=360x640:rate=30:duration=1", "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=44100:duration=1", "-shortest"]);
  const b = make("b.mp4", ["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=60:duration=1"]);
  const graph = J.joinGraph([{ hasAudio: true, duration: 1 }, { hasAudio: false, duration: 1 }], 360, 640, 30);
  const out = path.join(dir, "juntos.mp4");
  const r = spawnSync(ffmpeg, ["-hide_banner", "-v", "error", "-y", "-i", a, "-i", b, "-filter_complex", graph, "-map", "[v]", "-map", "[a]",
    "-c:v", "libopenh264", "-c:a", "aac", out], { encoding: "utf8" });
  assert.equal(r.status, 0, "ffmpeg recusou o grafo: " + r.stderr);
  const info = spawnSync(ffmpeg, ["-hide_banner", "-i", out], { encoding: "utf8" }).stderr;
  assert.match(info, /360x640/);
  assert.match(info, /30 fps/);
  assert.match(info, /48000 Hz, stereo/);
  const secs = /Duration: 00:00:(\d+\.\d+)/.exec(info);
  assert.ok(secs && Math.abs(Number(secs[1]) - 2) < 0.15, "as duas tomadas inteiras: " + (secs && secs[1]));
});
