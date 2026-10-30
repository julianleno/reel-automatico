/* global AppLegendasCore, AppLegendasReelPlan, AppLegendasAI, AppLegendasTranscribe, AppLegendasRender, AppLegendasMotion, AppLegendasSpeed */
/**
 * Bruto -> MP4 sem Premiere, cronometrado por etapa. Reaproveita o núcleo do painel como está:
 * whisper (transcribe.js), silêncios (core/audio/silence.js), segmentos e destaques (core/captions)
 * e o desenho da legenda (render.js). O que é novo aqui é só a montagem com o ffmpeg:
 *   1. corte: select/aselect com os trechos que ficam (uma passada, sem arquivo por trecho)
 *   2. legenda: o canvas desenha cada quadro e manda RGBA pelo pipe; o ffmpeg põe por cima do vídeo
 *      cortado (overlay) e codifica. Quadro sem legenda não é desenhado: vai um buffer vazio pronto.
 */
/**
 * runReel(opts, hooks) -> { out, total, times }. hooks: { log(texto), step(etapa, detalhe),
 * progress(0..1) }. Sem tela (main.js --input), roda sozinha com as opções da URL; com tela
 * (ui.html), quem chama é o ui.js.
 */
window.runReel = async function (opts, hooks) {
  "use strict";
  hooks = hooks || {};
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { spawn } = require("child_process");

  const ROOT = path.resolve(__dirname, "../..");
  const BIN = path.join(ROOT, "src/adobe/cep/bin");
  const FFMPEG = path.join(BIN, "ffmpeg.exe");
  const WHISPER = path.join(BIN, "whisper/whisper-cli.exe");
  const MODELS = path.join(process.env.APPDATA || os.homedir(), "AppLegendas/models");
  const C = AppLegendasCore;

  const times = [];
  const t0 = Date.now();
  let lap = Date.now();
  function log(text) {
    if (hooks.log) hooks.log(text);
  }
  function step(name, detail) {
    const secs = (Date.now() - lap) / 1000;
    lap = Date.now();
    times.push({ etapa: name, segundos: Number(secs.toFixed(1)), detalhe: detail || "" });
    log("✔ " + name + " em " + secs.toFixed(1) + " s" + (detail ? " · " + detail : ""));
    if (hooks.step) hooks.step(name, detail || "");
    stopIfCancelled();
  }
  // Cancelar (tela): para entre as etapas; window.cancelReel interrompe o que está rodando agora
  function stopIfCancelled() {
    if (hooks.cancelled && hooks.cancelled()) throw new Error("Cancelado.");
  }
  let running = null;
  let segmenter = null; // o recortador da legenda atrás da pessoa (openSegmenter), um só por janela
  const aiStop = new AbortController(); // Cancelar também larga o pedido à IA que está esperando
  window.cancelReel = function () {
    if (running) {
      try { running.kill(); } catch (e) { /* já terminou */ }
    }
    AppLegendasTranscribe.cancelAll();
    aiStop.abort();
  };
  // IA (a ai-destaques do painel) com o código de acesso: melhores momentos, cortes, destaques e post.
  // Falhou uma vez, avisa e o resto da rodada segue pelas regras (ia.js).
  const IA = require(path.join(__dirname, "ia.js"));
  const ai = IA.session(AppLegendasAI, opts.aiCode, {
    signal: aiStop.signal,
    onFail: (what, why) => {
      const warning = IA.failMessage(why, !opts.preview);
      log("⚠ " + warning + " [falhou: " + what + "]");
      if (hooks.warn) hooks.warn(warning);
    },
  });

  function run(args, onStdout) {
    return new Promise((resolve, reject) => {
      const child = spawn(FFMPEG, args, { windowsHide: true });
      running = child;
      child.on("close", () => { if (running === child) running = null; });
      let err = "";
      child.stdout.on("data", (d) => onStdout && onStdout(String(d)));
      // inteiro: o probe de vídeo de iPhone tem kB de metadados antes da duração
      child.stderr.on("data", (d) => (err = (err + d).slice(-65536)));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve(err) : reject(new Error("ffmpeg " + code + ": " + err.trim().split("\n").pop()))));
    });
  }

  // encoder: o primeiro que codifica um quadro de teste (NVIDIA, o do Windows, OpenH264).
  // o do Windows (h264_mf) saía em Constrained Baseline; em High (perfil 100) a mesma taxa dá mais detalhe.
  // Se o High não abrir neste PC, tenta o mesmo sem perfil. -> ["-c:v", encoder, ...opções]
  let encoderFound = null;
  async function pickEncoder() {
    for (const [enc, extra] of encoderFound ? [] : [["h264_nvenc", []], ["h264_mf", ["-profile:v", "100"]], ["h264_mf", []], ["libopenh264", []]]) {
      try {
        await run(["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "color=s=256x256:d=0.2", "-c:v", enc].concat(extra, ["-f", "null", "-"]));
        encoderFound = ["-c:v", enc].concat(extra);
        break;
      } catch (e) {
        if (enc === "libopenh264") throw e;
      }
    }
    return encoderFound;
  }

  // as contas (mapa de tempo, corte, zoom, grafo do ffmpeg) ficam em plan.js, com testes
  const P = require(path.join(__dirname, "plan.js"));

  // Quem fala em cada janela de fala do bruto: 6 quadros por janela, rostos achados, boca medida
  // (16x16 em cinza). -> [{ from, to, x }] no tempo do vídeo cortado, ou null com menos de 2 pessoas.
  async function speakerPlan(srcW, cw, words, tm, probe, input, work) {
    require(path.join(__dirname, "../../src/core/video/speaker.js"));
    const S = window.AppLegendasSpeaker;
    const sw = words.map((w) => ({ text: w.text, start: w.startMs / 1000, end: w.endMs / 1000 }));
    const wins = S.speechWindows(sw, S.boundaryIndices(sw), probe.duration, 3);
    if (wins.length < 2) return null;
    const detector = new FaceDetector({ fastMode: true, maxDetectedFaces: 4 });
    let people = 0;
    const picks = [];
    for (let i = 0; i < wins.length; i += 1) {
      const [a, b] = wins[i];
      const dir = path.join(work, "fala" + i);
      fs.mkdirSync(dir, { recursive: true });
      await run(["-hide_banner", "-v", "error", "-y", "-ss", a.toFixed(2), "-t", (b - a).toFixed(2), "-i", input,
        "-vf", "fps=" + (6 / (b - a)).toFixed(4) + ",scale=640:-2", "-frames:v", "6", path.join(dir, "q%02d.jpg")]);
      const images = [];
      for (const name of fs.readdirSync(dir).sort()) {
        const img = new Image();
        img.src = "file:///" + path.join(dir, name).replace(/\\/g, "/");
        await img.decode();
        images.push(img);
      }
      const frames = await S.facesInImages(images, detector);
      const tracks = S.groupTracks(frames);
      people = Math.max(people, tracks.length);
      const who = S.pickSpeaker(tracks);
      picks.push(who ? S.trackCenter(who)[0] / 640 : null);
    }
    // uma pessoa que anda também é seguida (o recorte fixo a perderia)
    const xs = S.followPlan(picks, people);
    if (!xs) return null;
    const spans = wins.map(([a, b], i) => {
      const fx = xs[i];
      const x = Math.max(0, Math.min(srcW - cw, Math.round((fx * srcW - cw / 2) / 2) * 2));
      // from/to no tempo do Reel (o recorte do vídeo); rawFrom no tempo do bruto (a máscara da pessoa, --atras)
      return { from: tm.at(a * 1000) / 1000, to: tm.at(b * 1000) / 1000, x: x, rawFrom: a };
    }).filter((s) => s.to > s.from);
    spans.people = people;
    return spans;
  }

  let work = "";
  try {
    fs.mkdirSync(opts.out, { recursive: true });
    // pasta de trabalho de uma rodada que o app fechado no meio largou (fala.wav: ~115 MB por hora de vídeo)
    for (const old of fs.readdirSync(os.tmpdir()).filter((n) => /^reel-[A-Za-z0-9]{6}$/.test(n))) {
      try {
        if (Date.now() - fs.statSync(path.join(os.tmpdir(), old)).mtimeMs > 6 * 3600000) fs.rmSync(path.join(os.tmpdir(), old), { recursive: true, force: true });
      } catch (e) { /* em uso ou já foi */ }
    }
    work = fs.mkdtempSync(path.join(os.tmpdir(), "reel-"));
    // os arquivos do Reel: um, ou vários juntados na ordem (--juntar, ou a chave na tela)
    const inputs = opts.inputs && opts.inputs.length > 1 ? opts.inputs : [opts.input];
    for (const f of inputs) if (!f || !fs.existsSync(f)) throw new Error("não achei o arquivo " + (f || "") + ". Ele foi movido ou apagado?");
    const J = require(path.join(__dirname, "juntar.js"));
    const names = inputs.map((f) => path.basename(f).replace(/\.[^.]+$/, ""));
    const base = inputs.length > 1 ? J.joinName(names) : names[0];
    // o bruto para as palavras e a máscara guardadas: caminho(s), tamanho e data (um arquivo: como antes)
    const stats = inputs.map((f) => fs.statSync(f));
    const id = { input: inputs.join("|"), stat: stats.length === 1 ? stats[0] : { size: stats.reduce((n, s) => n + s.size, 0), mtimeMs: Math.max(...stats.map((s) => s.mtimeMs)) } };
    log("Bruto: " + inputs.join(" + ") + (opts.seconds ? " (primeiros " + opts.seconds + " s" + (inputs.length > 1 ? " de cada" : "") + ")" : ""));

    // o ffmpeg lê o arquivo; corrompido ou cortado no meio vira uma mensagem que o leigo entende
    const probeText = (f) => run(["-hide_banner", "-i", f, "-f", "null", "-t", "0", "-"]).catch(() => {
      throw new Error("não consegui ler " + path.basename(f) + ": o arquivo está estragado ou não é um vídeo.");
    });
    const notVideo = (f) => new Error((inputs.length > 1 ? path.basename(f) : "esse arquivo") + " não é um vídeo (foto ou só áudio?). Escolha o vídeo gravado.");
    const noSound = "o vídeo não tem som. O Reel automático corta e legenda pela fala; grave com o microfone ligado.";
    // 0. vários arquivos juntados ou o trecho de teste (opcional), e as informações do vídeo
    let input = opts.input;
    let joinPoints = []; // onde uma tomada emenda na outra (ms), com --juntar
    if (inputs.length > 1) {
      const items = [];
      const sigs = [];
      for (const f of inputs) {
        const text = await probeText(f);
        const p = Object.assign(AppLegendasSpeed.parseProbe(text), P.videoSize(text));
        if (!p.hasVideo || !(p.duration >= 0.5)) throw notVideo(f);
        if (opts.seconds) p.duration = Math.min(p.duration, opts.seconds);
        items.push(p);
        sigs.push(J.signature(text));
      }
      if (!items.some((p) => p.hasAudio)) throw new Error(noSound);
      const jfps = Math.round(items[0].fps) || 30;
      let joinAt = 0;
      for (const p of items.slice(0, -1)) joinPoints.push(Math.round((joinAt += p.duration) * 1000));
      const same = sigs.every((s) => s === sigs[0]);
      input = path.join(work, "juntos.mov");
      if (same) {
        const list = path.join(work, "juntos.txt");
        fs.writeFileSync(list, J.concatList(inputs, opts.seconds));
        await run(["-hide_banner", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-map", "0:v:0", "-map", "0:a:0", "-c", "copy", input]);
      } else {
        const args = ["-hide_banner", "-v", "error", "-y"];
        inputs.forEach((f) => args.push(...(opts.seconds ? ["-t", String(opts.seconds)] : []), "-i", f));
        await run(args.concat(["-filter_complex", J.joinGraph(items, items[0].W, items[0].H, jfps), "-map", "[v]", "-map", "[a]",
          ...(await pickEncoder()), "-b:v", "20000k", "-c:a", "aac", "-b:a", "256k", input]));
      }
      step("juntar", inputs.length + " vídeos" + (same ? ", mesmo formato (sem recodificar)" : " em " + items[0].W + "x" + items[0].H + ", " + jfps + " q/s"));
    } else if (opts.seconds) {
      input = path.join(work, "bruto.mp4");
      await probeText(opts.input);
      await run(["-hide_banner", "-v", "error", "-y", "-t", String(opts.seconds), "-i", opts.input, "-c", "copy", input]);
    }
    const probeOut = await probeText(input);
    const probe = AppLegendasSpeed.parseProbe(probeOut);
    // HDR do iPhone vira SDR BT.709 (plan.toneFilter): no Reel e na capa
    const tone = P.toneFilter(probeOut);
    // sem som não há fala para cortar nem legendar: diz isso em vez do erro do ffmpeg
    if (!probe.hasVideo || !(probe.duration >= 0.5)) throw notVideo(input); // foto: 1 quadro (0,04 s)
    if (!probe.hasAudio) throw new Error(noSound);
    const fps = Math.round(probe.fps) || 30;
    step("leitura", probe.duration.toFixed(1) + " s, " + fps + " q/s");

    // Para onde a pessoa olha (olhar.js, a malha do rosto), só no Reel na duração: roda junto com a transcrição
    const Olhar = require(path.join(__dirname, "olhar.js"));
    const gazeStart = Date.now();
    const gaze = opts.target > 0 && !opts.noGaze ? Olhar.measure({ ffmpeg: FFMPEG, input, dir: work, duration: probe.duration, signal: aiStop.signal,
      key: [id.input, id.stat.size, id.stat.mtimeMs, opts.seconds || 0].join("|") })
      .then((samples) => ({ samples, secs: (Date.now() - gazeStart) / 1000 }))
      .catch((e) => { log("⚠ olhar: " + ((e && e.message) || e)); return null; }) : null;

    // 1. áudio da fala
    const wav = path.join(work, "fala.wav");
    await AppLegendasTranscribe.extractWav({ ffmpegPath: FFMPEG, file: input, wavPath: wav });
    step("áudio");

    // 2. transcrição
    // "Refazer" na tela manda as palavras da rodada anterior: não precisa ouvir de novo
    const modelName = AppLegendasTranscribe.MODELS[opts.model] ? opts.model : "small-q8";
    const again = opts.words && opts.words.length ? opts.words : null;
    const wordsAt = P.wordsFile(path.join(os.tmpdir(), "reel-palavras"), id.input, id.stat, modelName, opts.seconds);
    const stored = again ? null : P.savedWords(wordsAt);
    // PC sem o painel: o modelo de voz é baixado uma vez só (o mesmo download do painel)
    if (!again && !stored && !AppLegendasTranscribe.hasModel(MODELS, modelName)) {
      log("baixando o modelo de voz " + modelName + " (uma vez só)");
      await AppLegendasTranscribe.downloadModel(MODELS, modelName, (f) => hooks.downloading && hooks.downloading(f));
    }
    // silêncios (ritmo Normal do painel), pelo áudio
    const buf = fs.readFileSync(wav);
    let at = 12;
    while (at + 8 <= buf.length && buf.toString("ascii", at, at + 4) !== "data") at += 8 + buf.readUInt32LE(at + 4);
    const env = C.createEnvelope(16000, 10);
    env.pushBytes(buf.subarray(at + 8));
    const db = env.finish();
    const cut = C.detectSilences(db, 10, { minSilenceMs: 500, paddingMs: 120 });
    const speechSilences = C.detectSilences(db, 10, C.SPEECH_SILENCE).silences;

    // relisten: a frase baixa que o Whisper pulou é ouvida de novo só onde há fala sem nenhuma palavra
    // (transcribe.js; as palavras dela vêm com quiet)
    const heard = again || stored || await AppLegendasTranscribe.transcribeWav({
      whisperPath: WHISPER,
      modelPath: AppLegendasTranscribe.modelPath(MODELS, modelName),
      wavPath: wav,
      language: "pt",
      relisten: { speech: C.keepRanges(cut.silences, cut.totalMs), silences: speechSilences },
      onWait: () => {
        log("esperando outra transcrição terminar neste PC");
        if (hooks.waiting) hooks.waiting();
      },
      onProgress: (f) => hooks.listening && hooks.listening(f),
    });
    if (!again && !stored) P.saveWords(wordsAt, heard);
    const extra = again || stored ? 0 : heard.filter((w) => w.quiet).length;
    let words = heard.map((w) => Object.assign({}, w));
    step("transcrição", words.length + " palavras" + (again ? " (da rodada anterior)" : stored ? " (guardadas deste vídeo)" : ", modelo " + modelName) +
      (extra ? " (" + extra + " de uma 2ª escuta de fala baixa)" : ""));

    // 3. tempo das palavras afinado pelo áudio; a frase baixa fica protegida palavra a palavra, nesses tempos
    words = C.snapWordsToSpeech(words, speechSilences);
    const silences = P.keepQuietSpeech(cut.silences, words, 120);
    // vícios saem sempre (como no Autocorte); repetição e retake só com --repeticoes: no painel elas
    // passam pela conferência do editor, e aqui não há tela para conferir
    let risky = opts.retakes ? C.findRetakes(words).concat(C.findOffscript(words)) : [];
    // Boost (com o código): a IA lê o bruto e aponta retake, ensaio e fala fora que as regras não pegam
    // ("Domingos Garcia… Domingos Garcia" no bruto de 3 min ficava). Na duração pedida quem escolhe é o plano.
    if (opts.retakes && ai.on && !(opts.target > 0)) {
      const fromAi = await ai.cuts(words, C.timingReliable);
      if (fromAi) {
        risky = IA.mergeCuts(risky, fromAi);
        log("IA (Boost): " + fromAi.length + " trecho(s) para sair" + (fromAi.length ? ": " + fromAi.map((c) => c.kind + " \"" + c.text + "\"").join(", ") : ""));
      }
    }
    // Trava: sem ninguém para conferir, repetição que leva mais de 40% da fala é suspeita (num
    // trecho de 30 s com duas versões do gancho e a final fora do trecho, as duas saíam e sobravam
    // 2,7 s). Aí as repetições ficam e o aviso explica; os vícios saem do mesmo jeito.
    const pauses = opts.noPauses ? [] : silences;
    const kept = (list) => P.timeMap(C.keepRanges(list.slice().sort((a, b) => a.startMs - b.startMs), cut.totalMs)).totalMs;
    const speechMs = kept(pauses);
    const share = risky.length && speechMs ? 1 - kept(pauses.concat(risky)) / speechMs : 0;
    if (share > 0.4) {
      const warning = "Repetições não cortadas: tirariam " + Math.round(share * 100) + "% da fala. Confira o vídeo.";
      log("⚠ " + warning);
      if (hooks.warn) hooks.warn(warning);
      risky = [];
    }
    const found = C.findFillers(words, C.DEFAULT_FILLERS).concat(risky);
    // Reel na duração pedida (--duracao, ou a tela): o que fica do bruto é escolhido inteiro, em frases
    // (a IA com o código de acesso; sem ele, as frases em ordem sem as repetições) e o resto sai. Dentro
    // do que fica, pausas e vícios saem como sempre.
    let reel = null;
    if (opts.target > 0) {
      const R = AppLegendasReelPlan;
      const mid = (w) => (w.startMs + w.endMs) / 2;
      const toRange = (c) => {
        const ids = words.map((w, i) => i).filter((i) => mid(words[i]) >= c.startMs && mid(words[i]) < c.endMs);
        return ids.length ? { from: ids[0], to: ids[ids.length - 1] } : null;
      };
      const localRemoved = C.findRetakes(words).concat(C.findOffscript(words)).map(toRange).filter(Boolean);
      if (opts.planFile) reel = JSON.parse(fs.readFileSync(opts.planFile, "utf8"));
      else reel = await ai.reel(words, opts.target);
      if (!reel || !reel.segments.length) reel = { segments: R.fallback(words, opts.target * 1000, localRemoved), zooms: [], title: "", hook: "", source: "local" };
      // frase inteira dita sem olhar a câmera (olhando o paletó, lendo) perde a vez se outras completam a duração
      const looked = gaze && await gaze;
      if (looked) {
        const away = Olhar.awaySentences(R.strongSentences(words), words, looked.samples);
        const was = reel.segments;
        reel.segments = R.avoid(reel.segments, words, opts.target * 1000, localRemoved, away);
        const text = (u) => "\"" + words.slice(u.from, u.to + 1).map((w) => w.text).join(" ") + "\"";
        log("olhar: " + looked.samples.filter((s) => s.face).length + " de " + looked.samples.length + " quadros com rosto em " + looked.secs.toFixed(1) + " s; " +
          (away.length ? away.length + " frase(s) sem olhar a câmera: " + away.map(text).join(", ") + (reel.segments === was ? " (ficam: sem elas não dá a duração)" : "") : "todas olhando a câmera"));
      }
      // nenhum trecho começa ou termina no meio da frase (o Reel pulava de "gostava muito de" para outra frase)
      reel.segments = IA.closeSentences(reel.segments, words, localRemoved);
      step("melhores momentos", R.totalMs(reel.segments, words) / 1000 + " s de fala em " + reel.segments.length + " trecho(s), meta " + opts.target + " s (" +
        { reel: "IA", cuts: "IA: cortes", clips: "IA: melhores trechos", local: "sem IA" }[reel.source] + ")" + (reel.title ? ": " + reel.title : ""));
    }
    // sem "tirar as pausas", só os vícios/repetições saem
    const keepFor = (segments) => {
      const cuts = (opts.noPauses ? [] : silences).concat(found.map((c) => ({ startMs: c.startMs, endMs: c.endMs })))
        .concat(segments ? AppLegendasReelPlan.cutsOutside(segments, words, cut.totalMs) : []).sort((a, b) => a.startMs - b.startMs);
      return P.dropStrayNoise(J.splitAt(C.keepRanges(cuts, cut.totalMs), joinPoints).filter((r) => r.endMs - r.startMs >= 100), words);
    };
    let keep = keepFor(reel && reel.segments);
    // a conta do plano é uma estimativa: passando de 10% da meta, refaz com a meta proporcional (no fim de frase)
    const keptMs = (list) => list.reduce((sum, r) => sum + r.endMs - r.startMs, 0);
    if (reel && keptMs(keep) > opts.target * 1100) {
      const scaled = (opts.target * 1000 * opts.target * 1000) / keptMs(keep);
      reel.segments = AppLegendasReelPlan.trimTo(reel.segments, words, scaled);
      keep = keepFor(reel.segments);
    }
    // sem nenhuma palavra (só ruído ou música) não há o que cortar pela fala: fica o vídeo inteiro, sem
    // legenda e com o aviso (o select vazio do ffmpeg fazia o mesmo, mas por acaso)
    if (!keep.length) keep = [{ startMs: 0, endMs: cut.totalMs }];
    // folga de editor em cada emenda (plan.hugWords: 80 ms antes da 1ª palavra, 100 depois da última, 500 no
    // fim do Reel), nenhum plano de menos de 0,4 s (plan.holdShots) e imagem e som cortando no mesmo quadro
    // (plan.snapKeep); o mapa das legendas usa os mesmos trechos
    // a folga conta do fim da voz, não do fim do Whisper; a emenda que cai dentro da voz vai para o silêncio ou o vale
    const voiced = (ms) => db[Math.floor(ms / 10)] >= cut.thresholdDb;
    const clearVoice = (ms) => db[Math.floor(ms / 10)] >= cut.thresholdDb + 12;
    keep = C.settleEdges(keep, words, db, 10, cut.thresholdDb, 120, 500);
    keep = P.snapKeep(P.holdShots(P.hugWords(keep, words, 80, 100, 500, voiced, clearVoice), 400), fps);
    // a mesma voz em todos os trechos (o nivelar do painel: core voiceLevel/levelGains): a tomada mais longe do
    // microfone pulava 7 a 9 dB na emenda (juiz, 21/10)
    const lv = C.levelGains(keep.map((r) => C.voiceLevel(db.slice(Math.floor(r.startMs / 10), Math.ceil(r.endMs / 10)), 10)));
    keep.forEach((r, i) => { r.gainDb = lv.gains[i]; });
    const tm = P.timeMap(keep);
    step("silêncios", silences.length + " pausas, " + found.length + " vício(s)/repetição(ões): " +
      found.map((c) => "\"" + (c.text || c.kind) + "\"").join(", ") + "; " + ((cut.totalMs - tm.totalMs) / 1000).toFixed(1) + " s a menos");

    const encArgs = await pickEncoder();
    const encoder = encArgs[1];

    // 4. corte: os trechos que ficam num select/aselect (a lista vai num arquivo: a linha de comando
    // tem limite). Com --uma-passada o corte entra na passada final e não há arquivo intermediário.
    const cutF = P.cutFilters(keep, fps);
    let source, W, H, count;
    if (opts.onePass) {
      // tamanho já girado (vídeo de celular vem deitado com "rotation of -90") e quadros que o select deixa
      ({ W, H } = P.videoSize(await run(["-hide_banner", "-i", input, "-f", "null", "-t", "0", "-"])));
      count = P.keptFrameCount(keep, fps);
      source = input;
      step("corte", keep.length + " trechos, " + (count / fps).toFixed(1) + " s (na passada final)");
    } else {
      const graph = path.join(work, "corte.txt");
      fs.writeFileSync(graph, "[0:v]" + cutF.video + "[v];[0:a]" + cutF.audio + "[a]");
      source = path.join(work, "cortado.mp4");
      await run(["-hide_banner", "-v", "error", "-y", "-i", input, "-/filter_complex", graph, "-map", "[v]", "-map", "[a]",
        ...encArgs, "-b:v", "12000k", "-pix_fmt", "yuv420p", "-r", String(fps), "-c:a", "aac", "-b:a", "192k", source]);
      const info = await run(["-hide_banner", "-i", source, "-f", "null", "-t", "0", "-"]);
      ({ W, H } = P.videoSize(info));
      count = Math.round(AppLegendasSpeed.parseProbe(info).duration * fps);
      step("corte", keep.length + " trechos, " + (count / fps).toFixed(1) + " s, " + encoder);
    }

    // Rosto: o detector do Chromium (main.js liga a opção; no Windows ele usa o do sistema) olha 5
    // quadros ao longo do vídeo. Ele decide o recorte em pé do bruto deitado e o ponto que o zoom
    // mantém parado. Daqui em diante W e H são os da saída.
    const boxes = [];
    let sampleH = 0;
    if (typeof FaceDetector !== "undefined") { // recorte, zoom e a legenda que desvia do rosto
      const detector = new FaceDetector({ fastMode: true, maxDetectedFaces: 1 });
      // os 5 quadros num ffmpeg só (grabFrames do face-box.js do painel), não um por quadro
      const tf = performance.now();
      const jpgs = await AppLegendasFaceBox.grabFrames({ ffmpegPath: FFMPEG, path: input, width: 640, dir: work,
        seconds: [1, 2, 3, 4, 5].map((k) => ((probe.duration || 10) * k) / 6) });
      for (const jpg of jpgs) {
        if (!jpg) continue;
        try {
          const img = new Image();
          img.src = "file:///" + jpg.replace(/\\/g, "/");
          await img.decode();
          sampleH = img.naturalHeight;
          const faces = await detector.detect(img);
          if (faces.length) boxes.push(faces[0].boundingBox);
        } catch (e) { /* quadro sem rosto ou que não abriu: os outros decidem */ }
      }
      log("rosto: " + boxes.length + " de 5 quadros em " + ((performance.now() - tf) / 1000).toFixed(1) + " s");
    }
    const faceX = P.faceCenter(boxes, 640);
    const srcW = W, srcH = H;
    // enquadramento à mão (tela: controle deslizante), 0..1 da largura: manda sobre o rosto e quem fala
    const manual = typeof opts.manualX === "number" && opts.manualX >= 0 && opts.manualX <= 1 ? opts.manualX : null;
    // prévia rápida: metade do tamanho (a legenda e o vídeo saem 4x mais leves), sem capa
    const rf = P.reframe(W, H, manual !== null ? manual : faceX === null ? undefined : faceX, opts.format, opts.preview ? 0.5 : 1);
    if (rf.crop) log("bruto " + W + "x" + H + " vira " + rf.W + "x" + rf.H + (W > H ? (faceX === null ? ", recorte no centro (sem rosto)" : ", recorte no rosto, a " + Math.round(faceX * 100) + "% da largura") : ""));
    // "Duas pessoas" (podcast): a da esquerda em cima e a da direita embaixo, cada uma no seu rosto
    // (speaker.js, como o Open Clip). Precisa achar duas pessoas no vídeo; senão segue o normal.
    let stacked = false;
    if (manual === null && opts.layout === "duas" && srcW > srcH && typeof FaceDetector !== "undefined") {
      require(path.join(__dirname, "../../src/core/video/speaker.js"));
    const S = window.AppLegendasSpeaker;
      const detector = new FaceDetector({ fastMode: true, maxDetectedFaces: 4 });
      const frames = [];
      let scale = 1;
      for (let k = 1; k <= 8; k += 1) {
        const jpg = path.join(work, "duas" + k + ".jpg");
        try {
          await run(["-hide_banner", "-v", "error", "-y", "-ss", ((probe.duration || 10) * k / 9).toFixed(2), "-i", input, "-vf", "scale=640:-2", "-frames:v", "1", jpg]);
          const img = new Image();
          img.src = "file:///" + jpg.replace(/\\/g, "/");
          await img.decode();
          scale = srcW / img.naturalWidth;
          const faces = await detector.detect(img);
          frames.push(faces.map((f) => ({ x: f.boundingBox.x * scale, y: f.boundingBox.y * scale, w: f.boundingBox.width * scale, h: f.boundingBox.height * scale })));
        } catch (e) { /* quadro que não abriu */ }
      }
      const people = S.groupTracks(frames).sort((a, b) => b.faces.length - a.faces.length).slice(0, 2);
      if (people.length === 2) {
        people.sort((a, b) => S.trackCenter(a)[0] - S.trackCenter(b)[0]);
        rf.crop = S.stackedFilter(S.panelCrop(people[0].faces, srcW, srcH), S.panelCrop(people[1].faces, srcW, srcH));
        rf.W = 1080;
        rf.H = 1920;
        stacked = true;
        log("duas pessoas: esquerda em cima, direita embaixo");
      } else {
        log("duas pessoas: só " + people.length + " achada(s); recorte normal");
      }
    }

    // Duas pessoas ou mais no bruto deitado (podcast, entrevista): o recorte vai para quem fala,
    // trocando só no fim de uma fala (speaker.js, lógica do Open Clip).
    const cwMatch = /^crop=(\d+):(\d+):/.exec(rf.crop);
    const spans = manual === null && !stacked && srcW > srcH && cwMatch && typeof FaceDetector !== "undefined" && !opts.noSpeaker
      ? await speakerPlan(srcW, Number(cwMatch[1]), words, tm, probe, input, work) : null;
    if (spans) {
      require(path.join(__dirname, "../../src/core/video/speaker.js"));
    const S = window.AppLegendasSpeaker;
      rf.crop = rf.crop.replace(/^crop=(\d+):(\d+):[^:]+:0/, "crop=$1:$2:'" + S.cropXExpr(spans) + "':0");
      log((spans.people > 1 ? "quem fala: " : "acompanha a pessoa: ") + spans.length + " trecho(s), recorte troca de pessoa " + spans.filter((s, i) => i && s.x !== spans[i - 1].x).length + " vez(es)");
    }
    // fração da largura do bruto que o recorte guardou, para pôr o rosto no quadro de saída
    const cropX = /crop=(\d+):\d+:(\d+):/.exec(rf.crop);
    const keptCrop = rf.crop ? (cropX ? { x0: Number(cropX[2]) / srcW, w: Number(cropX[1]) / srcW } : { x0: (1 - (srcH * 9 / 16) / srcW) / 2, w: (srcH * 9 / 16) / srcW }) : null;
    const focus = P.zoomFocus(boxes, 640, sampleH || 640 * srcH / srcW, keptCrop);
    if (spans) focus.x = 0.5; // o recorte já está em quem fala
    if (stacked) {
      focus.x = 0.5; // empilhado: o zoom cresce do meio, entre as duas pessoas
      focus.y = 0.5;
    }
    if (boxes.length) log("zoom centrado no rosto (" + Math.round(focus.x * 100) + "%, " + Math.round(focus.y * 100) + "% do quadro)");
    W = rf.W;
    H = rf.H;

    // 5. legendas no tempo do vídeo cortado
    const mapped = P.sentenceCase(P.oddQuotes(words.map((w) => tm.word(w)).filter(Boolean)));
    // halo: contorno escuro curto que segura a letra branca em fundo claro e cheio (render.js); --sem-halo desliga
    const style = Object.assign({}, AppLegendasRender.DEFAULT_STYLE, AppLegendasRender.PRESETS[opts.style] || {}, { preset: opts.style, halo: !opts.noHalo });
    // Legenda desvia do rosto (o core/captions/faceaware.js do painel): no 9:16 a altura do rosto é a
    // do bruto (o recorte é só na largura); se a faixa da legenda cai nele, sobe ou desce sem sair
    // da área segura dos apps. Empilhado (duas pessoas) fica onde está.
    const face = !stacked && opts.format !== "feed" && opts.format !== "quadrado" ? P.faceSpan(boxes, sampleH) : null;
    // atrás da pessoa: a legenda vai para a altura do rosto (a cabeça é mais estreita que o texto: as
    // pontas aparecem dos lados e a cabeça passa na frente); aí não há o que desviar
    const behind = !!(opts.behind && opts.onePass && window.AppLegendasPersonMatte);
    if (behind && face) {
      style.positionY = Math.round(((face.top + face.bottom) / 2) * 1000) / 10;
      log("legenda atrás da pessoa: na altura do rosto (" + style.positionY + "%)");
    }
    const dodged = face && !behind ? C.dodgeFace(face, C.captionBand(style, { width: W, height: H }), C.safeLimits(C.SAFE_ZONES, [])) : null;
    if (dodged !== null) {
      log("legenda desvia do rosto: altura " + style.positionY + "% -> " + dodged + "% (rosto de " + Math.round(face.top * 100) + "% a " + Math.round(face.bottom * 100) + "%)");
      style.positionY = dodged;
    }
    // correções da tela ("errado = certo", o mesmo dicionário do painel)
    const fixes = opts.fixes ? C.parseCorrections(opts.fixes) : [];
    const items = C.applyCorrections(C.itemsFromWords(mapped), fixes).items;
    const built = C.buildSegments(items, { maxWords: 4, maxLines: 2 });
    // destaques (cor, zoom e som) pela IA, como a Capi do painel; sem código ou com erro, pelas regras
    const keys = ai.on && built.segments.length ? await ai.keys(built.segments) : null;
    if (keys) log("IA escolheu " + keys.length + " destaque(s)");
    // legenda que pisca segura até 0,5 s e não some por menos de 0,4 s antes da seguinte (plan.holdCaptions)
    const segments = P.holdCaptions(C.decorateSegments(built.segments, { keys: keys || undefined }), 0.5);
    // texto do post (título, legenda, hashtags) da fala que ficou no Reel: pede já e espera no fim
    const postJob = ai.on && !opts.preview && segments.length
      ? ai.post([].concat(...segments.map((s) => s.words.map((w) => ({ text: w.text, startMs: w.inSeconds * 1000, endMs: w.outSeconds * 1000 }))))) : null;
    if (!segments.length) {
      const warning = "Não ouvi fala no vídeo: o Reel saiu sem legenda.";
      log("⚠ " + warning);
      if (hooks.warn) hooks.warn(warning);
    }
    step("legendas", segments.length + " legendas, estilo " + opts.style);

    // 6. legenda desenhada por cima e codificada (canvas -> pipe -> overlay)
    const canvas = document.getElementById("tela") || document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    // o primeiro getContext define o modo: com leitura frequente, o canvas fica na CPU (o desfoque
    // na CPU sai mais caro que trazer o quadro da GPU: 9 q/s contra 11 q/s, medido em 19/10)
    const ctx = canvas.getContext("2d", { willReadFrequently: !!opts.cpuCanvas });
    let tDraw = 0, tRead = 0;
    // frase curta (até 2 palavras) num segundo estilo, como no painel (mixShort), na mesma altura
    const shortPreset = AppLegendasRender.PRESETS[opts.shortStyle];
    // cor da marca (MVP do estudo): pinta a palavra em destaque, também na frase curta
    const brand = /^#[0-9a-f]{6}$/i.test(String(opts.brandColor || "")) ? opts.brandColor : "";
    if (brand) style.activeColor = brand;
    const shortStyle = shortPreset ? Object.assign({}, AppLegendasRender.DEFAULT_STYLE, shortPreset, { preset: opts.shortStyle, positionY: style.positionY, halo: style.halo }, brand ? { activeColor: brand } : {}) : null;
    const styleOf = (s) => (shortStyle && s.words.length <= 2 ? shortStyle : style);
    // a da frase, a segunda fonte e a 900 (o 3D e o marca-texto das Letras do Jota): o canvas não baixa a fonte sozinho
    for (const st of shortStyle ? [style, shortStyle] : [style]) {
      for (const f of [st.fontFamily, st.font2].filter(Boolean)) {
        for (const w of [st.fontWeight || "700", "900"]) await document.fonts.load(w + " " + st.fontSize + "px \"" + f + "\"").catch(() => {});
      }
    }
    if (shortStyle) log("frase curta no estilo " + opts.shortStyle + ": " + segments.filter((s) => s.words.length <= 2).length + " de " + segments.length);
    function drawAt(s, elapsed) {
      const active = AppLegendasMotion.activeAt(s, elapsed);
      AppLegendasRender.drawFrame(canvas, {
        words: s.words.map((w) => w.text), active: active.index, keys: s.words.map((w) => !!w.key), emoji: s.emoji || "",
        starts: s.words.map((w) => w.inSeconds - s.inSeconds),
      }, styleOf(s), { ageSeconds: active.ageSeconds, elapsed: elapsed });
    }
    // Faixa da tela onde a legenda aparece: cada legenda desenhada no instante em que cada palavra
    // entra (o ponto mais longe do lugar, nas entradas que vêm de fora) e no fim; soma das linhas com
    // tinta, com folga para o desfoque. Só essa faixa é lida do canvas e vai pelo pipe.
    // Mede as linhas com tinta: "all" junta todos os instantes (com a entrada, que pode vir de fora do
    // lugar); "still" só a legenda parada, no fim de cada uma (a altura de verdade, para desviar do rosto).
    // Os instantes vão sendo empilhados (drawImage, na placa) em duas telas, e cada uma é lida uma vez só:
    // ler a tela inteira a cada instante levava 3 a 4 s num Reel de 16 s (2.MOV, 21/10).
    const measure = () => {
      const stack = () => {
        const c = document.createElement("canvas");
        c.width = W;
        c.height = H;
        return c.getContext("2d");
      };
      const all = stack(), still = stack();
      segments.forEach((s) => {
        s.words.forEach((w) => {
          drawAt(s, w.inSeconds - s.inSeconds + 0.001);
          all.drawImage(canvas, 0, 0);
        });
        drawAt(s, s.outSeconds - s.inSeconds - 0.001);
        all.drawImage(canvas, 0, 0);
        still.drawImage(canvas, 0, 0);
      });
      const rows = (g) => {
        const d = g.getImageData(0, 0, W, H).data;
        let top = H, bottom = -1;
        for (let y = 0; y < H; y += 1) {
          const row = y * W * 4;
          for (let x = 3; x < W * 4; x += 16) {
            if (d[row + x]) {
              top = Math.min(top, y);
              bottom = Math.max(bottom, y);
              break;
            }
          }
        }
        return [top, bottom];
      };
      const [top, bottom] = rows(all);
      const [stillTop, stillBottom] = rows(still);
      return { top, bottom, stillTop, stillBottom };
    };
    let band = { y: 0, h: H };
    if (!opts.fullFrame && segments.length) {
      const tb = performance.now();
      let m = measure();
      // a altura estimada (2 linhas) pode errar: com a faixa parada medida, confere o rosto de novo
      if (face && !behind && m.stillBottom >= m.stillTop) {
        const real = { center: (m.stillTop + m.stillBottom) / 2 / H, half: (m.stillBottom - m.stillTop) / 2 / H };
        const y2 = C.dodgeFace(face, real, C.safeLimits(C.SAFE_ZONES, []));
        if (y2 !== null) {
          const before = style.positionY;
          style.positionY = Math.round((Number(style.positionY) + y2 - real.center * 100) * 10) / 10;
          if (shortStyle) shortStyle.positionY = style.positionY;
          log("legenda desvia do rosto (medida): " + before + "% -> " + style.positionY + "% (legenda de " + Math.round(real.center * 100 - real.half * 100) + "% a " + Math.round(real.center * 100 + real.half * 100) + "%)");
          m = measure();
        } else if (real.center + real.half > face.top - 0.02 && real.center - real.half < face.bottom + 0.02) {
          const warning = "A legenda deste estilo é alta demais para sair de cima do rosto (" + Math.round(real.half * 200) + "% da tela). Um estilo de letra menor resolve.";
          log("⚠ " + warning);
          if (hooks.warn) hooks.warn(warning);
        }
      }
      if (m.bottom >= m.top) {
        const pad = Math.round(H * 0.03);
        const y0 = Math.max(0, m.top - pad) & ~1;
        const y1 = Math.min(H, m.bottom + pad + 2) & ~1;
        band = { y: y0, h: y1 - y0 };
      }
      log("faixa da legenda: y " + band.y + " a " + (band.y + band.h) + " (" + Math.round((band.h / H) * 100) + "% da tela), medida em " + ((performance.now() - tb) / 1000).toFixed(1) + " s");
    }
    const empty = new Uint8ClampedArray(W * band.h * 4);
    // o formato vai no nome (fora o em pé): "Todos os formatos" faz os três sem um sobrescrever o outro
    // feito na pasta de trabalho; no fim vai para opts.out (abaixo)
    const out = path.join(work, base + " reel " + opts.style + (opts.format && opts.format !== "reels" ? " " + opts.format : "") + (opts.preview ? " previa" : "") + ".mp4");
    let drawn = 0, seg = 0;
    // Legenda parada: 5 quadros iguais seguidos na mesma palavra = assentou (medido em 20/10: nos 31 estilos,
    // no máximo 3 iguais e depois muda de novo, na diagonal e no "Sobe e assenta"); até a próxima palavra
    // (ou o fim da legenda) o mesmo quadro vai de novo, sem desenhar nem ler o canvas.
    let lastPx = null, same = 0, holdUntil = -1, reused = 0;
    const encStart = Date.now();
    // zoom nos destaques (core.zoomMoments, o mesmo do painel): 12% com rampa de 0,25 s, puxado
    // para o terço de cima, onde fica o rosto. scale+crop: escala contínua, sem o tremido do zoompan.
    // com o Reel da IA, os momentos-chave que ela escolheu; senão os destaques das legendas
    const aiZooms = reel && reel.zooms.length ? reel.zooms.map((n) => tm.word(words[n])).filter(Boolean)
      .map((w) => ({ inSeconds: w.startMs / 1000, outSeconds: w.startMs / 1000 + 1.5 })) : [];
    const zooms = opts.noZoom ? [] : aiZooms.length ? aiZooms : C.zoomMoments(segments, { gapSeconds: 5, keys: keys || undefined });
    // sons próprios do app (src/adobe/cep/sfx): estalo na entrada da legenda (no máximo a cada 2 s)
    // e uma batida grave quando o zoom entra
    const SFX = path.join(ROOT, "src/adobe/cep/sfx");
    const pops = opts.noSfx ? [] : C.sfxSlots(segments.map((s) => s.inSeconds), { seconds: 0.3, minSeconds: 2 });
    const hits = opts.noSfx ? [] : zooms.map((z) => ({ inSeconds: z.inSeconds }));
    const fx = pops.map((p) => ({ at: p.inSeconds, input: 2, vol: 0.3 })).concat(hits.map((h) => ({ at: h.inSeconds, input: 3, vol: 0.45 })));
    const music = !!(opts.music && fs.existsSync(opts.music));
    // Batida no momento certo (o Som do Jota; src/core/audio/drop.js e src/motion-jota/trilha-jota.js): a música é
    // posta para o drop cair na 1ª palavra-chave do gancho (ou no fim dele), 20 dB abaixo da voz, abafada nos 2 s finais
    // e com fade. Sem drop claro ou música curta, toca como antes (do começo, em loop, abaixando na fala).
    let jotaMusic = null, musicInfo = null;
    if (music && !opts.noDrop) {
      const raw = path.join(work, "musica.f32");
      await run(["-hide_banner", "-v", "error", "-y", "-i", opts.music, "-ac", "1", "-ar", "22050", "-f", "f32le", raw]);
      const b = fs.readFileSync(raw);
      const song = C.analyzeMusic(new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + (b.length & ~3))), 22050);
      const reelS = tm.totalMs / 1000;
      const hook = P.hookMoment(segments);
      const placed = hook && C.placeDrop(song, { at: hook.at, seconds: reelS });
      if (placed) {
        const delay = Math.max(0, -placed.start);
        const loud = require(path.join(ROOT, "src/motion-jota/trilha-jota.js")).lufs(await run(["-hide_banner", "-nostats", "-ss", Math.max(0, placed.start).toFixed(3),
          "-t", (reelS - delay).toFixed(3), "-i", opts.music, "-af", "ebur128=framelog=quiet", "-f", "null", "-"]));
        jotaMusic = { start: placed.start, gainDb: P.MUSIC_LUFS - (loud === null ? -14 : loud), dur: reelS, abafar: [[Math.max(0, reelS - 2), reelS + 1, 700]], fade: 1.6 };
        musicInfo = { drop: hook.at, palavra: hook.text, faixa: placed.drop.exato, bpm: song.bpm, lufs: loud };
        log("música: drop aos " + placed.drop.exato.toFixed(2) + " s da faixa (" + song.bpm + " BPM) cai em " + hook.at.toFixed(2) + " s, em " + hook.text +
          "; " + loud + " LUFS -> " + P.MUSIC_LUFS);
      } else {
        const warning = "A batida da música não deu para cair no começo do Reel (música curta ou sem uma entrada forte de batida): ela toca do começo.";
        log("⚠ " + warning + " [" + song.drops.map((d) => d.t + " s x" + d.contraste).join(", ") + "]");
        if (hooks.warn) hooks.warn(warning);
      }
    }
    // Moldura da marca (como as do Open Clip): nome do negócio no topo e @perfil embaixo, num PNG
    // transparente do tamanho do quadro, desenhado uma vez e posto por cima do vídeo inteiro.
    const brandTop = String(opts.brandTop || "").trim();
    const brandBottom = String(opts.brandBottom || "").trim();
    let framePng = "";
    if (brandTop || brandBottom) {
      await document.fonts.load('700 80px "Poppins"');
      await document.fonts.load('600 80px "Poppins"');
      const fc = document.createElement("canvas");
      fc.width = W;
      fc.height = H;
      const g = fc.getContext("2d");
      const strip = (y0, y1, down) => {
        const grad = g.createLinearGradient(0, y0, 0, y1);
        grad.addColorStop(down ? 0 : 1, "rgba(0,0,0,0.55)");
        grad.addColorStop(down ? 1 : 0, "rgba(0,0,0,0)");
        g.fillStyle = grad;
        g.fillRect(0, y0, W, y1 - y0);
      };
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.shadowColor = "rgba(0,0,0,0.6)";
      g.shadowBlur = H * 0.006;
      if (brandTop) {
        g.save();
        g.shadowBlur = 0;
        strip(0, H * 0.16, true);
        g.restore();
        g.fillStyle = "#ffffff";
        g.font = '700 ' + Math.round(H * 0.034) + 'px "Poppins"';
        g.fillText(brandTop, W / 2, H * 0.075, W * 0.88);
      }
      if (brandBottom) {
        g.save();
        g.shadowBlur = 0;
        strip(H * 0.86, H, false);
        g.restore();
        g.fillStyle = "#ffffff";
        g.font = '600 ' + Math.round(H * 0.026) + 'px "Poppins"';
        g.fillText(brandBottom, W / 2, H * 0.93, W * 0.88);
      }
      framePng = path.join(work, "moldura.png");
      fs.writeFileSync(framePng, Buffer.from(fc.toDataURL("image/png").split(",")[1], "base64"));
      log("moldura: " + [brandTop, brandBottom].filter(Boolean).join(" / "));
    }
    const frameInput = framePng ? (music ? 5 : 4) : 0;
    // Legenda atrás da pessoa (opção, mais lenta): a máscara do recortador do painel (services/person-matte.js),
    // cinza e pequena, no tempo do bruto; no grafo ela vira o alfa e a pessoa passa por cima da legenda.
    // Só na passada única (a máscara precisa do mesmo tempo do bruto que o corte usa).
    let maskFile = "";
    if (behind) {
      // a máscara do mesmo vídeo fica guardada: a prévia que se refaz sozinha não recorta de novo
      // bruto deitado: o recortador olha só o pedaço que aparece no Reel (o view do person-matte), bem mais fiel
      const view = !stacked && srcW > srcH && cwMatch ? {
        scale: (H / srcH) * 100, position: [0.5, 0.5], seqWidth: W, seqHeight: H,
        anchors: spans ? spans.map((sp) => [(sp.x + Number(cwMatch[1]) / 2) / srcW, 0.5]) : [[keptCrop.x0 + keptCrop.w / 2, 0.5]],
        // o recortador olha a pessoa de cada trecho (a união das duas cobria quase o quadro inteiro e a cabeça
        // ficava pequena demais: o topo dela sumia da máscara, a legenda passava na frente)
        spans: spans ? spans.map((sp) => ({ from: sp.rawFrom, anchor: [(sp.x + Number(cwMatch[1]) / 2) / srcW, 0.5] })) : null,
      } : null;
      const key = require("crypto").createHash("sha1").update(["trechos3", id.input, id.stat.size, id.stat.mtimeMs, opts.seconds || 0, fps, JSON.stringify(view)].join("|")).digest("hex").slice(0, 16);
      const cacheDir = path.join(os.tmpdir(), "reel-mascaras");
      fs.mkdirSync(cacheDir, { recursive: true });
      maskFile = path.join(cacheDir, key + ".mkv");
      if (fs.existsSync(maskFile)) {
        step("pessoa recortada", "a máscara guardada deste vídeo");
      } else {
        const userDir = path.join(process.env.APPDATA || os.homedir(), "AppLegendas", "recortador");
        await AppLegendasPersonMatte.ensureFiles(userDir, AppLegendasTranscribe.downloadFile, (m) => log(m));
        // aberto uma vez e reaproveitado na fila: cada um segura uns workers com o wasm (dezenas de MB)
        if (!segmenter) segmenter = await AppLegendasPersonMatte.openSegmenter(userDir);
        const part = path.join(work, "mascara.mkv"); // só vai para o guardado inteira
        const made = await AppLegendasPersonMatte.renderMask({
          ffmpegPath: FFMPEG, mediaPath: input, sourceSeconds: 0, duration: probe.duration, fps: fps, path: part, segmenter: segmenter, view: view, raw: true,
          onFrame: (k, n) => hooks.matting && k % 15 === 0 && hooks.matting(k / n),
          cancel: () => !!(hooks.cancelled && hooks.cancelled()),
        });
        fs.copyFileSync(part, maskFile);
        step("pessoa recortada", made.frames + " máscaras de " + made.maskWidth + "x" + made.maskHeight);
      }
    }
    const maskInput = maskFile ? 4 + (music ? 1 : 0) + (framePng ? 1 : 0) : 0;
    // zoom de 10% nos destaques com rampa suave de 0,3 s, vezes o punch-in de 12% trecho sim, trecho não (no
    // empilhado não: cortaria as duas pessoas); música em loop (-stream_loop no input) que abaixa com a fala
    const punch = stacked || opts.noPunch ? "1" : P.punchExpr(keep, fps, 0.12);
    const graph2 = P.finalGraph({ W, H, band, cut: opts.onePass ? cutF : null, tone, reframe: rf.crop, focus, zoom: P.zoomExpr(zooms, 0.1, 0.3) + "*" + punch, fx, music: jotaMusic || music, frameInput,
      maskInput, fps, src: { w: srcW, h: srcH }, edge: AppLegendasPersonMatte.EDGE });
    const graph2File = path.join(work, "final.txt");
    fs.writeFileSync(graph2File, graph2);
    // na passada única, o bruto só é lido até o fim do último trecho (P.readUntil): o resto era decodificado à toa
    const until = opts.onePass ? P.readUntil(keep, fps) : null;
    const finalArgs = ["-hide_banner", "-loglevel", "error", "-y"].concat(until ? ["-t", until] : [], ["-i", source,
      "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", W + "x" + band.h, "-framerate", String(fps), "-i", "pipe:0",
      "-i", path.join(SFX, "snap.wav"), "-i", path.join(SFX, "thump.wav")])
      .concat(jotaMusic ? ["-i", opts.music] : music ? ["-stream_loop", "-1", "-i", opts.music] : [], framePng ? ["-loop", "1", "-i", framePng] : [], maskFile ? ["-i", maskFile] : [], [
      "-/filter_complex", graph2File, "-map", "[v]", "-map", "[a]",
      ...encArgs, "-b:v", opts.preview ? "3000k" : "12000k", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out]);
    log("zoom em " + zooms.length + " destaque(s), " + fx.length + " som(ns)");
    // o renderFrames do painel cuida do pipe, da pressão e do erro; aqui só muda o "o que desenhar"
    await AppLegendasMotion.renderFrames({
      ffmpegPath: FFMPEG, canvas: canvas, count: count, fps: fps, path: out, args: finalArgs,
      onFrame: (i, n) => hooks.progress && i % 15 === 0 && hooks.progress(i / n),
      cancel: () => !!(hooks.cancelled && hooks.cancelled()),
      draw: function (i) {
        const t = i / fps;
        while (seg < segments.length && segments[seg].outSeconds <= t) seg += 1;
        const s = segments[seg];
        if (!s || t < s.inSeconds) {
          lastPx = null;
          return empty;
        }
        if (lastPx && t < holdUntil) {
          reused += 1;
          return lastPx;
        }
        drawn += 1;
        let a = performance.now();
        drawAt(s, t - s.inSeconds);
        let b = performance.now();
        const px = ctx.getImageData(0, band.y, W, band.h).data;
        tDraw += b - a;
        tRead += performance.now() - b;
        same = lastPx && P.samePixels(lastPx, px) ? same + 1 : 0;
        lastPx = px;
        if (same >= 4 && !opts.everyFrame) {
          const next = s.words.find((w) => w.inSeconds > t);
          holdUntil = next ? next.inSeconds : s.outSeconds;
          same = 0;
        } else holdUntil = -1;
        return px;
      },
    });
    const encSecs = (Date.now() - encStart) / 1000;
    step("legenda + vídeo final", count + " quadros (" + drawn + " desenhados, " + reused + " repetidos) a " + (count / encSecs).toFixed(0) + " q/s; desenho " +
      (tDraw / 1000).toFixed(1) + " s, leitura " + (tRead / 1000).toFixed(1) + " s, resto (pipe+ffmpeg) " + (encSecs - (tDraw + tRead) / 1000).toFixed(1) + " s");

    // as legendas também em .srt ao lado do MP4 (YouTube, cliente); BOM para o Bloco de Notas
    // Acelerar a fala (pedido do Jota, igual ao painel): o Reel pronto fica mais rápido com a voz no
    // mesmo tom; ele substitui o normal, e o .srt é dividido pela velocidade.
    const speed = Number(opts.speed) > 1 ? Number(opts.speed) : 1;
    let final = out;
    if (speed > 1) {
      const fast = await AppLegendasSpeed.speedUp({ ffmpegPath: FFMPEG, input: out, outDir: path.dirname(out), speed: speed });
      fs.unlinkSync(out);
      final = fast.path;
      log("acelerado " + AppLegendasSpeed.label(speed) + ": " + path.basename(final));
    }
    // Só pronto vai para a pasta: fechar o app no meio do vídeo final deixava lá um Reel cortado pela
    // metade com cara de pronto (o ffmpeg fecha o arquivo quando o pipe acaba). Outro disco: copia.
    const done = path.join(opts.out, path.basename(final));
    try {
      fs.renameSync(final, done);
    } catch (e) {
      fs.copyFileSync(final, done);
      fs.unlinkSync(final);
    }
    final = done;
    // Capa (a imagem do perfil antes do play): um quadro do bruto com o mesmo enquadramento e o
    // gancho (a primeira frase, até 8 palavras) grande no meio, na fonte do estilo.
    let cover = "";
    const covers = [];
    if (!opts.preview) try {
      // na duração pedida, a frase da capa que a IA escreveu (tarefa reel: hook, até 70 letras); senão a 1ª
      // frase. O hook do caminho "clips" diz por que o trecho prende: não é texto de capa.
      const hook = reel && reel.source === "reel" && reel.hook ? reel.hook.split(/\s+/).filter(Boolean) : [];
      if (!hook.length) for (const s of segments) {
        for (const w of s.words) {
          hook.push(w.text);
          if (/[.!?]$/.test(w.text) || hook.length >= 8) break;
        }
        if (hook.length >= 8 || /[.!?]$/.test(hook[hook.length - 1] || "")) break;
      }
      // recorte fixo (o de "quem fala" muda com o tempo; para a capa vale o da 1ª janela)
      const crop = rf.crop ? rf.crop.replace(/:'[^']*':0/, ":" + (spans && spans[0] ? spans[0].x : "(in_w-ow)/2") + ":0") : "";
      // 3 opções: 15%, 50% e 85% do Reel, levadas para o tempo do bruto pelos trechos que ficaram
      const srcAt = (outS) => {
        let acc = 0;
        for (const r of keep) {
          const len = (r.endMs - r.startMs) / 1000;
          if (outS <= acc + len) return r.startMs / 1000 + (outS - acc);
          acc += len;
        }
        return keep.length ? keep[keep.length - 1].endMs / 1000 : 1;
      };
      const draw = async (atSec, file, n) => {
      const still = path.join(work, "capa-quadro-" + n + ".jpg");
      const vf = [tone, crop].filter(Boolean).join(",");
      await run(["-hide_banner", "-v", "error", "-y", "-ss", atSec.toFixed(2), "-i", input].concat(vf ? ["-vf", vf] : [], ["-frames:v", "1", "-q:v", "2", still]));
      const img = new Image();
      img.src = "file:///" + still.replace(/\\/g, "/");
      await img.decode();
      const cc = document.createElement("canvas");
      cc.width = W;
      cc.height = H;
      const g = cc.getContext("2d");
      g.drawImage(img, 0, 0, W, H);
      // o texto fica longe do rosto: rosto em cima, texto embaixo (e vice-versa)
      const ty = focus.y < 0.5 ? 0.7 : 0.3;
      const shade = g.createLinearGradient(0, H * (ty - 0.25), 0, H * (ty + 0.25));
      shade.addColorStop(0, "rgba(0,0,0,0)");
      shade.addColorStop(0.5, "rgba(0,0,0,0.45)");
      shade.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = shade;
      g.fillRect(0, 0, W, H);
      const family = style.fontFamily || "Poppins";
      await document.fonts.load('800 80px "' + family + '"').catch(() => {});
      let size = Math.round(W * 0.11);
      g.font = "800 " + size + 'px "' + family + '"';
      // quebra em linhas que cabem em 86% da largura
      const lines = [];
      let line = "";
      hook.forEach((word) => {
        const tryLine = line ? line + " " + word : word;
        if (g.measureText(tryLine).width > W * 0.86 && line) {
          lines.push(line);
          line = word;
        } else line = tryLine;
      });
      if (line) lines.push(line);
      // palavra sozinha na última linha ("fim" na capa do 2.MOV): desce a última palavra da linha de cima
      if (lines.length > 1 && !/\s/.test(lines[lines.length - 1])) {
        const prev = lines[lines.length - 2].split(" ");
        const moved = prev.length > 1 ? prev[prev.length - 1] + " " + lines[lines.length - 1] : "";
        if (moved && g.measureText(moved).width <= W * 0.86) {
          lines[lines.length - 2] = prev.slice(0, -1).join(" ");
          lines[lines.length - 1] = moved;
        }
      }
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillStyle = "#ffffff";
      g.shadowColor = "rgba(0,0,0,0.75)";
      g.shadowBlur = size * 0.25;
      const lh = size * 1.12;
      lines.forEach((l, i) => g.fillText(i ? l : l.charAt(0).toUpperCase() + l.slice(1), W / 2, H * ty + (i - (lines.length - 1) / 2) * lh, W * 0.92));
      fs.writeFileSync(file, Buffer.from(cc.toDataURL("image/jpeg", 0.9).split(",")[1], "base64"));
      };
      const reelS = tm.totalMs / 1000;
      for (const [n, frac] of [[1, 0.15], [2, 0.5], [3, 0.85]]) {
        const file = final.replace(/\.mp4$/i, " capa " + n + ".jpg");
        await draw(srcAt(reelS * frac), file, n);
        covers.push(file);
      }
      // a 1ª opção é a capa até alguém escolher outra na tela
      cover = final.replace(/\.mp4$/i, " capa.jpg");
      fs.copyFileSync(covers[0], cover);
      log("capa: \"" + hook.join(" ") + "\"");
    } catch (e) {
      log("capa não saiu (" + (e && e.message ? e.message : e) + "); o Reel está pronto");
    }
    // Máscara de cada legenda parada (no fim dela), em metade do tamanho, empilhadas num PNG ao lado do MP4: o
    // juiz mede o contraste da letra contra o que está em volta dela no quadro (branco sobre camisa branca).
    let mask = null;
    if (segments.length && !opts.preview) try {
      const k = 2, mw = Math.round(W / k), mh = Math.round(band.h / k), n = Math.min(segments.length, 80);
      const sc = document.createElement("canvas");
      sc.width = mw;
      sc.height = mh * n;
      const sg = sc.getContext("2d");
      const at = [];
      for (let i = 0; i < n; i += 1) {
        const el = Math.max(0, segments[i].outSeconds - segments[i].inSeconds - 0.12); // 4 quadros antes do fim: já parada e ainda na tela
        drawAt(segments[i], el);
        sg.drawImage(canvas, 0, band.y, W, band.h, 0, i * mh, mw, mh);
        at.push(Number((segments[i].inSeconds + el).toFixed(3)));
      }
      const img = sg.getImageData(0, 0, sc.width, sc.height); // o alfa vira cinza (o ffmpeg do juiz lê em cinza)
      // só a letra (clara e opaca) vira branco: a sombra e o halo (pretos com alfa) ficam de fora da máscara
      for (let p = 0; p < img.data.length; p += 4) img.data[p] = img.data[p + 1] = img.data[p + 2] = Math.round(((img.data[p] + img.data[p + 1] + img.data[p + 2]) / 3) * img.data[p + 3] / 255), img.data[p + 3] = 255;
      sg.putImageData(img, 0, 0);
      const maskFile = final.replace(/\.mp4$/i, " legendas.png");
      fs.writeFileSync(maskFile, Buffer.from(sc.toDataURL("image/png").split(",")[1], "base64"));
      mask = { arquivo: path.basename(maskFile), y: band.y, h: band.h, escala: k, tempos: at };
    } catch (e) {
      log("máscara da legenda não saiu (" + (e && e.message ? e.message : e) + ")");
    }
    const srt = final.replace(/\.mp4$/i, ".srt");
    fs.writeFileSync(srt, "﻿" + C.formatSrt(segments.map((g) => ({ inSeconds: g.inSeconds / speed, outSeconds: g.outSeconds / speed, text: g.text }))), "utf8");
    // texto do post ao lado do MP4 (um por vídeo: os formatos e estilos do mesmo bruto usam o mesmo)
    const post = postJob ? await postJob : null;
    const postPath = post ? path.join(opts.out, base + " post.txt") : "";
    if (post) {
      fs.writeFileSync(postPath, IA.postFile(post, AppLegendasAI.chaptersText), "utf8");
      log("post: \"" + post.title + "\" + " + post.hashtags.length + " hashtags em " + path.basename(postPath));
    }
    const total = (Date.now() - t0) / 1000;
    log("PRONTO em " + total.toFixed(1) + " s: " + final);
    fs.writeFileSync(path.join(opts.out, base + " tempos.json"), JSON.stringify({ bruto: inputs.length > 1 ? inputs : opts.input, segundosDoBruto: probe.duration, segundosDoReel: Number((count / fps).toFixed(1)), total: Number(total.toFixed(1)), etapas: times, pc: os.cpus()[0].model,
      cortados: found.map((c) => c.kind + ": " + c.text), trechos: keep.map((r) => [r.startMs / 1000, r.endMs / 1000]), legendas: segments.map((s) => s.inSeconds.toFixed(2) + " " + s.text),
      // para o juiz (scripts/reel-juiz.js), no tempo do Reel antes de acelerar: legendas e palavras [início, fim, texto], sons e zooms (s)
      velocidade: speed, legendasTempo: segments.map((s) => [Number(s.inSeconds.toFixed(3)), Number(s.outSeconds.toFixed(3)), s.text]),
      palavras: mapped.map((w) => [w.startMs / 1000, w.endMs / 1000, w.text]), sons: fx.map((f) => Number(f.at.toFixed(3))),
      zooms: zooms.map((z) => [Number(z.inSeconds.toFixed(3)), Number(z.outSeconds.toFixed(3))]), legendaMascara: mask, musica: musicInfo }, null, 2));
    fs.rmSync(work, { recursive: true, force: true });
    return { out: final, srt: srt, cover: cover, covers: covers, post: postPath, total: total, times: times, words: heard, lines: segments.map((s) => s.text), landscape: srcW > srcH, faceX: manual !== null ? manual : faceX };
  } catch (e) {
    log("ERRO: " + (e && e.stack ? e.stack : e));
    // erro ou Cancelar: a pasta de trabalho (fala.wav, ~115 MB por hora de vídeo) não fica para trás.
    // O ffmpeg morto pelo Cancelar pode segurar um arquivo por um instante no Windows: aí fica.
    if (work) try { fs.rmSync(work, { recursive: true, force: true }); } catch (e2) { /* preso */ }
    throw e;
  }
};

// Sem tela: main.js --input passa as opções na URL e espera o "done".
if (new URLSearchParams(location.search).get("options")) {
  const { ipcRenderer } = require("electron");
  const opts = JSON.parse(new URLSearchParams(location.search).get("options"));
  window.runReel(opts, { log: (text) => ipcRenderer.send("log", text) })
    .then(() => ipcRenderer.send("done", 0), () => ipcRenderer.send("done", 1));
}
