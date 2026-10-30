// A transcrição (services/transcribe.js) com um whisper de mentira: o progresso, o JSON que não fica, a CPU que
// também falha, e o áudio extraído só do trecho pedido.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

// behave(command, args) -> { code, signal?, stderr?, json? } (json: o que o whisper grava em -of + .json)
// timers (opcional): { setInterval, clearInterval } de mentira, para o toque da vez sem esperar 30 s
function load(behave, tmp, timers) {
  const calls = [];
  const childProcess = {
    spawn(command, args) {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      calls.push({ command, args });
      setImmediate(() => {
        const r = behave(command, args);
        if (r.stderr) child.stderr.write(r.stderr);
        if (r.json) fs.writeFileSync(args[args.indexOf("-of") + 1] + ".json", JSON.stringify(r.json));
        setImmediate(() => child.emit("close", r.code, r.signal || null));
      });
      return child;
    },
  };
  const fakeOs = tmp ? Object.assign({}, os, { tmpdir: () => tmp }) : os;
  const fakeRequire = (name) => (name === "child_process" ? childProcess : name === "os" ? fakeOs : require(name));
  const sandbox = Object.assign({ module: { exports: {} }, require: fakeRequire, setImmediate, setTimeout, setInterval, clearInterval, Buffer }, timers);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/adobe/cep/js/services/transcribe.js"), "utf8"), sandbox);
  return { T: sandbox.module.exports, calls };
}

const JSON_OK = { transcription: [{ text: " Olá", offsets: { from: 0, to: 400 } }, { text: " mundo", offsets: { from: 400, to: 900 } }] };

