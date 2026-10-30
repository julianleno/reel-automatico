/**
 * Linhas da legenda, como no painel Legendas do Premiere: cada linha é exatamente o que vai
 * para a timeline (um segmento de buildSegments), com entrada, saída e texto editáveis.
 *
 * Line = { id, inSeconds, outSeconds, text, words: [{ text, inSeconds, outSeconds }] }
 *
 * linesToItems(lines, offsetMs) -> CaptionItem[] travados (locked): o segmentador não divide
 *   de novo o que o usuário arrumou à mão. offsetMs é o deslocamento já somado nas linhas.
 * setLineText(line, text)            mesmo nº de palavras mantém o tempo de cada uma
 * setLineTimes(line, inS, outS)      as palavras acompanham, na mesma proporção
 * splitLine(line, wordIndex)         -> [antes, depois]; a segunda começa na sua 1ª palavra
 * mergeLines(a, b)                   -> uma linha de a.inSeconds até b.outSeconds
 * setLineKey(line, wordIndex)        a palavra de destaque escolhida à mão (-1 = nenhuma)
 * formatFrames(seconds, fps)         -> "00:01:26:23" (hh:mm:ss:quadros, como o Premiere)
 * parseTimecode(text, fps)           -> segundos ("00:01:26:23", "1:26.5", "86,2") ou NaN
 */
