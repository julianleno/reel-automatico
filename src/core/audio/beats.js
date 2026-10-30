/**
 * Batidas da música para marcar a timeline (cortar no ritmo). Independente de Adobe.
 *
 * findBeats(db, windowMs) -> { bpm, beats:[ms] }
 *   db: volume por janela em dBFS (o mesmo envelope do detector de silêncio, 10 ms por janela).
 *
 * 1) força de ataque: quanto o volume sobe de uma janela para a próxima (só subidas);
 * 2) andamento: autocorrelação dessa força entre 60 e 180 BPM, com preferência suave por
 *    ~120 BPM (evita escolher o dobro ou a metade do andamento);
 * 3) fase: o deslocamento em que os ataques caem em cima da grade;
 * 4) cada batida procura o ataque mais forte perto de onde a grade diz (a música varia um pouco).
 *
 * Global no painel: AppLegendasCore.findBeats. No Node (testes): module.exports.
 */
(function (root, factory) {
  if (typeof window === "undefined" && typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.AppLegendasCore = root.AppLegendasCore || {};
    root.AppLegendasCore.findBeats = factory().findBeats;
  }
})(typeof self !== "undefined" ? self : this, function () {
  var MIN_BPM = 60;
  var MAX_BPM = 180;
  var PREFERRED_BPM = 120;
  var SNAP_MS = 40; // quanto cada batida pode sair da grade para cair no ataque
  var PHASE_WINDOW_MS = 4000;

  // Subidas do volume (média de 3 janelas: acordes "batem" e fazem o volume tremer a cada
  // janela), só o que passa da média em volta (±0,5 s): sobra o golpe, não o tremor.
  function onsets(db) {
    var n = db.length, s = new Float64Array(n), flux = new Float64Array(n), out = new Float64Array(n);
    for (var i = 0; i < n; i += 1) s[i] = (db[Math.max(0, i - 1)] + db[i] + db[Math.min(n - 1, i + 1)]) / 3;
    for (i = 1; i < n; i += 1) flux[i] = Math.max(0, s[i] - s[i - 1]);
    var R = 25, sum = 0, lo = 0, hi = -1;
    for (i = 0; i < n; i += 1) {
      while (hi < Math.min(n - 1, i + R)) sum += flux[++hi];
      while (lo < i - R) sum -= flux[lo++];
      out[i] = Math.max(0, flux[i] - sum / (hi - lo + 1));
    }
    return out;
  }

  // Ataques espalhados por ±2 janelas: com período fracionário (140 BPM = 42,86 janelas) os
  // golpes caem ora numa janela, ora na vizinha, e sem isso a autocorrelação perde o pico.
  function blur(o) {
    var out = new Float64Array(o.length);
    var k = [1, 2, 3, 2, 1];
    for (var i = 0; i < o.length; i += 1) {
      for (var j = -2; j <= 2; j += 1) if (o[i + j] !== undefined) out[i] += o[i + j] * k[j + 2];
    }
    return out;
  }

  // Lag (em janelas, fracionário) com a maior autocorrelação ponderada pela preferência.
  function tempoLag(o, windowMs) {
    o = blur(o);
    var minLag = Math.floor(60000 / MAX_BPM / windowMs);
    var maxLag = Math.ceil(60000 / MIN_BPM / windowMs);
    var scores = [];
    for (var lag = minLag; lag <= maxLag; lag += 1) {
      var sum = 0;
      for (var i = lag; i < o.length; i += 1) sum += o[i] * o[i - lag];
      var bpm = 60000 / (lag * windowMs);
      var prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / PREFERRED_BPM) / 0.9, 2));
      scores.push(sum * prior);
    }
    var best = 0;
    for (var k = 1; k < scores.length; k += 1) if (scores[k] > scores[best]) best = k;
    if (!(scores[best] > 0)) return 0;
    // refino sub-janela (parábola nos vizinhos)
    var a = scores[best - 1], b = scores[best], c = scores[best + 1];
    var shift = a !== undefined && c !== undefined && a - 2 * b + c !== 0 ? 0.5 * (a - c) / (a - 2 * b + c) : 0;
    return minLag + best + Math.max(-0.5, Math.min(0.5, shift));
  }

  function findBeats(db, windowMs) {
    var o = onsets(db);
    var lag = tempoLag(o, windowMs);
    if (!lag) return { bpm: 0, beats: [] };
    // fase: soma dos ataques na grade, para cada deslocamento dentro de uma batida, só nos
    // primeiros 4 s depois do primeiro golpe forte: se o andamento muda aos poucos, a grade da
    // música inteira escorrega e a fase média cai entre as batidas; daqui em diante, cada batida
    // se acerta sozinha no ataque mais perto.
    var loudest = 0;
    for (var q = 0; q < o.length; q += 1) if (o[q] > loudest) loudest = o[q];
    var from = 0;
    while (from < o.length && o[from] < 0.3 * loudest) from += 1;
    var until = Math.min(o.length, from + Math.round(PHASE_WINDOW_MS / windowMs));
    var bestPhase = from, bestScore = -1, hits = 1;
    for (var p = from; p < from + Math.ceil(lag); p += 1) {
      var score = 0, n = 0;
      for (var t = p; t < until; t += lag) { score += o[Math.round(t)] || 0; n += 1; }
      if (score > bestScore) { bestScore = score; bestPhase = p; hits = n; }
    }
    var strong = 0.3 * bestScore / hits; // ataque que conta como batida: 30% do típico da grade
    // a janela de acerto cresce com a batida (12%), e o passo segue os intervalos que acertaram
    // golpe (devagar e no máximo 10% longe do andamento achado): música que acelera continua em cima
    var snap = Math.max(Math.round(SNAP_MS / windowMs), Math.round(lag * 0.12));
    var beats = [];
    var expected = bestPhase, step = lag, last = -1;
    while (Math.round(expected) < o.length) { // arredondado: a última batida não passa do fim
      var at = Math.round(expected), peak = at;
      for (var j = Math.max(0, at - snap); j <= Math.min(o.length - 1, at + snap); j += 1) {
        if (o[j] > o[peak]) peak = j;
      }
      // ataque fraco perto: fica a grade; forte: a batida vai para ele e a grade segue dali
      var hit = o[peak] >= strong;
      var chosen = hit ? peak : at;
      if (hit && last >= 0) step = Math.max(lag * 0.9, Math.min(lag * 1.1, 0.8 * step + 0.2 * (chosen - last)));
      last = hit ? chosen : -1;
      beats.push(Math.round(chosen * windowMs));
      expected = chosen + step;
    }
    return { bpm: Math.round(60000 / (lag * windowMs) * 10) / 10, beats: beats };
  }

  return { findBeats: findBeats };
});