test("whisper: o progresso chega, o JSON não fica na pasta e a CPU que também falha dá o erro do whisper", async () => {
  // (a GPU que cai para a CPU, a sessão que lembra e o cancelar estão em transcribe.test.js)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-"));
  try {
    const ok = load(() => ({ code: 0, stderr: "progress = 50%\n", json: JSON_OK }));
    const wav = path.join(dir, "a.wav"), seen = [];
    const words = await ok.T.transcribeWav({ whisperPath: "w", modelPath: "m", wavPath: wav, onProgress: (p) => seen.push(p) });
    assert.equal(words.map((w) => w.text).join(" "), "Olá mundo");
    assert.deepEqual(seen, [0.5]);
    assert.equal(fs.existsSync(path.join(dir, "a.json")), false, "o JSON do whisper não fica na pasta");
    // contexto entre janelas: nenhum sem prompt (pulava frases); com prompt, só o tamanho dele, sem repetir em toda janela
    const mc = (a) => a[a.indexOf("-mc") + 1];
    assert.equal(mc(ok.calls[0].args), "0");
    await ok.T.transcribeWav({ whisperPath: "w", modelPath: "m", wavPath: path.join(dir, "b.wav"), prompt: "Nomes: Ana." });
    assert.equal(mc(ok.calls[1].args), "6");
    assert.ok(!ok.calls[1].args.includes("--carry-initial-prompt"), "repetido em toda janela, o prompt virava texto no murmúrio");
    // acento: no Windows o whisper lê em cp1252; vão os bytes UTF-8 escritos em cp1252 ("é" = C3 A9 = "Ã©";
    // "ã" = C3 A3 = "Ã£"; "ç" = C3 A7; o "–" tem 0x80 e 0x93, que viram € e “)
    await ok.T.transcribeWav({ whisperPath: "w", modelPath: "m", wavPath: path.join(dir, "c.wav"), prompt: "é ação – x" });
    const sent = ok.calls[2].args[ok.calls[2].args.indexOf("--prompt") + 1];
    assert.equal(sent, process.platform === "win32" ? "Ã© aÃ§Ã£o â€“ x" : "é ação – x");
    const both = load(() => ({ code: 3, stderr: "modelo corrompido" }));
    await assert.rejects(both.T.transcribeWav({ whisperPath: "w", modelPath: "m", wavPath: path.join(dir, "c.wav") }), /whisper falhou \(código 3: modelo corrompido\)/);
    assert.equal(both.calls.length, 2, "GPU e depois CPU");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("GPU sem memória que termina bem mas só com \"!!!!\" repete na CPU (e a sessão fica na CPU)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-"));
  try {
    const garbage = { transcription: [{ text: "!".repeat(240), offsets: { from: 0, to: 30000 } }] };
    const { T, calls } = load((cmd, args) => ({ code: 0, json: args.includes("-ng") ? JSON_OK : garbage }));
    const words = await T.transcribeWav({ whisperPath: "w", modelPath: "m", wavPath: path.join(dir, "a.wav") });
    assert.equal(words.map((w) => w.text).join(" "), "Olá mundo");
    assert.deepEqual(calls.map((c) => c.args.includes("-ng")), [false, true]);
    await T.transcribeWav({ whisperPath: "w", modelPath: "m", wavPath: path.join(dir, "b.wav") });
    assert.equal(calls[2].args.includes("-ng"), true, "a próxima já vai direto na CPU");
    // na CPU o lixo não tem para onde cair: sai como sempre saiu (um "!")
    const cpu = load(() => ({ code: 0, json: garbage }));
    await cpu.T.transcribeWav({ whisperPath: "w", modelPath: "m", wavPath: path.join(dir, "c.wav") });
    assert.equal(cpu.calls.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("vez parada há mais de 2 min é sobra (PID reaproveitado); quem tem a vez toca o arquivo a cada 30 s", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-"));
  const lock = path.join(dir, "app-legendas-whisper.lock");
  const other = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
  try {
    const beats = [];
    let touchedAt = 0;
    const { T, calls } = load((cmd, args) => {
      if (beats.length) { beats[0].fn(); touchedAt = fs.statSync(lock).mtimeMs; } // um toque no meio da transcrição
      return { code: 0, json: JSON_OK };
    }, dir, { setInterval: (fn, ms) => { beats.push({ fn, ms, on: true }); return beats.length; }, clearInterval: (id) => { beats[id - 1].on = false; } });
    fs.writeFileSync(lock, String(other.pid)); // vivo, mas a vez dele está parada há 3 min
    const old = new Date(Date.now() - 3 * 60 * 1000);
    fs.utimesSync(lock, old, old);
    let waited = 0;
    assert.equal((await T.transcribeWav({ whisperPath: "w", modelPath: "m", wavPath: path.join(dir, "a.wav"), onWait: () => waited++ })).length, 2);
    assert.equal(waited, 0, "não esperou a vez parada");
    assert.equal(calls.length, 1);
    assert.deepEqual(beats.map((b) => [b.ms, b.on]), [[30000, false]], "toca a cada 30 s e para ao soltar a vez");
    assert.ok(touchedAt > old.getTime() + 60000, "o toque renova a data do arquivo");
  } finally {
    other.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("uma transcrição por vez no PC: espera a de outro processo, assume a de processo morto, cancela na espera", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-"));
  const lock = path.join(dir, "app-legendas-whisper.lock");
  // "outro processo" vivo transcrevendo (o próprio PID agora conta como sobra de painel recarregado)
  const other = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
  try {
    const { T, calls } = load(() => ({ code: 0, json: JSON_OK }), dir);
    fs.writeFileSync(lock, String(other.pid));
    const t0 = Date.now();
    let waits = 0;
    const job = T.transcribeWav({ whisperPath: "w", modelPath: "m", wavPath: path.join(dir, "a.wav"), onWait: () => waits++ });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(calls.length, 0, "não roda enquanto o outro transcreve");
    assert.equal(waits, 1, "avisa uma vez que está esperando (a espera passa por várias voltas)");
    fs.rmSync(lock);
    assert.equal((await job).length, 2);
    assert.ok(Date.now() - t0 >= 400);
    assert.equal(fs.existsSync(lock), false, "solta a vez ao terminar");

    fs.writeFileSync(lock, "999999"); // processo que morreu sem soltar
    await T.transcribeWav({ whisperPath: "w", modelPath: "m", wavPath: path.join(dir, "b.wav"), onWait: () => waits++ });
    assert.equal(calls.length, 2);
    assert.equal(waits, 1, "vez de processo morto não é espera");

    fs.writeFileSync(lock, String(other.pid));
    const waiting = T.transcribeWav({ whisperPath: "w", modelPath: "m", wavPath: path.join(dir, "c.wav") });
    await new Promise((r) => setTimeout(r, 50));
    T.cancelAll();
    await assert.rejects(waiting, /cancelado/);
    assert.equal(fs.readFileSync(lock, "utf8"), String(other.pid), "a vez do outro continua dele");

    // painel recarregado no meio: o arquivo ficou com o PID deste processo, mas este carregamento não tem a vez
    fs.writeFileSync(lock, String(process.pid));
    await T.transcribeWav({ whisperPath: "w", modelPath: "m", wavPath: path.join(dir, "d.wav") });
    assert.equal(fs.existsSync(lock), false);
  } finally {
    other.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("áudio: só o trecho pedido, em WAV 16 kHz mono; erro do ffmpeg explicado", async () => {
  const { T, calls } = load(() => ({ code: 0 }));
  await T.extractWav({ ffmpegPath: "ffmpeg", file: "bruto.mp4", wavPath: "a.wav", startSeconds: 12.5, durationSeconds: 30 });
  const a = calls[0].args;
  assert.deepEqual([a[a.indexOf("-ss") + 1], a[a.indexOf("-t") + 1], a[a.indexOf("-ar") + 1], a[a.indexOf("-ac") + 1]], ["12.5", "30", "16000", "1"]);
  assert.ok(a.indexOf("-ss") < a.indexOf("-i"), "busca antes da entrada (rápida)");
  await T.extractWav({ ffmpegPath: "ffmpeg", file: "bruto.mp4", wavPath: "a.wav", startSeconds: 0, durationSeconds: 0 });
  assert.equal(calls[1].args.includes("-ss"), false, "do começo, sem -ss nem -t");
  const bad = load(() => ({ code: 1, stderr: "bruto.mp4: No such file" }));
  await assert.rejects(bad.T.extractWav({ ffmpegPath: "ffmpeg", file: "bruto.mp4", wavPath: "a.wav" }), /ffmpeg falhou ao extrair o áudio \(código 1: bruto\.mp4: No such file\)/);
});

// WAV PCM 16 kHz mono de `seconds` segundos (silêncio): o relisten corta pedaços dele
function silentWav(file, seconds) {
  const data = Buffer.alloc(seconds * 32000), h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVEfmt ", 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

test("2ª escuta: fala sem palavra é ouvida de novo só ali (sem prompt antes: ruído descarta), alinhada à volta da fala", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-"));
  try {
    const wav = path.join(dir, "fala.wav");
    silentWav(wav, 10);
    const seen = [];
    const { T, calls } = load((cmd, args) => {
      const f = args[args.indexOf("-f") + 1], prompt = args.includes("--prompt") ? args[args.indexOf("--prompt") + 1] : "";
      if (!/-trecho\.wav$/.test(f)) return { code: 0, json: JSON_OK }; // a escuta inteira: só "Olá mundo" no começo
      // no Windows o prompt vai como bytes UTF-8 escritos em cp1252 (asAnsi): volta ao texto para conferir
      seen.push({ bytes: fs.statSync(f).size, prompt: process.platform === "win32" ? Buffer.from(prompt, "latin1").toString("utf8") : prompt });
      // o trecho: sem prompt sai outra coisa (frase trocada); com prompt, a frase certa
      return { code: 0, json: { transcription: [{ text: " frase", offsets: { from: 0, to: 300 } }, { text: prompt ? " baixa" : " baixo", offsets: { from: 300, to: 600 } }] } };
    });
    // fala de 5 a 8 s sem palavra; silêncio fino de 1 a 6 s (a fala de verdade volta em 6 s)
    const words = await T.transcribeWav({ whisperPath: "w", modelPath: "m", wavPath: wav,
      relisten: { speech: [{ startMs: 0, endMs: 900 }, { startMs: 5000, endMs: 8000 }], silences: [{ startMs: 1000, endMs: 6000 }] } });
    // a 2ª escuta começava em 2 s (no silêncio): anda até a volta da fala, em 6 s; o texto é o da escuta com prompt
    assert.equal(JSON.stringify(words.map((w) => [w.text, w.startMs, !!w.quiet])), JSON.stringify([["Olá", 0, false], ["mundo", 400, false], ["frase", 6000, true], ["baixa", 6300, true]]));
    // janela de 2 s (5 s - 3 s) a 9 s (8 s + 1 s): 7 s de áudio, sem prompt e depois com o texto de antes
    assert.equal(JSON.stringify(seen), JSON.stringify([{ bytes: 44 + 7 * 32000, prompt: "" }, { bytes: 44 + 7 * 32000, prompt: "Olá mundo" }]));
    assert.equal(fs.existsSync(path.join(dir, "fala-trecho.wav")), false, "o pedaço não fica");
    assert.equal(calls.length, 3);

    // ruído: a escuta sem prompt não traz palavra nenhuma, e a com prompt nem roda
    const noise = load((cmd, args) => ({ code: 0, json: /-trecho\.wav$/.test(args[args.indexOf("-f") + 1]) ? { transcription: [] } : JSON_OK }));
    const quiet = await noise.T.transcribeWav({ whisperPath: "w", modelPath: "m", wavPath: wav, relisten: { speech: [{ startMs: 5000, endMs: 8000 }], silences: [] } });
    assert.equal(quiet.map((w) => w.text).join(" "), "Olá mundo");
    assert.equal(noise.calls.length, 2, "a escuta inteira e a sem prompt");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("2ª escuta: ensaio baixinho da frase que vem logo depois em voz normal não entra na transcrição", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-"));
  try {
    const wav = path.join(dir, "fala.wav");
    silentWav(wav, 12);
    // 1.MOV: "era muito a pena contar como isso aconteceu" baixinho, depois "vale muito a pena contar essa história..."
    const loud = { transcription: ["Olá", "mundo.", "vale", "muito", "a", "pena", "contar", "como", "tudo", "aconteceu."].map((t, i) =>
      ({ text: " " + t, offsets: i < 2 ? { from: i * 400, to: i * 400 + 400 } : { from: 9000 + i * 250, to: 9200 + i * 250 } })) };
    const said = (list) => ({ code: 0, json: { transcription: list.map((t, i) => ({ text: " " + t, offsets: { from: i * 300, to: i * 300 + 250 } })) } });
    const run = async (list) => {
      const { T } = load((cmd, args) => (/-trecho\.wav$/.test(args[args.indexOf("-f") + 1]) ? said(list) : { code: 0, json: loud }));
      return T.transcribeWav({ whisperPath: "w", modelPath: "m", wavPath: wav, relisten: { speech: [{ startMs: 4000, endMs: 7000 }], silences: [] } });
    };
    const rehearsal = await run(["era", "muito", "apena", "contar", "como", "isso", "aconteceu."]);
    assert.equal(rehearsal.map((w) => w.text).join(" "), "Olá mundo. vale muito a pena contar como tudo aconteceu.", "o ensaio não entra");
    // frase baixa que não se repete (a última pergunta do bruto do Jota): continua com quiet
    const content = await run(["qual", "escola", "você", "escolheu", "afinal?"]);
    assert.equal(content.filter((w) => w.quiet).length, 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("2ª escuta: ensaio é a frase seguinte dita de novo, não o tema que volta (cliente 1: 7 de 12 frases normais saíam)", () => {
  const { T } = load(() => ({ code: 0 }));
  // o bruto da cliente 1, uma frase a cada 7 s; cada uma finge que veio da 2ª escuta, com o resto em voz normal
  const lines = [
    "Mãe, a escola te disse que é inclusiva.",
    "Só que antes de você resolver essa matrícula, faça essas três perguntas que eu vou deixar aqui pra você.",
    "Primeira pergunta, quem da equipe pedagógica é especialista em educação inclusiva?",
    "Não pergunte apenas se a escola é inclusiva, permite quem ela está de frato e o preparado de frato.",
    "Não pergunte apenas se a escola é inclusiva e quem está aqui de fato é preparado para colocar simprática.",
    "Primeira pergunta, quem ali da equipe pedagógica é especialista em educação inclusiva?",
    "Segunda pergunta, como um aluno precisa de apoio ou ter uma de adaptação?",
    "Como que a escola identifica essa necessidade e organiza o atendimento?",
    "Segunda pergunta, quando que um aluno precisa de apoio ou de alguma adaptação durante o processo de ensino?",
  ].map((l, i) => l.split(" ").map((text, k) => ({ text, startMs: i * 7000 + k * 300, endMs: i * 7000 + k * 300 + 250 })));
  const dropped = (i) => T.rehearsed(lines[i], lines.filter((_, j) => j !== i).flat());
  assert.equal(dropped(0), false, "o gancho fica (\"escola\" e \"inclusiva\" voltam o vídeo todo)");
  assert.equal(dropped(2), false, "a 1ª pergunta fica (a regravada dela vem 3 frases depois)");
  assert.equal(dropped(6), false, "a 2ª pergunta fica");
  assert.equal(dropped(3), true, "a tomada refeita logo em seguida sai, como o ensaio");
  // as 2 tomadas baixas juntas (34,5-51,8 s): a versão boa vem 2 frases depois, ela refaz antes a 1ª pergunta
  const low = lines[3].concat(lines[4]);
  const good = "Não pergunte apenas se a escola é inclusiva, você precisa saber quem da equipe está preparado para atender a sua criança."
    .split(" ").map((text, k) => ({ text, startMs: 39000 + k * 300, endMs: 39250 + k * 300 }));
  assert.equal(T.rehearsed(low, lines[5].concat(good)), true, "a fala baixa em bloco sai");
  assert.equal(T.rehearsed(low, lines.slice(5).flat()), false, "sem a versão boa depois, a fala baixa fica");
  // frase curta que divide o assunto com a seguinte (cliente 2 editado)
  const hook = "O que tem a ver, Nossa Senhora Aparecida com política?".split(" ").map((text, k) => ({ text, startMs: k * 300, endMs: k * 300 + 250 }));
  const next = "Desde o começo, Nossa Senhora Aparecida chegou ao Brasil pela vaidade de um político.".split(" ").map((text, k) => ({ text, startMs: 4000 + k * 300, endMs: 4250 + k * 300 }));
  assert.equal(T.rehearsed(hook, next), false);
});

test("2ª escuta: a frase que a 1ª pôs fora do lugar vai para o lugar certo mesmo com o tema dela voltando depois", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-"));
  try {
    const wav = path.join(dir, "fala.wav");
    silentWav(wav, 40);
    // 2 tomadas juntadas (21/10): a 1ª escuta espalha o gancho por 9-20 s (silêncio do vídeo anterior); a fala dela
    // (20,5-24 s) fica sem palavra; e "escola" e "inclusiva" voltam na fala de depois. O rehearsed (ensaio baixinho)
    // vinha antes do dropEcho e tomava o gancho por ensaio: ficava só a cópia fora do lugar, em cima de quem não falava
    const hook = ["Mãe,", "a", "escola", "te", "disse", "que", "é", "inclusiva,"];
    const after = ["Não", "pergunte", "apenas", "se", "a", "escola", "é", "inclusiva."];
    const loud = { transcription: [{ text: " passagem.", offsets: { from: 7820, to: 9040 } }]
      .concat(hook.map((t, i) => ({ text: " " + t, offsets: { from: 9040 + i * 1370, to: 9040 + (i + 1) * 1370 } })))
      .concat(after.map((t, i) => ({ text: " " + t, offsets: { from: 30000 + i * 400, to: 30350 + i * 400 } }))) };
    const again = { transcription: hook.map((t, i) => ({ text: " " + t, offsets: { from: 500 + i * 400, to: 850 + i * 400 } })) };
    const { T } = load((cmd, args) => ({ code: 0, json: /-trecho\.wav$/.test(args[args.indexOf("-f") + 1]) ? again : loud }));
    const words = await T.transcribeWav({ whisperPath: "w", modelPath: "m", wavPath: wav,
      relisten: { speech: [{ startMs: 20500, endMs: 24000 }, { startMs: 30000, endMs: 33500 }], silences: [] } });
    assert.equal(words.map((w) => w.text).join(" "), "passagem. " + hook.join(" ") + " " + after.join(" "), "o gancho uma vez só");
    const first = words.find((w) => w.text === "Mãe,");
    assert.deepEqual([first.startMs, !!first.quiet], [20500, true], "no lugar em que ela fala");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("2ª escuta: só fala longa sem palavra, com o texto de antes como prompt; a que começa no silêncio anda até a fala", () => {
  const { T } = load(() => ({ code: 0 }));
  const speech = [{ startMs: 0, endMs: 4000 }, { startMs: 5000, endMs: 5900 }, { startMs: 8000, endMs: 11000 }, { startMs: 12000, endMs: 13000 }];
  const words = [{ text: "Primeira", startMs: 100, endMs: 900 }, { text: "pergunta.", startMs: 900, endMs: 3800 }, { text: "fim", startMs: 12100, endMs: 12500 }];
  // 5-5,9 s: curto demais (ruído); 8-11 s: 3 s sem palavra -> ouve de 5 s (3 s antes, depois da última palavra) a 12 s
  assert.equal(JSON.stringify(T.unheardSpeech(speech, words, 2000, 13000)), JSON.stringify([{ fromMs: 5000, toMs: 12000, prompt: "Primeira pergunta." }]));
  assert.equal(T.unheardSpeech(speech.slice(0, 1), words, 2000, 13000).length, 0, "fala com palavra não volta");
  // buraco dentro de um trecho de fala com palavras (cliente 1 no Premiere: 60,1-76,9 s, palavras só até 68,6)
  const inner = T.unheardSpeech([{ startMs: 60070, endMs: 76900 }], [{ text: "sua", startMs: 60100, endMs: 67900 }, { text: "criança.", startMs: 67900, endMs: 68600 },
    { text: "Segunda", startMs: 77300, endMs: 78000 }], 2000, 90000);
  assert.equal(JSON.stringify(inner.map((g) => [g.fromMs, g.toMs])), JSON.stringify([[68600, 77300]]));
  const long = Array.from({ length: 60 }, (_, i) => ({ text: "palavra" + i, startMs: i * 60, endMs: i * 60 + 50 }));
  const prompt = T.unheardSpeech([{ startMs: 8000, endMs: 11000 }], long, 2000, 13000)[0].prompt;
  assert.ok(prompt.length <= 220 && /^palavra\d+ /.test(prompt) && /palavra59$/.test(prompt), "prompt: o fim do texto, sem meia palavra no começo");
  const sil = [{ startMs: 83500, endMs: 87000 }];
  const more = [{ text: "vale", startMs: 84100, endMs: 84600 }, { text: "contar.", startMs: 87500, endMs: 88100 }];
  assert.equal(JSON.stringify(T.alignToSpeech(more, sil).map((w) => [w.startMs, w.endMs])), JSON.stringify([[87000, 87500], [90400, 91000]]));
  assert.equal(T.alignToSpeech(more, [{ startMs: 80000, endMs: 84000 }]), more, "começando na fala, fica");
});

test("2ª escuta: a frase que a 1ª pôs fora do lugar (espalhada num silêncio) não sai duas vezes", () => {
  const { T } = load(() => ({ code: 0 }));
  const w = (text, s, e, quiet) => Object.assign({ text, startMs: s, endMs: e }, quiet ? { quiet } : {});
  // 2 tomadas juntadas (21/10): o Whisper espalhou a fala dela por 11 s de silêncio do vídeo anterior
  const first = [w("passagem\".", 7820, 9040), w("Mãe,", 9040, 11200), w("a", 11200, 11900), w("escola", 11900, 14380), w("te", 14380, 15110),
    w("disse", 15110, 17280), w("que", 17280, 17970), w("é", 17970, 19030), w("inclusiva,", 19030, 20530), w("só", 23880, 24000)];
  const again = [w("Mãe,", 20530, 21050, true), w("a", 21050, 21070, true), w("escola", 21070, 21630, true), w("te", 21630, 21890, true),
    w("disse", 21890, 22270, true), w("que", 22270, 22570, true), w("é", 22570, 22720, true), w("inclusiva.", 22720, 23750, true)];
  assert.deepEqual(T.dropEcho(first, again).map((x) => x.text), ["passagem\".", "só"]);
  // curta demais para ter certeza, ou longe (mais de 30 s antes): fica
  assert.equal(T.dropEcho(first, again.slice(0, 3)), first);
  assert.equal(T.dropEcho(first, again.map((x) => Object.assign({}, x, { startMs: x.startMs + 40000 }))), first);
});
