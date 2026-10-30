/**
 * Quadros e layout das legendas renderizadas pelo painel (sem MOGRT), independente de Adobe.
 *
 * buildFrames(segments, options) -> Frame[]
 *   Frame = { id, inSeconds, outSeconds, words: string[], active }
 *   Com destaque, cada legenda vira um quadro por palavra (active = índice da palavra falada);
 *   sem destaque, um quadro por legenda (active = -1).
 *
 * layoutWords(words, measure, options) -> { lines: [{ width, words: [{ index, text, x, width }] }], width }
 *   Quebra as palavras em linhas de até maxWidth px e maxChars caracteres. `measure(text)`
 *   devolve a largura em px. Com balance, duas linhas saem com larguras parecidas.
 */
(function (root, factory) {
  // No painel CEP o Node também define `module`; lá o destino é o global do painel.
  if (typeof window === "undefined" && typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.AppLegendasCore = root.AppLegendasCore || {};
    root.AppLegendasCore.buildFrames = factory().buildFrames;
    root.AppLegendasCore.layoutWords = factory().layoutWords;
  }
})(typeof self !== "undefined" ? self : this, function () {
  // Quadros mais curtos que isso (~1 frame a 24 fps) não chegam a aparecer na timeline.
  var MIN_FRAME_SECONDS = 0.042;

  // Destaque inteligente e emoji da legenda (core/captions/emphasis.js) seguem para o desenho.
  function decoration(seg) {
    var keys = [];
    for (var i = 0; i < seg.words.length; i += 1) keys.push(!!seg.words[i].key);
    return { keys: keys, emoji: seg.emoji || "" };
  }

  function withDecoration(frame, extra) {
    frame.keys = extra.keys;
    frame.emoji = extra.emoji;
    return frame;
  }

  function buildFrames(segments, options) {
    var highlight = !!(options && options.highlight);
    var frames = [];

    for (var s = 0; s < (segments || []).length; s += 1) {
      var seg = segments[s];
      var texts = [];
      var w;
      for (w = 0; w < seg.words.length; w += 1) texts.push(seg.words[w].text);

      var extra = decoration(seg);
      if (!highlight || seg.words.length < 2) {
        frames.push(withDecoration({ id: seg.id, inSeconds: seg.inSeconds, outSeconds: seg.outSeconds, words: texts, active: highlight ? 0 : -1 }, extra));
        continue;
      }

      // Palavra curta demais para um quadro próprio cede o tempo à vizinha.
      var own = [];
      var carryStart = null;
      for (w = 0; w < seg.words.length; w += 1) {
        var word = seg.words[w];
        var start = carryStart !== null ? carryStart : word.inSeconds;
        carryStart = null;
        if (word.outSeconds - start < MIN_FRAME_SECONDS) {
          if (own.length) own[own.length - 1].outSeconds = word.outSeconds;
          else carryStart = start;
          continue;
        }
        own.push(withDecoration({ id: seg.id + "-" + (w + 1), inSeconds: start, outSeconds: word.outSeconds, words: texts, active: w }, extra));
      }
      if (!own.length) {
        own.push(withDecoration({ id: seg.id, inSeconds: seg.inSeconds, outSeconds: seg.outSeconds, words: texts, active: 0 }, extra));
      }
      for (w = 0; w < own.length; w += 1) frames.push(own[w]);
    }
    return frames;
  }

  function layoutWords(words, measure, options) {
    var maxWidth = Number(options && options.maxWidth) || Infinity;
    var maxChars = Number(options && options.maxChars) || Infinity;
    var space = measure(" ");
    var widths = [];
    var i;
    for (i = 0; i < words.length; i += 1) widths.push(measure(words[i], i)); // o índice: palavra-chave pode ser maior

    function measureRange(from, to) {
      var width = 0;
      for (var k = from; k < to; k += 1) width += widths[k] + (k > from ? space : 0);
      return width;
    }

    function fits(from, to) {
      var chars = 0;
      for (var k = from; k < to; k += 1) chars += String(words[k]).length + (k > from ? 1 : 0);
      return measureRange(from, to) <= maxWidth && chars <= maxChars;
    }

    // Primeiro encaixe: o menor número de linhas possível.
    var breaks = [0];
    for (i = 1; i < words.length; i += 1) {
      if (!fits(breaks[breaks.length - 1], i + 1)) breaks.push(i);
    }
    // Em duas linhas, divide onde as linhas ficam mais parecidas (sem "1 palavra + 6").
    if (options && options.balance && breaks.length === 2) {
      var best = breaks[1], bestWidth = Infinity;
      for (i = 1; i < words.length; i += 1) {
        if (!fits(0, i) || !fits(i, words.length)) continue;
        var a = measureRange(0, i), b = measureRange(i, words.length);
        if (Math.max(a, b) < bestWidth) { bestWidth = Math.max(a, b); best = i; }
      }
      breaks[1] = best;
    }

    var lines = [];
    var widest = 0;
    for (var l = 0; l < breaks.length && words.length; l += 1) {
      var end = l + 1 < breaks.length ? breaks[l + 1] : words.length;
      var line = { width: 0, words: [] };
      for (i = breaks[l]; i < end; i += 1) {
        var x = line.words.length ? line.width + space : 0;
        line.words.push({ index: i, text: words[i], x: x, width: widths[i] });
        line.width = x + widths[i];
      }
      lines.push(line);
      widest = Math.max(widest, line.width);
    }

    return { lines: lines, width: widest };
  }

  return { buildFrames: buildFrames, layoutWords: layoutWords };
});
