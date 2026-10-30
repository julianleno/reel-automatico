/**
 * Transcrição local com whisper.cpp (via Node do CEP): baixa o modelo, extrai o áudio com o
 * ffmpeg e devolve as palavras com tempo.
 *
 * Global no painel: AppLegendasTranscribe. No Node (testes): module.exports.
 */
(function (root, factory) {
  // No painel CEP o Node também define `module`; lá o destino é o global do painel.
  if (typeof window === "undefined" && typeof module === "object" && module.exports) {
    module.exports = factory(require);
  } else {
    var nodeRequire = (root.cep_node && root.cep_node.require) || (typeof require === "function" ? require : null);
    root.AppLegendasTranscribe = factory(nodeRequire);
  }
})(typeof self !== "undefined" ? self : this, function (nodeRequire) {
  var MODEL_BASE_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";
  var MODELS = {
    base: { file: "ggml-base.bin", sizeMb: 142 },
    // Rápida: small comprimido; no Premiere deu o mesmo texto do small, ~20% mais rápido.
    // Busca gulosa (-bs 1) foi testada e descartada: errava ~2% das palavras.
    "small-q8": { file: "ggml-small-q8_0.bin", sizeMb: 264 },
    small: { file: "ggml-small.bin", sizeMb: 466 },
    medium: { file: "ggml-medium.bin", sizeMb: 1500 },
  };
  var MAX_REDIRECTS = 5;
  // Processos e downloads em andamento, para o painel poder cancelar a transcrição.
  var active = [];
  // A GPU falhou nesta sessão (ex.: memória de vídeo cheia com o Premiere aberto): não tenta de novo a cada clipe.
  var gpuFailed = false;
  // Este carregamento do script tem a vez de transcrever (o arquivo com o PID, em takeTurn).
  var holding = false;

  function track(handle) {
    active.push(handle);
    return function () {
      active = active.filter(function (h) { return h !== handle; });
    };
  }

  // Encerra tudo o que está em andamento; quem aguarda recebe um erro.
  function cancelAll() {
    var handles = active;
    active = [];
    handles.forEach(function (h) {
      try { h.kill ? h.kill() : h.destroy(new Error("cancelado")); } catch (e) { /* já terminou */ }
    });
    return handles.length;
  }

  function node(name) {
    return nodeRequire(name);
  }

  function runs(command, args) {
    return new Promise(function (resolve) {
      try {
        node("child_process").execFile(command, args, { windowsHide: true }, function (err) {
          resolve(!err);
        });
      } catch (e) {
        resolve(false);
      }
    });
  }

  // Devolve o primeiro candidato (caminho ou nome no PATH) que executa, ou null.
  async function findWhisper(candidates) {
    for (var i = 0; i < candidates.length; i += 1) {
      if (candidates[i] && (await runs(candidates[i], ["-h"]))) return candidates[i];
    }
    return null;
  }

  function modelPath(dir, name) {
    return node("path").join(dir, MODELS[name].file);
  }

  function hasModel(dir, name) {
    return node("fs").existsSync(modelPath(dir, name));
  }

  function download(url, dest, onProgress, redirects) {
    return new Promise(function (resolve, reject) {
      var untrack = function () {};
      var req = node("https")
        .get(url, function (res) {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            untrack();
            if (redirects >= MAX_REDIRECTS) {
              reject(new Error("Redirecionamentos demais ao baixar o modelo."));
              return;
            }
            var next = new (node("url").URL)(res.headers.location, url).toString();
            download(next, dest, onProgress, redirects + 1).then(resolve, reject);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            untrack();
            reject(new Error("Download falhou (HTTP " + res.statusCode + ")."));
            return;
          }
          var total = Number(res.headers["content-length"]) || 0;
          var received = 0;
          var out = node("fs").createWriteStream(dest);
          res.on("data", function (chunk) {
            received += chunk.length;
            if (onProgress && total) onProgress(received / total);
          });
          res.pipe(out);
          out.on("finish", function () {
            out.close(function () {
              untrack();
              resolve();
            });
          });
          out.on("error", reject);
          res.on("error", function (e) {
            out.destroy();
            reject(e);
          });
          res.on("aborted", function () {
            out.destroy();
            reject(new Error("cancelado"));
          });
        })
        .on("error", function (e) {
          untrack();
          reject(e);
        });
      untrack = track(req);
    });
  }

  // Baixa para um arquivo .part e só renomeia no fim, para um download interrompido não
  // deixar um modelo corrompido no lugar.
  async function downloadModel(dir, name, onProgress) {
    var fs = node("fs");
    fs.mkdirSync(dir, { recursive: true });
    var dest = modelPath(dir, name);
    var part = dest + ".part";
    try {
      await download(MODEL_BASE_URL + MODELS[name].file, part, onProgress, 0);
      fs.renameSync(part, dest);
    } catch (e) {
      fs.rmSync(part, { force: true });
      throw new Error("Não foi possível baixar o modelo: " + e.message);
    }
    return dest;
  }

  function spawnAndWait(command, args, onStderr) {
    return new Promise(function (resolve, reject) {
      var child;
      var stderr = "";
      try {
        child = node("child_process").spawn(command, args, { windowsHide: true });
      } catch (e) {
        reject(e);
        return;
      }
      var untrack = track(child);
      child.stdout.on("data", function () {});
      child.stderr.on("data", function (chunk) {
        var text = String(chunk);
        stderr = (stderr + text).slice(-600);
        if (onStderr) onStderr(text);
      });
      child.on("error", function (e) {
        untrack();
        reject(e);
      });
      child.on("close", function (code, signal) {
        untrack();
        if (code === 0) return resolve();
        var err = new Error("código " + code + ": " + stderr.replace(/\s+/g, " "));
        err.killed = !!signal;
        reject(err);
      });
    });
  }

  // Áudio de um trecho da mídia em WAV 16 kHz mono (formato que o whisper.cpp lê).
  async function extractWav(options) {
    var args = ["-v", "error", "-nostdin", "-y"];
    if (options.startSeconds > 0) args.push("-ss", String(options.startSeconds));
    if (options.durationSeconds > 0) args.push("-t", String(options.durationSeconds));
    args.push("-i", options.file, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", options.wavPath);
    try {
      await spawnAndWait(options.ffmpegPath, args);
    } catch (e) {
      throw new Error("ffmpeg falhou ao extrair o áudio (" + e.message + ")");
    }
  }

  /**
   * Saída do whisper.cpp com uma palavra por entrada (-ml 1 -sow) -> [{ text, startMs, endMs }].
   * Entradas sem espaço inicial (ou depois de "pré-") continuam a palavra anterior; marcações
   * como [MÚSICA] saem.
   */
  function wordsFromWhisperJson(data) {
    var words = [];
    var list = (data && data.transcription) || [];
    for (var i = 0; i < list.length; i += 1) {
      var raw = String(list[i].text || "");
      var text = raw.replace(/^\s+|\s+$/g, "");
      var offsets = list[i].offsets || {};
      var startMs = Number(offsets.from);
      var endMs = Number(offsets.to);
      if (!text || !isFinite(startMs) || !isFinite(endMs)) continue;
      if (/^[\[(].*[\])]$/.test(text)) continue;
      // marcação quebrada em várias entradas ("[Som", "de", "fio]" num vídeo só com ruído): sai inteira,
      // até a que fecha (no máximo 6, para um parêntese sem par não comer a fala)
      if (/^[\[(]/.test(text)) {
        var close = text.charAt(0) === "[" ? "]" : ")";
        var last = i;
        while (last < list.length - 1 && last - i < 6 && String(list[last].text || "").replace(/\s+$/, "").slice(-1) !== close) last += 1;
        if (String(list[last].text || "").replace(/\s+$/, "").slice(-1) === close) {
          i = last;
          continue;
        }
      }
      // "pré-" + "treino": a palavra hifenizada que o Whisper separou volta a ser uma só.
      if (words.length && (!/^\s/.test(raw) || /\S-$/.test(words[words.length - 1].text))) {
        words[words.length - 1].text += text;
        words[words.length - 1].endMs = Math.max(words[words.length - 1].endMs, endMs);
      } else {
        words.push({ text: text, startMs: startMs, endMs: Math.max(endMs, startMs) });
      }
    }
    // Alucinação em música: "bonitos!!!!!!…" de 56 s a 86 s (vídeo real) virava uma legenda de 30 s.
    // A pontuação repetida vira uma só, e palavra de mais de 3 s fica com 1,5 s a partir do começo
    // (menos a que fecha um grupo espremido no mesmo instante: o tempo dela é o do grupo, que o
    // spreadCollapsed espalha; "redes," de 160,36 a 165,64 s no cliente 2 2).
    // Aspas que o Whisper põe em volta da frase inteira ("\"Hoje ... importante.\"", fx-2 no Premiere)
    // iam para a legenda. Saem só as que vão do começo ao fim de uma frase de 3+ palavras; aspas de
    // uma palavra ou expressão ("passagem") ficam.
    for (var q = 0; q < words.length; q += 1) {
      if (!/^["“]/.test(words[q].text) || (q > 0 && !/[.!?…]["”]?$/.test(words[q - 1].text))) continue;
      var end = q + 1;
      while (end < words.length && !/["”]/.test(words[end].text)) end += 1;
      if (end >= words.length || end - q < 2 || !/(["”][.!?…]|[.!?…]["”])$/.test(words[end].text)) continue;
      words[q].text = words[q].text.replace(/^["“]/, "");
      words[end].text = words[end].text.replace(/["”]([.!?…])$|([.!?…])["”]$/, "$1$2");
      q = end;
    }
    words = words.filter(function (w) { return w.text; }); // aspa solta que virou nada (invariantes)
    words.forEach(function (w, k) {
      w.text = w.text.replace(/([!?.,;:…])\1{2,}/g, "$1");
      var squeezed = k > 0 && words[k - 1].startMs >= w.startMs;
      if (w.endMs - w.startMs > LONG_WORD_MS && !squeezed) w.endMs = w.startMs + LONG_WORD_KEEP_MS;
    });
    return words;
  }
  var LONG_WORD_MS = 3000;
  var LONG_WORD_KEEP_MS = 1500;

  /**
   * options: { whisperPath, modelPath, wavPath, language, prompt?, onProgress(0..1), onWait() (outra transcrição tem a vez),
   *   relisten? }
   * relisten (opcional): { speech: [{ startMs, endMs }], silences: [{ startMs, endMs }] } no tempo do WAV: a fala pelo
   *   detector de pausas e os silêncios finos (SPEECH_SILENCE). Fala de 2 s ou mais sem nenhuma palavra é ouvida de
   *   novo só ali; as palavras dessa 2ª escuta vêm com quiet: true.
   * retorna: [{ text, startMs, endMs, quiet? }] relativo ao início do WAV
   */
  async function transcribeWav(options) {
    var release = await takeTurn(options.onWait);
    try {
      var words = await transcribeOnce(options);
      return options.relisten ? await relisten(options, words) : words;
    } finally {
      release();
    }
  }

  // Frase baixa que o Whisper não ouviu (bruto do Jota, 20/10: a última pergunta, 21 dB mais baixa que a fala de
  // antes; nenhum parâmetro do whisper a trazia). Cada trecho é ouvido de novo sozinho, dentro da mesma vez do PC.
  var RELISTEN_MIN_MS = 2000; // menos que isso, em ruído, a escuta com prompt inventa frase
  async function relisten(options, words) {
    var fs = node("fs");
    var buf = fs.readFileSync(options.wavPath), wav = wavInfo(buf);
    var part = options.wavPath.replace(/\.wav$/i, "") + "-trecho.wav";
    var groups = unheardSpeech(options.relisten.speech || [], words, RELISTEN_MIN_MS, (wav.size / wav.byteRate) * 1000);
    var once = function (prompt) {
      return transcribeOnce(Object.assign({}, options, { wavPath: part, prompt: prompt, onProgress: null }));
    };
    try {
      for (var i = 0; i < groups.length; i += 1) {
        var g = groups[i];
        fs.writeFileSync(part, sliceWav(buf, wav, g.fromMs, g.toMs));
        // sem prompt primeiro: em barulho não sai palavra nenhuma, e com prompt o Whisper ecoava o texto de antes
        // ("E aí, o que aconteceu?" no 1.MOV, fx-3). Com prompt depois: sem ele a frase sai trocada.
        if (!(await once("")).length) continue;
        var more = alignToSpeech((await once(g.prompt)).map(function (w) {
          return { text: w.text, startMs: w.startMs + g.fromMs, endMs: w.endMs + g.fromMs, quiet: true };
        }), options.relisten.silences || []);
        // ensaio baixinho: a frase volta logo depois em voz normal ("era muito a pena contar como isso aconteceu"
        // antes de "vale muito a pena contar essa história", 1.MOV). Não entra: com quiet o Reel ficava com a
        // frase duas vezes; sem ele, o Reel na duração a contava como fala e acabava nela, e o Autocorte a tirava
        // como fala baixa (o Reel terminava em "corrida eleitoral,")
        // A frase que a 1ª escuta pôs fora do lugar (dropEcho) é fala daqui, não ensaio: o tema dela volta depois
        // ("escola", "inclusiva" nas 2 tomadas juntadas) e o rehearsed a tirava, ficando só a cópia fora do lugar
        var rest = dropEcho(words, more);
        if (rest === words && rehearsed(more, words)) continue;
        words = rest.concat(more).sort(function (a, b) { return a.startMs - b.startMs; });
      }
    } finally {
      fs.rmSync(part, { force: true });
    }
    return words;
  }

  // A frase da 2ª escuta tem 5+ palavras de 4+ letras e 60% delas voltam na frase seguinte em voz normal (até o
  // ponto)? Ensaio é seguido da versão boa, não do tema: contra os 60 s seguintes (40%, 3+ palavras), 7 das 12 frases
  // normais da cliente 1 saíam como ensaio ("escola", "inclusiva" voltam o vídeo todo); e frase de 3 ou 4 palavras
  // divide o assunto com a seguinte ("O que tem a ver Nossa Senhora Aparecida com política?" antes de "Nossa
  // Senhora Aparecida chegou ao Brasil..."). 1.MOV: 4 de 6, 67%.
  // Fala baixa que já se refaz (a 1ª frase volta na 2ª): a versão boa pode vir 2 frases depois, até 20 s (cliente 1:
  // 2 tomadas baixas de "Não pergunte apenas..." e ela refaz antes a "Primeira pergunta..."; o editor cortou 35 das
  // 38 palavras). Para toda frase, 2 frases tiravam também a 1ª tomada da 2ª pergunta, que a regravada vem 2 depois.
  // ponytail: sem pontuação por muito tempo, a "frase seguinte" fica longa e divide palavras por acaso; e só a 1ª
  // frase da fala baixa conta como tomada (3 tomadas com a refeita só no fim não pegam)
  var REHEARSAL_MIN = 5;
  var REHEARSAL_SHARE = 0.6;
  var REHEARSAL_WITHIN_MS = 20000;
  var SENTENCE_END = /[.!?…]["”]?$/;
  // min: outro mínimo de palavras de 4+ letras (o Autocorte do painel, em js/tools/silence.js); com ele, olha até 3
  // frases seguintes (nos 20 s): o aparte baixo "Domingos Garcia, eu acho." do cliente 2 só volta 3 frases depois
  function rehearsed(said, words, min) {
    var cut = said.findIndex(function (w) { return SENTENCE_END.test(w.text); }) + 1;
    var retake = cut > 0 && cut < said.length && comesBack(said.slice(0, cut), said.slice(cut), 1);
    return comesBack(said, words.filter(function (w) { return !w.quiet; }), min ? 3 : retake ? 2 : 1, min);
  }
  // 60% das palavras de 4+ letras de said voltam numa das n frases seguintes de words?
  function comesBack(said, words, n, min) {
    var key = function (w) { return String(w.text).toLowerCase().replace(/[.,!?;:…"“”'()]/g, ""); };
    var content = said.map(key).filter(function (x) { return x.length >= 4; });
    var end = said.length ? said[said.length - 1].endMs : 0;
    var next = [], cur = null;
    words.some(function (w) {
      if (w.startMs < end) return false;
      if (!cur) {
        if (next.length === n || w.startMs > end + REHEARSAL_WITHIN_MS) return true;
        next.push(cur = {});
      }
      cur[key(w)] = true;
      if (SENTENCE_END.test(w.text)) cur = null;
      return false;
    });
    return content.length >= (min || REHEARSAL_MIN) && next.some(function (s) {
      return content.filter(function (x) { return s[x]; }).length / content.length >= REHEARSAL_SHARE;
    });
  }

  // Fala de pelo menos minMs seguidos sem nenhuma palavra -> [{ fromMs, toMs, prompt }]: ouvir de novo só ali, com o
  // texto de antes como prompt.
  function unheardSpeech(speech, words, minMs, totalMs) {
    // o pedaço sem palavra pode estar dentro de um trecho de fala que tem palavras (cliente 1 no Premiere: 1 trecho
    // de 60,1 a 76,9 s com palavras só até 68,6; a 1ª tentativa da pergunta 2 ficava sem legenda): os buracos
    var holes = [];
    speech.forEach(function (r) {
      var at = r.startMs;
      words.filter(function (w) { return w.startMs < r.endMs && w.endMs > r.startMs; }).forEach(function (w) {
        if (w.startMs - at >= minMs) holes.push({ startMs: at, endMs: w.startMs });
        at = Math.max(at, w.endMs);
      });
      if (r.endMs - at >= minMs) holes.push({ startMs: at, endMs: r.endMs });
    });
    var out = [];
    holes.forEach(function (r) {
      var before = words.filter(function (w) { return w.endMs <= r.startMs; });
      var after = words.filter(function (w) { return w.startMs >= r.endMs; })[0];
      var said = before.map(function (w) { return w.text; }).join(" ");
      out.push({
        // 3 s antes: a frase baixa começa antes do que o detector chama de fala (em 85,5 s, não em 88,7)
        fromMs: Math.max(before.length ? before[before.length - 1].endMs : 0, r.startMs - 3000),
        toMs: Math.min(after ? after.startMs : totalMs, r.endMs + 1000),
        prompt: said.length > 220 ? said.slice(-220).replace(/^\S*\s/, "") : said, // sem meia palavra no começo
      });
    });
    return out;
  }

  // A 2ª escuta ouviu de novo uma frase que a 1ª tinha posto antes, no lugar errado: o Whisper espalhou "Mãe, a escola
  // te disse que é inclusiva," por 11 s de silêncio do vídeo anterior (2 tomadas juntadas no app, 21/10), e a fala
  // dela, sem palavra, foi ouvida de novo: a legenda saía duas vezes, a 1ª em cima de quem não falava. A mesma
  // sequência (4 palavras ou mais) até 30 s antes da 2ª escuta sai: ou estava fora do lugar, ou é uma tentativa
  // anterior da frase, que o retake tiraria de qualquer jeito.
  var ECHO_MIN_WORDS = 4;
  var ECHO_WINDOW_MS = 30000;
  function dropEcho(words, more) {
    if (more.length < ECHO_MIN_WORDS) return words;
    var key = function (list) {
      return list.map(function (w) { return String(w.text).toLowerCase().replace(/[^\p{L}\d]/gu, ""); }).join(" ");
    };
    var target = key(more);
    var n = more.length;
    for (var i = words.length - n; i >= 0; i -= 1) {
      if (words[i + n - 1].startMs >= more[0].startMs) continue;
      if (more[0].startMs - words[i].startMs > ECHO_WINDOW_MS) break;
      if (key(words.slice(i, i + n)) === target) return words.slice(0, i).concat(words.slice(i + n));
    }
    return words;
  }

  // O Whisper põe a 1ª palavra no começo do recorte, mesmo em silêncio (fx-3, 1.MOV: 2,9 s adiantada, e o silêncio
  // entrava no Reel). 1ª palavra num silêncio: a escuta inteira anda até onde a fala volta.
  function alignToSpeech(words, silences) {
    var s = words.length && silences.filter(function (x) { return x.startMs <= words[0].startMs && words[0].startMs < x.endMs; })[0];
    if (!s) return words;
    var d = s.endMs - words[0].startMs;
    return words.map(function (w) { return Object.assign({}, w, { startMs: w.startMs + d, endMs: w.endMs + d }); });
  }

  // O WAV PCM do extractWav: onde estão os dados e quantos bytes por segundo
  function wavInfo(buf) {
    var at = 12, byteRate = 32000, align = 2;
    while (at + 8 <= buf.length) {
      var id = buf.toString("ascii", at, at + 4), size = buf.readUInt32LE(at + 4);
      if (id === "fmt ") {
        byteRate = buf.readUInt32LE(at + 16);
        align = buf.readUInt16LE(at + 20);
      }
      if (id === "data") return { at: at + 8, size: Math.min(size, buf.length - at - 8), byteRate: byteRate, align: align };
      at += 8 + size + (size % 2);
    }
    throw new Error("o áudio extraído não tem dados");
  }

  // O pedaço de fromMs a toMs num WAV novo (sem chamar o ffmpeg de novo)
  function sliceWav(buf, wav, fromMs, toMs) {
    var pos = function (ms) { return Math.min(wav.size, Math.max(0, Math.floor(((ms / 1000) * wav.byteRate) / wav.align) * wav.align)); };
    var a = pos(fromMs), b = pos(toMs);
    var Buf = node("buffer").Buffer, head = Buf.from(buf.subarray(0, wav.at));
    head.writeUInt32LE(wav.at - 8 + (b - a), 4);
    head.writeUInt32LE(b - a, wav.at - 4);
    return Buf.concat([head, buf.subarray(wav.at + a, wav.at + b)]);
  }

  // Duas transcrições ao mesmo tempo na GPU (painel e protótipo, dois painéis) saem erradas sem erro
  // nenhum: numa RX 580 de 2 GB uma perdeu metade da fala e a outra virou "!!!!". Uma por vez no PC:
  // um arquivo na pasta temporária com o PID de quem está transcrevendo. Quem tem a vez toca o arquivo a
  // cada 30 s; parado há mais de 2 min é sobra (travou, ou o Windows deu o PID a outro processo).
  var TURN_BEAT_MS = 30000, TURN_STALE_MS = 120000;
  async function takeTurn(onWait) {
    var fs = node("fs");
    var file = node("path").join(node("os").tmpdir(), "app-legendas-whisper.lock");
    var cancelled = false;
    var untrack = track({ kill: function () { cancelled = true; } });
    try {
      for (;;) {
        try {
          fs.writeFileSync(file, String(node("process").pid), { flag: "wx" });
          holding = true;
          var beat = setInterval(function () {
            try { fs.utimesSync(file, new Date(), new Date()); } catch (e2) { /* já saiu */ }
          }, TURN_BEAT_MS);
          if (beat && beat.unref) beat.unref(); // no Node, não segura o processo aberto
          return function () { clearInterval(beat); holding = false; fs.rmSync(file, { force: true }); };
        } catch (e) {
          if (e.code !== "EEXIST") return function () {}; // pasta sem escrita: segue sem a vez
        }
        if (!holderAlive(fs, file)) {
          fs.rmSync(file, { force: true });
          continue;
        }
        if (cancelled) throw new Error("cancelado");
        if (onWait) onWait();
        onWait = null;
        await new Promise(function (resolve) { setTimeout(resolve, 250); });
      }
    } finally {
      untrack();
    }
  }

  function holderAlive(fs, file) {
    try {
      var pid = Number(fs.readFileSync(file, "utf8"));
      // vazio: o outro acabou de criar e ainda não escreveu (ou morreu nesse instante)
      var age = Date.now() - fs.statSync(file).mtimeMs;
      if (!(pid > 0)) return age < 5000;
      if (age > TURN_STALE_MS) return false;
      // o próprio PID sem a vez: sobra de um painel recarregado no meio da transcrição (o processo do CEP continua vivo)
      if (pid === node("process").pid) return holding;
      node("process").kill(pid, 0);
      return true;
    } catch (e) {
      return e.code === "EPERM";
    }
  }

  async function transcribeOnce(options) {
    var fs = node("fs");
    var outBase = options.wavPath.replace(/\.wav$/i, "");
    var args = [
      "-m", options.modelPath,
      "-f", options.wavPath,
      "-l", options.language || "auto",
      "-ml", "1",
      "-sow",
      "-t", String(Math.max(1, node("os").cpus().length)), // o padrão do whisper-cli é só 4 núcleos
      "-oj",
      "-of", outBase,
      "-pp",
    ];
    // O texto que o whisper carrega de uma janela de 30 s para a próxima o fazia pular frases inteiras
    // (bruto de 97 s: 9 s de fala sem legenda) e esticar palavras sobre o silêncio. Sem prompt, nada de
    // contexto; com prompt, só o tamanho dele (~1 token a cada 2 letras). Sem --carry-initial-prompt:
    // repetido em toda janela, o prompt virava texto no murmúrio ("Sim, é isso mesmo." no 1.MOV; "Mas." no
    // fim da tomada boa da cliente 1, que a IA do Boost então cortou como interrompida: Premiere real, fx-3).
    // O que o contexto curto ainda pular, a 2ª escuta (relisten) recupera.
    var prompt = options.prompt || "";
    args.push("-mc", String(Math.ceil(prompt.length / 2)));
    if (prompt) args.push("--prompt", asAnsi(prompt));
    var run = function (extra) {
      return spawnAndWait(options.whisperPath, args.concat(extra), function (text) {
        var m = /progress\s*=\s*(\d+)%/.exec(text);
        if (m && options.onProgress) options.onProgress(Number(m[1]) / 100);
      });
    };
    var jsonPath = outBase + ".json";
    var read = function () {
      try {
        return JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      } finally {
        fs.rmSync(jsonPath, { force: true });
      }
    };
    var onCpu = async function () {
      gpuFailed = true;
      try {
        await run(["-ng"]);
      } catch (e2) {
        throw new Error("whisper falhou (" + e2.message + ")");
      }
      return read();
    };
    var data;
    try {
      await run(gpuFailed ? ["-ng"] : []);
    } catch (e) {
      if (e.killed || gpuFailed) throw new Error("whisper falhou (" + e.message + ")");
      // O build usa a GPU (Vulkan) quando há uma; driver velho ou pouca memória de vídeo -> repete só na CPU.
      data = await onCpu();
    }
    if (!data) data = read();
    // GPU sem memória (RX 580 de 2 GB com outra transcrição ao mesmo tempo) termina com código 0 e devolve
    // só "!!!!…" (300 s para 30 s de áudio): é falha da GPU, não fala.
    if (!gpuFailed && garbled(data)) data = await onCpu();
    return wordsFromWhisperJson(data);
  }

  // O whisper-cli.exe lê os argumentos em cp1252 e o tokenizador espera UTF-8: "é" chegava como um byte
  // inválido e, repetido em toda janela, virava "ˇ" na legenda (fx-3, 20/10). Manda os bytes UTF-8 do
  // texto escritos como caracteres cp1252, que o Windows converte de volta nos mesmos bytes.
  // ponytail: supõe a página de código 1252 (Windows pt-BR/en); com "UTF-8 mundial" (65001) quebra.
  // O certo é o manifest activeCodePage UTF-8 no build do whisper (whisper-vulkan.yml).
  var CP1252_HIGH = [0x20AC, 0x81, 0x201A, 0x192, 0x201E, 0x2026, 0x2020, 0x2021, 0x2C6, 0x2030, 0x160, 0x2039, 0x152, 0x8D, 0x17D, 0x8F,
    0x90, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x2DC, 0x2122, 0x161, 0x203A, 0x153, 0x9D, 0x17E, 0x178];
  function asAnsi(text) {
    if (node("process").platform !== "win32") return text;
    var bytes = node("buffer").Buffer.from(text, "utf8");
    var out = "";
    for (var i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i] >= 0x80 && bytes[i] < 0xa0 ? CP1252_HIGH[bytes[i] - 0x80] : bytes[i]);
    return out;
  }

  function garbled(data) {
    var list = (data && data.transcription) || [];
    for (var i = 0; i < list.length; i += 1) if (/^\s*([!?.,])\1{7,}\s*$/.test(String(list[i].text || ""))) return true;
    return false;
  }

  return {
    MODELS: MODELS,
    findWhisper: findWhisper,
    modelPath: modelPath,
    hasModel: hasModel,
    downloadModel: downloadModel,
    downloadFile: download,
    track: track,
    cancelAll: cancelAll,
    extractWav: extractWav,
    transcribeWav: transcribeWav,
    unheardSpeech: unheardSpeech,
    alignToSpeech: alignToSpeech,
    dropEcho: dropEcho,
    rehearsed: rehearsed,
    wordsFromWhisperJson: wordsFromWhisperJson,
  };
});
