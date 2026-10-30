/**
 * Onde entram os efeitos sonoros das legendas.
 *
 * wordTimes(segments) -> [s]  início de cada palavra, em ordem (um clique por palavra)
 * sfxSlots(times, { lead, seconds, minSeconds }) -> [{ inSeconds, outSeconds }]
 *   Um som por momento, começando `lead` antes. Como os sons dividem uma trilha, o anterior é
 *   aparado quando o próximo chega antes de ele acabar; momentos a menos de `minSeconds` (um
 *   quadro) do anterior ficam sem som.
 */
(function (root, factory) {
  // No painel CEP o Node também define `module`; lá o destino é o global do painel.
  if (typeof window === "undefined" && typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.AppLegendasCore = root.AppLegendasCore || {};
    root.AppLegendasCore.wordTimes = factory().wordTimes;
    root.AppLegendasCore.sfxSlots = factory().sfxSlots;
  }
})(typeof self !== "undefined" ? self : this, function () {
  function wordTimes(segments) {
    var out = [];
    (segments || []).forEach(function (seg) {
      (seg.words || []).forEach(function (w) {
        out.push(w.inSeconds);
      });
    });
    return out;
  }

  function sfxSlots(times, options) {
    var lead = Number(options.lead) || 0;
    var seconds = Number(options.seconds) || 0.1;
    var minSeconds = Number(options.minSeconds) || 0;
    var slots = [];
    (times || [])
      .filter(function (t) { return isFinite(t); })
      .sort(function (a, b) { return a - b; })
      .forEach(function (t) {
        var at = Math.max(0, t - lead);
        var prev = slots[slots.length - 1];
        if (prev && at < prev.inSeconds + minSeconds) return;
        if (prev && prev.outSeconds > at) prev.outSeconds = at;
        slots.push({ inSeconds: at, outSeconds: at + seconds });
      });
    return slots;
  }

  return { wordTimes: wordTimes, sfxSlots: sfxSlots };
});
