/**
 * Quem está falando em cada momento, com um microfone por pessoa (podcast, entrevista).
 * Independente de Adobe.
 *
 * speakerTurns(tracks, windowMs, options) -> [{ startMs, endMs, track }]
 *   tracks: um envelope de volume (dBFS por janela) por microfone, todos no mesmo tempo.
 *   options.minTurnMs (padrão 1500): fala mais curta que isso no meio da vez do outro ("aham",
 *   "sei") não troca a vez.
 *
 * Cada microfone também capta o outro, mais baixo: vale o mais alto, e só quando passa do limite
 * de fala dele (o mesmo limite automático do detector de silêncio) com folga sobre os outros.
 * Pausa não troca a vez: fica com quem falou por último.
 *
 * Global no painel: AppLegendasCore.speakerTurns. No Node (testes): module.exports.
 */
(function (root, factory) {
  if (typeof window === "undefined" && typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.AppLegendasCore = root.AppLegendasCore || {};
    root.AppLegendasCore.speakerTurns = factory().speakerTurns;
    root.AppLegendasCore.shiftTurns = factory().shiftTurns;
  }
})(typeof self !== "undefined" ? self : this, function () {
  var MARGIN_DB = 3; // quanto o microfone de quem fala passa dos outros

  function limitOf(db) {
    var sorted = Array.prototype.slice.call(db).sort(function (a, b) { return a - b; });
    var at = function (p) { return sorted[Math.min(sorted.length - 1, Math.round((sorted.length - 1) * p))]; };
    var floor = at(0.1), peak = at(0.95);
    return floor + (peak - floor) * 0.3; // como o limite automático do silêncio
  }

  function speakerTurns(tracks, windowMs, options) {
    var minTurn = Math.max(1, Math.round(((options && options.minTurnMs) || 1500) / windowMs));
    var n = Math.min.apply(null, tracks.map(function (t) { return t.length; }));
    if (!tracks.length || !(n > 0)) return [];
    var limits = tracks.map(limitOf);
    // quem fala em cada janela (-1: ninguém com clareza)
    var who = new Array(n);
    for (var i = 0; i < n; i += 1) {
      var best = -1, second = -Infinity;
      for (var t = 0; t < tracks.length; t += 1) {
        if (best < 0 || tracks[t][i] > tracks[best][i]) {
          if (best >= 0) second = tracks[best][i];
          best = t;
        } else if (tracks[t][i] > second) {
          second = tracks[t][i];
        }
      }
      who[i] = tracks[best][i] > limits[best] && tracks[best][i] - second >= MARGIN_DB ? best : -1;
    }
    // a vez só troca quando o outro fala minTurn janelas (contando as dele, ignorando pausas)
    var current = -1, turns = [], start = 0;
    var candidate = -1, count = 0, candidateStart = 0;
    for (i = 0; i < n; i += 1) {
      var w = who[i];
      if (w < 0 || w === current) {
        if (w === current) { candidate = -1; count = 0; }
        continue;
      }
      if (w !== candidate) { candidate = w; count = 0; candidateStart = i; }
      count += 1;
      if (current < 0 || count >= minTurn) {
        if (current >= 0) turns.push({ startMs: start * windowMs, endMs: candidateStart * windowMs, track: current });
        current = w;
        start = candidateStart;
        candidate = -1;
        count = 0;
      }
    }
    if (current >= 0) turns.push({ startMs: start * windowMs, endMs: n * windowMs, track: current });
    if (turns.length) turns[0].startMs = 0; // antes de alguém falar, a primeira vez já vale
    return turns;
  }

  // J-cut / L-cut na troca de câmera (docs/jl-cut-estudo.md): cada troca de vez anda ms (positivo:
  // a imagem troca depois da voz, J; negativo: antes, L). O áudio não muda. Troca que deixaria uma
  // vez com menos de 1/3 s fica onde estava.
  function shiftTurns(turns, ms) {
    var out = turns.map(function (t) { return { startMs: t.startMs, endMs: t.endMs, track: t.track }; });
    for (var k = 1; k < out.length && ms; k += 1) {
      var at = out[k].startMs + ms;
      if (at - out[k - 1].startMs < 333 || out[k].endMs - at < 333) continue;
      out[k].startMs = at;
      out[k - 1].endMs = at;
    }
    return out;
  }

  return { speakerTurns: speakerTurns, shiftTurns: shiftTurns };
});
