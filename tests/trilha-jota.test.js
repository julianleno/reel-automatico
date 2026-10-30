const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { trilhaJota, musicaJota, lufs } = require("../src/motion-jota/trilha-jota.js");

const bundled = path.join(__dirname, "../src/adobe/cep/bin/ffmpeg.exe");
const ffmpeg = process.platform === "win32" && fs.existsSync(bundled) ? bundled : "ffmpeg";

test("trilha do Jota: filtros da música (drop no lugar, abafa, fade)", () => {
  assert.equal(musicaJota({ start: 2, gainDb: -3, dur: 6, abafar: [], fade: 1.6 }),
    "aformat=sample_rates=48000:channel_layouts=stereo,atrim=start=2.000,asetpts=PTS-STARTPTS,volume=-3.0dB,afade=t=in:st=0.000:d=0.05,afade=t=out:st=4.400:d=1.6,atrim=end=6.000");
  // drop depois do fim da intro da música: ela entra depois do 0 do vídeo
  assert.match(musicaJota({ start: -0.5, gainDb: 0, dur: 6 }), /adelay=500:all=1,volume=0\.0dB,afade=t=in:st=0\.500/);
  // abafar: fecha em 8 degraus até 520 Hz e abre seco na logo
  const f = musicaJota({ start: 0, gainDb: 0, dur: 6, abafar: [[3, 4.9, 520]] });
  assert.match(f, /asendcmd=c='3\.044 lowpass@abafa f \d+;.*;3\.350 lowpass@abafa f 520;4\.900 lowpass@abafa f 19000',lowpass@abafa=f=19000/);
  assert.equal(lufs("x\n    I:         -9.6 LUFS\n"), -9.6);
  assert.equal(lufs("nada"), null);
});

test("trilha do Jota: o WAV sai com o drop na palavra-chave, pico 0,8 e -14 LUFS", async (t) => {
  if (spawnSync(ffmpeg, ["-version"]).status !== 0) return t.skip("ffmpeg ausente");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-trilha-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ff = (args) => spawnSync(ffmpeg, ["-hide_banner", "-v", "error", "-y"].concat(args), { encoding: "utf8" });
  // música: intro calma, kicks a 120 BPM de 3,0 s em diante; locução: seno de 300 Hz
  const musica = path.join(dir, "musica.wav"), locucao = path.join(dir, "voz.wav"), saida = path.join(dir, "trilha.wav");
  ff(["-f", "lavfi", "-i", "aevalsrc=exprs='0.03*sin(2*PI*440*t)+0.03*sin(2*PI*3000*t)+if(gte(t\\,3)\\,0.8*exp(-mod(t-3\\,0.5)/0.12)*sin(2*PI*50*mod(t-3\\,0.5))\\,0)':d=30:s=48000", musica]);
  ff(["-f", "lavfi", "-i", "sine=frequency=300:sample_rate=48000:duration=7", locucao]);
  const r = await trilhaJota({ musica, locucao, saida, ffmpeg,
    eventos: { dur: 8, textos: [0.3, 3.2], palavras: [0.5, 2.0], transicoes: [[4, 0.5]], logo: 6.5 } });
  // a 1ª palavra-chave a partir de 1 s (2,0) recebe o drop da faixa (3,0 s; +4 ms do filtro do grave)
  assert.equal(r.drop.video, 2.0);
  assert.ok(Math.abs(r.drop.faixa - 3.0) < 0.01, "drop da faixa em " + r.drop.faixa);
  assert.equal(r.aviso, "");
  const info = spawnSync(ffmpeg, ["-hide_banner", "-i", saida, "-af", "ebur128=peak=sample:framelog=quiet", "-f", "null", "-"], { encoding: "utf8" }).stderr;
  assert.match(info, /Duration: 00:00:08\.00/);
  assert.match(info, /48000 Hz, stereo/);
  const pico = Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(info)[1]);
  assert.ok(pico <= 20 * Math.log10(0.8) + 0.1, "pico " + pico + " dBFS");
  assert.ok(Math.abs(lufs(info) - -14) < 2, "loudness " + lufs(info));
  // música curta para o vídeo: toca do começo e avisa
  const curta = await trilhaJota({ musica, saida, ffmpeg, eventos: { dur: 40, palavras: [2] } });
  assert.equal(curta.drop, null);
  assert.match(curta.aviso, /toca do começo/);
});
