/**
 * Parser de transcrições em JSON (saída do Whisper e similares), independente de Adobe.
 *
 * Formatos aceitos:
 *   { segments: [{ start, end, text, words?: [{ word, start, end }] }] }   openai-whisper / faster-whisper / API
 *   { segments: [...], words: [{ word, start, end }] }                     API com timestamps por palavra
 *   { words: [{ word, start, end }] }                                      só palavras
 *   { transcription: [{ offsets: { from, to }, text }] }                   whisper.cpp (ms)
 *   [{ start, end, text }]                                                  lista simples
 * Tempos em segundos, exceto `offsets` (ms) e chaves `startMs`/`endMs`.
 *
 * Saída: { items: CaptionItem[], errors: {block, message}[] }
 * CaptionItem = { index, startMs, endMs, text, words?: [{ text, startMs, endMs }] }
 */
(function (root, factory) {
  // No painel CEP o Node também define `module`; lá o destino é o global do painel.
  if (typeof window === "undefined" && typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.AppLegendasCore = root.AppLegendasCore || {};
    root.AppLegendasCore.parseTranscript = factory().parseTranscript;
    root.AppLegendasCore.itemsFromWords = factory().itemsFromWords;
    root.AppLegendasCore.itemsFromText = factory().itemsFromText;
    root.AppLegendasCore.followCuts = factory().followCuts;
  }
})(typeof self !== "undefined" ? self : this, function () {
  // Só palavras, sem frases: quebra em pontuação final, pausa longa ou frase comprida demais.
  var SENTENCE_END = /[.!?…]$/;
  var MAX_PAUSE_MS = 700;
  var MAX_SENTENCE_WORDS = 14;
  // Mesma ideia das palavras fracas do segmentador: não terminar um trecho em "de", "no", "a"…
  var WEAK_END = /^(a|o|as|os|um|uma|de|da|do|das|dos|em|na|no|nas|nos|e|que|pra|para|por|com|se|ao)$/i;

  function isArray(v) {
    return Object.prototype.toString.call(v) === "[object Array]";
  }

  // só texto ou número: um objeto vindo do arquivo quebraria o String() (invariantes)
  function trim(v) {
    return (typeof v === "string" || typeof v === "number" ? String(v) : "").replace(/^\s+|\s+$/g, "");
  }

  // Lê início/fim em ms de um objeto com start/end (s), startMs/endMs ou offsets (ms).
  // Arquivo de fora: só número (ou texto numérico) vira tempo; um objeto quebraria o Number().
  function num(v) {
    return typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  }

  function readTimes(raw) {
    var start;
    var end;
    if (raw.offsets && raw.offsets.from !== undefined) {
      start = num(raw.offsets.from);
      end = num(raw.offsets.to);
    } else if (raw.startMs !== undefined) {
      start = num(raw.startMs);
      end = num(raw.endMs);
    } else {
      start = num(raw.start) * 1000;
      end = num(raw.end) * 1000;
    }
    if (!isFinite(start) || !isFinite(end) || start < 0) return null; // tempo negativo não existe no vídeo
    return { startMs: Math.round(start), endMs: Math.round(end) };
  }

  function readWords(list) {
    var out = [];
    if (!isArray(list)) return out;
    for (var i = 0; i < list.length; i += 1) {
      var raw = list[i];
      if (!raw) continue;
      var text = trim(raw.word !== undefined ? raw.word : raw.text);
      var t = readTimes(raw);
      if (!text || !t || t.endMs < t.startMs) continue;
      out.push({ text: text, startMs: t.startMs, endMs: t.endMs });
    }
    return out;
  }

  function joinWords(words) {
    var parts = [];
    for (var i = 0; i < words.length; i += 1) parts.push(words[i].text);
    return parts.join(" ");
  }

  function wordsInRange(words, startMs, endMs) {
    var out = [];
    for (var i = 0; i < words.length; i += 1) {
      var mid = (words[i].startMs + words[i].endMs) / 2;
      if (mid >= startMs && mid <= endMs) out.push(words[i]);
    }
    return out;
  }

  function wordsToSegments(words) {
    var segments = [];
    var current = [];
    for (var i = 0; i < words.length; i += 1) {
      var w = words[i];
      if (current.length) {
        var prev = current[current.length - 1];
        // Frase longa demais é dividida, mas não depois de artigo/preposição nem no meio de nome.
        var midName = /^[A-ZÀ-Ý]/.test(prev.text) && /^[A-ZÀ-Ý]/.test(w.text);
        var breakHere =
          SENTENCE_END.test(prev.text) ||
          w.startMs - prev.endMs > MAX_PAUSE_MS ||
          (current.length >= MAX_SENTENCE_WORDS && !WEAK_END.test(prev.text) && !midName && !/\S-$/.test(prev.text));
        if (breakHere) {
          segments.push(current);
          current = [];
        }
      }
      current.push(w);
    }
    if (current.length) segments.push(current);
    return segments;
  }

  // words: [{ text, startMs, endMs }] em ordem -> uma legenda por frase.
  function itemsFromWords(words) {
    var items = [];
    var groups = wordsToSegments(words);
    for (var i = 0; i < groups.length; i += 1) {
      var g = groups[i];
      var startMs = g[0].startMs;
      var endMs = g[g.length - 1].endMs;
      // frase de palavra com 0 ms (JSON de outro programa) sumia da legenda: fica até 300 ms, sem chegar na próxima
      if (endMs <= startMs) endMs = Math.min(startMs + 300, i + 1 < groups.length ? groups[i + 1][0].startMs : Infinity);
      if (endMs <= startMs) continue;
      items.push({ index: items.length + 1, startMs: startMs, endMs: endMs, text: joinWords(g), words: g });
    }
    return items;
  }

  // Texto digitado (uma linha = um texto), sem áudio: os textos entram em sequência a partir de
  // startMs, cada um com durationMs. As palavras entram no ritmo de fala (até ~3 por segundo,
  // nos primeiros 70% do texto) para os estilos que revelam ou destacam palavra por palavra.
  function itemsFromText(text, startMs, durationMs) {
    var items = [];
    var lines = String(text || "").split(/\r?\n/);
    var at = Math.max(0, Math.round(Number(startMs) || 0));
    var dur = Math.max(200, Math.round(Number(durationMs) || 0));
    for (var i = 0; i < lines.length; i += 1) {
      var parts = trim(lines[i]).split(/\s+/).filter(Boolean);
      if (!parts.length) continue;
      var step = Math.min(350, (dur * 0.7) / parts.length);
      var words = parts.map(function (w, k) {
        return { text: w, startMs: at + Math.round(k * step), endMs: k + 1 < parts.length ? at + Math.round((k + 1) * step) : at + dur };
      });
      items.push({ index: items.length + 1, startMs: at, endMs: at + dur, text: parts.join(" "), words: words });
      at += dur;
    }
    return items;
  }

  var MIN_SPOKEN_MS = 100; // ponta de palavra que sobra inteira do corte: dá para ter sido falada

  // Leva as frases para a sequência cortada: removed = trechos tirados ({startMs, endMs},
  // crescentes, sem sobreposição). A palavra que perdeu metade ou mais sai, a não ser que o corte
  // só tenha pegado uma ponta e sobrado 100 ms seguidos do começo ou do fim; o resto volta no tempo.
  function followCuts(items, removed) {
    function at(t) {
      var shift = 0;
      for (var r = 0; r < removed.length && removed[r].startMs < t; r += 1) shift += Math.min(t, removed[r].endMs) - removed[r].startMs;
      return Math.round(t - shift);
    }
    function inCut(t) {
      for (var r = 0; r < removed.length; r += 1) if (removed[r].startMs <= t && t < removed[r].endMs) return true;
      return false;
    }
    // O Whisper estica a última palavra da frase pela pausa (e às vezes puxa a primeira para
    // dentro dela): corte que só pega essa ponta deixa a palavra, com o pedaço falado.
    function spokenEdge(w) {
      var head = w.endMs, tail = w.startMs;
      for (var r = 0; r < removed.length; r += 1) {
        if (removed[r].startMs > w.startMs && removed[r].startMs < head) head = removed[r].startMs;
        if (removed[r].endMs < w.endMs && removed[r].endMs > tail) tail = removed[r].endMs;
      }
      return Math.max(inCut(w.startMs) ? 0 : head - w.startMs, inCut(w.endMs - 1) ? 0 : w.endMs - tail);
    }
    function silentCut(t) {
      for (var r = 0; r < removed.length; r += 1) if (removed[r].silence && removed[r].startMs <= t && t < removed[r].endMs) return removed[r];
      return null;
    }
    // Divide [a, b] da sequência cortada entre as palavras do grupo pelo tamanho de cada uma (os
    // tempos do Whisper ali são o atraso, não o ritmo) e marca estimated, como o spreadCollapsed.
    function squeeze(group, a, b) {
      var total = 0;
      group.forEach(function (e) { total += String(e.w.text).length + 1; });
      var t = a;
      group.forEach(function (e) {
        e.ws = Math.round(t);
        t += ((b - a) * (String(e.w.text).length + 1)) / total;
        e.we = Math.round(t);
        e.kept = e.we > e.ws;
        e.estimated = true;
      });
    }
    var lastStart = -Infinity; // começo da última fala
    items.forEach(function (it) {
      lastStart = Math.max(lastStart, it.startMs);
      (it.words || []).forEach(function (w) { lastStart = Math.max(lastStart, w.startMs); });
    });
    var out = [];
    for (var i = 0; i < items.length; i += 1) {
      var item = items[i];
      var startMs = at(item.startMs);
      var endMs = at(item.endMs);
      var copy = { index: out.length + 1, startMs: startMs, endMs: endMs, text: item.text };
      if (item.words && item.words.length) {
        var entries = item.words.map(function (w) {
          var e = { w: w, ws: at(w.startMs), we: at(w.endMs) };
          e.kept = e.we > e.ws && ((e.we - e.ws) * 2 >= w.endMs - w.startMs || spokenEdge(w) >= MIN_SPOKEN_MS);
          // Palavra que começa num corte de silêncio (o áudio mediu silêncio ali) foi falada antes
          // ou depois: o Whisper carimba o fim da frase até 1 s atrasado (fx-2, Premiere real).
          e.cut = silentCut(w.startMs) || (!e.kept && silentCut((w.startMs + w.endMs) / 2));
          // ...a não ser que siga 100 ms depois do corte e haja fala depois: aí o Whisper adiantou o
          // começo da frase seguinte, e ela fica do lado de lá (o "vídeo." que passa do fim da mídia não)
          if (e.cut && e.kept && w.endMs - e.cut.endMs >= MIN_SPOKEN_MS && lastStart >= e.cut.endMs) e.cut = null;
          if (e.cut) e.kept = false;
          return e;
        });
        var moved = false;
        for (var k = 0; k < entries.length; k += 1) {
          if (!entries[k].cut) continue;
          var c = entries[k].cut, j = k;
          while (j + 1 < entries.length && entries[j + 1].cut === c) j += 1;
          var before = k > 0 && entries[k - 1].kept && !entries[k - 1].cut ? entries[k - 1] : null;
          var after = j + 1 < entries.length && entries[j + 1].kept ? entries[j + 1] : null;
          // fim da frase: espreme até o fim da peça anterior; começo: a partir do início da seguinte
          var prevItem = out.length ? out[out.length - 1] : null;
          var tail = prevItem && prevItem.words && prevItem.words.length ? prevItem.words[prevItem.words.length - 1] : null;
          if (before) squeeze(entries.slice(k - 1, j + 1), before.ws, at(c.startMs));
          else if (after) squeeze(entries.slice(k, j + 2), at(c.endMs), after.we);
          else if (k === 0 && tail && tail.endMs <= at(c.startMs)) {
            // a frase inteira caiu no silêncio (a pausa do Whisper a separou): é o fim da anterior
            var anchor = { w: { text: tail.text } };
            squeeze([anchor].concat(entries.slice(k, j + 1)), tail.startMs, at(c.startMs));
            tail.endMs = anchor.we;
            tail.estimated = true;
            prevItem.endMs = tail.endMs;
          }
          moved = true;
          k = j;
        }
        copy.words = entries.filter(function (e) { return e.kept; }).map(function (e) {
          var c = { text: e.w.text, startMs: e.ws, endMs: e.we };
          if (e.w.estimated || e.estimated) c.estimated = true;
          if (e.w.quiet) c.quiet = true; // a frase baixa continua protegida num próximo Autocorte
          return c;
        });
        if (!copy.words.length) continue;
        if (moved || copy.words.length < item.words.length) {
          copy.text = joinWords(copy.words);
          copy.startMs = copy.words[0].startMs;
          copy.endMs = copy.words[copy.words.length - 1].endMs;
        }
      } else if (endMs - startMs < Math.min(300, (item.endMs - item.startMs) / 2) || endMs <= startMs) {
        // sem tempo por palavra (SRT): sobra de legenda quase toda cortada não fica (como as palavras)
        continue;
      }
      out.push(copy);
    }
    return out;
  }

  function parseTranscript(content) {
    var items = [];
    var errors = [];
    var data;
    try {
      var source = String(content || "");
      if (source.charCodeAt(0) === 0xfeff) source = source.slice(1); // BOM
      data = JSON.parse(source);
    } catch (e) {
      return { items: items, errors: [{ block: 0, message: "JSON inválido: " + e.message }] };
    }

    var rawSegments = null;
    var topWords = [];
    if (isArray(data)) {
      rawSegments = data;
    } else if (data && isArray(data.segments)) {
      rawSegments = data.segments;
      topWords = readWords(data.words);
    } else if (data && isArray(data.transcription)) {
      rawSegments = data.transcription;
    } else if (data && isArray(data.words)) {
      topWords = readWords(data.words);
    } else {
      return {
        items: items,
        errors: [{ block: 0, message: "Formato de transcrição não reconhecido (esperado: segments, words ou transcription)." }],
      };
    }

    var i;
    if (rawSegments) {
      for (i = 0; i < rawSegments.length; i += 1) {
        var raw = rawSegments[i] || {};
        var t = readTimes(raw);
        if (!t) {
          errors.push({ block: i + 1, message: "Segmento sem tempos de início/fim." });
          continue;
        }
        if (t.endMs <= t.startMs) {
          errors.push({ block: i + 1, message: "Tempo final deve ser maior que o inicial." });
          continue;
        }
        var words = readWords(raw.words);
        if (!words.length && topWords.length) words = wordsInRange(topWords, t.startMs, t.endMs);
        var text = trim(raw.text) || joinWords(words);
        if (!text) {
          errors.push({ block: i + 1, message: "Segmento sem texto." });
          continue;
        }
        var item = { index: i + 1, startMs: t.startMs, endMs: t.endMs, text: text };
        if (words.length) item.words = words;
        items.push(item);
      }
    } else {
      items = itemsFromWords(topWords);
    }

    if (!items.length && !errors.length) {
      errors.push({ block: 0, message: "Transcrição vazia." });
    }

    items.sort(function (a, b) {
      return a.startMs - b.startMs || a.endMs - b.endMs;
    });

    return { items: items, errors: errors };
  }

  return { parseTranscript: parseTranscript, itemsFromWords: itemsFromWords, itemsFromText: itemsFromText, followCuts: followCuts };
});