(function (root, factory) {
  // No painel CEP o Node também define `module`; lá o destino é o global do painel.
  if (typeof window === "undefined" && typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.AppLegendasCore = root.AppLegendasCore || {};
    var api = factory();
    Object.keys(api).forEach(function (k) {
      root.AppLegendasCore[k] = api[k];
    });
  }
})(typeof self !== "undefined" ? self : this, function () {
  var MIN_SECONDS = 0.04;

  function words(text) {
    return String(text === null || text === undefined ? "" : text).split(/\s+/).filter(Boolean);
  }

  // Fala baixa da 2ª escuta (quiet) e tempo estimado são da fala, não do texto: ficam com a palavra
  // em todas as edições (sem quiet o Autocorte corta a frase baixa como silêncio).
  function marks(from, to) {
    if (from.quiet) to.quiet = true;
    if (from.estimated) to.estimated = true;
    return to;
  }

  function copyWords(list) {
    return (list || []).map(function (w) {
      var out = { text: w.text, inSeconds: w.inSeconds, outSeconds: w.outSeconds };
      if (w.manualKey) out.manualKey = true;
      return marks(w, out);
    });
  }

  function make(id, inSeconds, outSeconds, list, keyManual) {
    var line = {
      id: id,
      inSeconds: inSeconds,
      outSeconds: outSeconds,
      text: list.map(function (w) { return w.text; }).join(" "),
      words: list,
    };
    if (keyManual) line.keyManual = true;
    return line;
  }

  // Palavras sem tempo (texto novo com outro nº de palavras): repartidas por igual.
  function spread(parts, inSeconds, outSeconds) {
    var step = (outSeconds - inSeconds) / Math.max(1, parts.length);
    return parts.map(function (p, i) {
      return { text: p, inSeconds: inSeconds + i * step, outSeconds: inSeconds + (i + 1) * step };
    });
  }

  function setLineText(line, text) {
    var parts = words(text);
    if (!parts.length) return null;
    var list = copyWords(line.words);
    if (parts.length === list.length) {
      // a palavra corrigida continua no tempo da fala de antes: fica com as marcas dela
      parts.forEach(function (p, i) { list[i].text = p; });
    } else {
      // palavras novas, tempo repartido: fica baixa a que tem o meio no tempo de uma palavra baixa
      list = spread(parts, line.inSeconds, line.outSeconds);
      list.forEach(function (w) {
        var mid = (w.inSeconds + w.outSeconds) / 2;
        if ((line.words || []).some(function (o) { return o.quiet && o.inSeconds <= mid && mid < o.outSeconds; })) w.quiet = true;
      });
    }
    return make(line.id, line.inSeconds, line.outSeconds, list, line.keyManual);
  }

  function setLineTimes(line, inSeconds, outSeconds) {
    var a = Math.max(0, Number(inSeconds));
    var b = Number(outSeconds);
    if (!isFinite(a) || !isFinite(b)) return null;
    if (b < a + MIN_SECONDS) b = a + MIN_SECONDS;
    var span = line.outSeconds - line.inSeconds;
    if (!(span > 0)) return make(line.id, a, b, spread(words(line.text), a, b), line.keyManual);
    var k = (b - a) / span;
    var list = copyWords(line.words).map(function (w, i, all) {
      return Object.assign(w, {
        inSeconds: a + (w.inSeconds - line.inSeconds) * k,
        outSeconds: i === all.length - 1 ? b : a + (w.outSeconds - line.inSeconds) * k,
      });
    });
    return make(line.id, a, b, list, line.keyManual);
  }

  function splitLine(line, wordIndex) {
    var list = copyWords(line.words);
    if (wordIndex <= 0 || wordIndex >= list.length) return null;
    var at = list[wordIndex].inSeconds;
    if (!(at > line.inSeconds && at < line.outSeconds)) {
      // tempos estimados: a divisão cai na proporção das palavras
      at = line.inSeconds + (line.outSeconds - line.inSeconds) * wordIndex / list.length;
    }
    var first = list.slice(0, wordIndex);
    var second = list.slice(wordIndex);
    first[first.length - 1].outSeconds = Math.min(first[first.length - 1].outSeconds, at);
    second[0].inSeconds = Math.max(second[0].inSeconds, at);
    return [make(line.id + "a", line.inSeconds, at, first, line.keyManual), make(line.id + "b", at, line.outSeconds, second, line.keyManual)];
  }

  function mergeLines(a, b) {
    var list = copyWords(a.words).concat(copyWords(b.words));
    return make(a.id, Math.min(a.inSeconds, b.inSeconds), Math.max(a.outSeconds, b.outSeconds), list, a.keyManual || b.keyManual);
  }

  function setLineKey(line, wordIndex) {
    var list = copyWords(line.words).map(function (w, i) {
      if (i === wordIndex) w.manualKey = true;
      else delete w.manualKey;
      return w;
    });
    return make(line.id, line.inSeconds, line.outSeconds, list, true);
  }

  function linesToItems(lines, offsetMs) {
    var shift = Number(offsetMs) || 0;
    return (lines || []).map(function (line, i) {
      var ms = function (s) { return Math.round(s * 1000 - shift); };
      return {
        index: i + 1,
        startMs: ms(line.inSeconds),
        endMs: ms(line.outSeconds),
        text: line.text,
        words: (line.words || []).map(function (w) {
          var out = { text: w.text, startMs: ms(w.inSeconds), endMs: ms(w.outSeconds) };
          if (w.manualKey) out.manualKey = true;
          return marks(w, out);
        }),
        locked: true,
        keyManual: !!line.keyManual,
      };
    });
  }

  function pad(n) {
    return (n < 10 ? "0" : "") + n;
  }

  function formatFrames(seconds, fps) {
    var rate = Math.max(1, Math.round(Number(fps) || 30));
    var total = Math.max(0, Math.round(Number(seconds) * rate));
    var f = total % rate;
    var s = Math.floor(total / rate);
    return pad(Math.floor(s / 3600)) + ":" + pad(Math.floor(s / 60) % 60) + ":" + pad(s % 60) + ":" + pad(f);
  }

  function parseTimecode(text, fps) {
    var t = String(text || "").trim().replace(",", ".");
    if (!t) return NaN;
    var rate = Math.max(1, Math.round(Number(fps) || 30));
    var parts = t.split(":");
    if (parts.some(function (p) { return !/^\d+(\.\d+)?$/.test(p); })) return NaN;
    var n = parts.map(Number);
    if (n.length === 4) return n[0] * 3600 + n[1] * 60 + n[2] + n[3] / rate;
    if (n.length === 3) return n[0] * 3600 + n[1] * 60 + n[2];
    if (n.length === 2) return n[0] * 60 + n[1];
    return n[0];
  }

  return {
    linesToItems: linesToItems,
    setLineText: setLineText,
    setLineTimes: setLineTimes,
    splitLine: splitLine,
    mergeLines: mergeLines,
    setLineKey: setLineKey,
    formatFrames: formatFrames,
    parseTimecode: parseTimecode,
  };
});
