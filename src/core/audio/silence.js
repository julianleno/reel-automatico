/**
 * Detecção de silêncio independente de Adobe.
 *
 * 1) createEnvelope(sampleRate, windowMs): acumula PCM 16-bit mono (em streaming) e devolve o
 *    volume RMS de cada janela em dBFS.
 * 2) detectSilences(db, windowMs, options): encontra os trechos silenciosos.
 * 3) keepRanges(silences, totalMs): o complemento (o que fica depois do corte).
 * 4) cutPlan(silences, fps): os silêncios em quadros, prontos para extrair da timeline.
 *
 * Silence = { startMs, endMs }  (relativo ao início do áudio analisado)
 */
(function (root, factory) {
  // No painel CEP o Node também define `module`; lá o destino é o global do painel.
  if (typeof window === "undefined" && typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.AppLegendasCore = root.AppLegendasCore || {};
    root.AppLegendasCore.createEnvelope = factory().createEnvelope;
    root.AppLegendasCore.detectSilences = factory().detectSilences;
    root.AppLegendasCore.keepRanges = factory().keepRanges;
    root.AppLegendasCore.cutPlan = factory().cutPlan;
    root.AppLegendasCore.settleEdges = factory().settleEdges;
    root.AppLegendasCore.settleCuts = factory().settleCuts;
    root.AppLegendasCore.SILENCE_DEFAULTS = factory().SILENCE_DEFAULTS;
    root.AppLegendasCore.voiceLevel = factory().voiceLevel;
    root.AppLegendasCore.levelGains = factory().levelGains;
    root.AppLegendasCore.mediaSpans = factory().mediaSpans;
    root.AppLegendasCore.clipWindows = factory().clipWindows;
    root.AppLegendasCore.timelineEnvelope = factory().timelineEnvelope;
  }
})(typeof self !== "undefined" ? self : this, function () {
  var MIN_DB = -100; // silêncio digital
  var FULL_SCALE = 32768;
  var HYSTERESIS_DB = 6;
  var MANUAL_HYSTERESIS_DB = 2;
  var QUIET_SPEECH_MIN_MS = 300; // trecho cortado só conta como fala baixa (com palavras) a partir disso

  var SILENCE_DEFAULTS = {
    thresholdDb: null, // null = automático (a partir do ruído de fundo e do nível da fala)
    minSilenceMs: 500, // pausas menores que isso são mantidas
    paddingMs: 120, // respiro mantido antes e depois de cada fala
    // Ruídos mais curtos que isso no meio do silêncio (cliques) são ignorados. Curto de propósito:
    // em fala rápida com redução de ruído (celular) há sílabas de 40-60 ms entre quase-silêncios,
    // e com 150 ms o corte comia palavras ("quartas-feiras", "que está acontecendo").
    minSpeechMs: 30,
    // > 0: frase inteira com o pico N dB abaixo do nível normal da voz vira silêncio (quem ensaia
    // ou lê o roteiro baixinho entre as tomadas). 0 = desligado.
    quietSpeechDb: 0,
  };

  function createEnvelope(sampleRate, windowMs) {
    var perWindow = Math.max(1, Math.round((Number(sampleRate) * Number(windowMs)) / 1000));
    var db = [];
    var sum = 0;
    var count = 0;
    var carry = -1; // byte solto entre dois blocos

    function flush() {
      if (!count) return;
      var rms = Math.sqrt(sum / count) / FULL_SCALE;
      db.push(rms > 0 ? Math.max(MIN_DB, 20 * Math.log10(rms)) : MIN_DB);
      sum = 0;
      count = 0;
    }

    function sample(v) {
      sum += v * v;
      count += 1;
      if (count === perWindow) flush();
    }

    function int16(lo, hi) {
      var v = lo | (hi << 8);
      return v >= 32768 ? v - 65536 : v;
    }

    return {
      // bytes: Uint8Array/Buffer com PCM s16le
      pushBytes: function (bytes) {
        var i = 0;
        if (carry >= 0 && bytes.length) {
          sample(int16(carry, bytes[0]));
          carry = -1;
          i = 1;
        }
        for (; i + 1 < bytes.length; i += 2) sample(int16(bytes[i], bytes[i + 1]));
        if (i < bytes.length) carry = bytes[i];
      },
      pushSamples: function (samples) {
        for (var i = 0; i < samples.length; i += 1) sample(samples[i]);
      },
      finish: function () {
        flush();
        return db;
      },
    };
  }

  function percentile(sorted, p) {
    if (!sorted.length) return MIN_DB;
    var idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
    return sorted[idx];
  }

  // Limite entre o ruído de fundo (10% mais baixo) e a fala (5% mais alto).
  function autoThreshold(sorted) {
    var floor = percentile(sorted, 0.1);
    var peak = percentile(sorted, 0.95);
    var range = peak - floor;
    // Volume quase constante: não há pausa clara, então nada deve ser marcado.
    if (range < 10) return floor - 6;
    // 30% do caminho entre o piso e a fala: com 40%, em áudio sempre alto (música de fundo,
    // compressão) o limite caía no nível da fala mais baixa e cortava palavras.
    return Math.min(-20, Math.max(-70, floor + range * 0.3));
  }

  // Frase = fala sem pausa de gapWindows no meio. O nível dela é o pico (90%) e o da voz é a
  // mediana desses picos, pesada pela duração: a fala de verdade domina o vídeo.
  function dropQuietPhrases(db, silent, gapWindows, belowDb, quiet) {
    var n = silent.length;
    var phrases = [];
    var i = 0;
    while (i < n) {
      if (silent[i]) {
        i += 1;
        continue;
      }
      var end = i + 1;
      var gap = 0;
      for (var j = i + 1; j < n && gap < gapWindows; j += 1) {
        if (silent[j]) gap += 1;
        else {
          end = j + 1;
          gap = 0;
        }
      }
      var levels = Array.prototype.slice.call(db, i, end).sort(function (a, b) {
        return a - b;
      });
      phrases.push({ start: i, end: end, level: percentile(levels, 0.9) });
      i = end;
    }
    if (!phrases.length) return;
    var byLevel = phrases.slice().sort(function (a, b) {
      return b.level - a.level;
    });
    var total = phrases.reduce(function (sum, p) {
      return sum + p.end - p.start;
    }, 0);
    var acc = 0;
    var voice = byLevel[0].level;
    for (i = 0; i < byLevel.length && acc < total / 2; i += 1) {
      acc += byLevel[i].end - byLevel[i].start;
      voice = byLevel[i].level;
    }
    phrases.forEach(function (p) {
      if (p.level < voice - belowDb) for (var k = p.start; k < p.end; k += 1) silent[k] = quiet[k] = true;
    });
  }

  function merge(base, extra) {
    var out = {};
    var k;
    for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    for (k in extra || {}) {
      if (Object.prototype.hasOwnProperty.call(extra, k) && extra[k] !== undefined) out[k] = extra[k];
    }
    return out;
  }

  function detectSilences(db, windowMs, options) {
    var opt = merge(SILENCE_DEFAULTS, options);
    var n = db.length;
    var totalMs = n * windowMs;
    var manual = opt.thresholdDb !== null && opt.thresholdDb !== "" && isFinite(Number(opt.thresholdDb));
    var sorted = Array.prototype.slice.call(db).sort(function (a, b) {
      return a - b;
    });
    var thresholdDb = manual ? Number(opt.thresholdDb) : autoThreshold(sorted);
    // A segunda faixa vai no máximo a 3/4 do caminho para o piso: a pausa (no nível do piso)
    // continua abaixo dela mesmo com música de fundo. Calibrado em 3 vídeos reais (out/2026).
    // No limite manual a margem é pequena: quem põe o limite logo acima de uma conversa ao fundo quer
    // que ela saia mesmo colada na fala (o respiro protege o fim das palavras).
    var floorDb = percentile(sorted, 0.1);
    var closeDb = thresholdDb - Math.max(0, Math.min(manual ? MANUAL_HYSTERESIS_DB : HYSTERESIS_DB, (thresholdDb - floorDb) * 0.75));
    var minSilenceMs = Math.max(0, Number(opt.minSilenceMs) || 0);
    var paddingMs = Math.max(0, Number(opt.paddingMs) || 0);
    var minSpeechWindows = Math.ceil(Math.max(0, Number(opt.minSpeechMs) || 0) / windowMs);

    // Dois limites, como o Detect Silence do Cubase: a fala começa acima do limite e só termina
    // abaixo de closeDb, para o fim de uma palavra que vai sumindo não virar pausa.
    var silent = [];
    var i;
    var speaking = false;
    for (i = 0; i < n; i += 1) {
      if (db[i] >= thresholdDb) speaking = true;
      else if (db[i] < closeDb) speaking = false;
      silent.push(!speaking);
    }

    // Ruído curto cercado de silêncio dos dois lados vira silêncio.
    i = 0;
    while (i < n) {
      if (silent[i]) {
        i += 1;
        continue;
      }
      var j = i;
      while (j < n && !silent[j]) j += 1;
      if (i > 0 && j < n && j - i < minSpeechWindows) {
        for (var k = i; k < j; k += 1) silent[k] = true;
      }
      i = j;
    }

    var quietDb = Number(opt.quietSpeechDb) || 0;
    var quiet = []; // janelas de fala baixa: o trecho tem palavras (ensaio), não é silêncio de verdade
    if (quietDb > 0) dropQuietPhrases(db, silent, Math.max(1, Math.ceil(minSilenceMs / windowMs)), quietDb, quiet);

    var silences = [];
    var silentMs = 0;
    i = 0;
    while (i < n) {
      if (!silent[i]) {
        i += 1;
        continue;
      }
      var end = i;
      while (end < n && silent[end]) end += 1;
      var rawStart = i * windowMs;
      var rawEnd = end * windowMs;
      if (rawEnd - rawStart >= minSilenceMs) {
        // O respiro só existe do lado em que há fala (não nas pontas do áudio).
        var startMs = i === 0 ? rawStart : rawStart + paddingMs;
        var endMs = end === n ? rawEnd : rawEnd - paddingMs;
        if (endMs > startMs) {
          // fala baixa de verdade (ensaio): 300 ms ou mais; um estalo baixo no silêncio não conta
          var quietMs = 0;
          for (var q = i; q < end; q += 1) if (quiet[q]) quietMs += windowMs;
          silences.push(quietMs >= QUIET_SPEECH_MIN_MS ? { startMs: startMs, endMs: endMs, quiet: true } : { startMs: startMs, endMs: endMs });
          silentMs += endMs - startMs;
        }
      }
      i = end;
    }

    // floorDb/speechDb: o que o painel mostra para o editor escolher o limite sem abrir o medidor do Premiere
    return { thresholdDb: thresholdDb, floorDb: floorDb, speechDb: percentile(sorted, 0.95), silences: silences, totalMs: totalMs, silentMs: silentMs };
  }

  function keepRanges(silences, totalMs) {
    var out = [];
    var cursor = 0;
    for (var i = 0; i < silences.length; i += 1) {
      if (silences[i].startMs > cursor) out.push({ startMs: cursor, endMs: silences[i].startMs });
      cursor = Math.max(cursor, silences[i].endMs);
    }
    if (cursor < totalMs) out.push({ startMs: cursor, endMs: totalMs });
    return out;
  }

  /**
   * Emenda no silêncio, nunca dentro da voz (docs/padrao-reel.md, regra 11): app e painel.
   * settleEdges(keep, words, db, windowMs, thresholdDb, span, reach) -> os trechos que ficam com cada emenda
   * que caiu dentro da voz (a janela da emenda acima do limite, db em janelas de windowMs) levada para o
   * silêncio mais perto do lado que mantém mais, a até `reach` ms, se ali só há o resto da mesma palavra
   * (nenhuma outra começa no caminho): o Whisper fecha "essencial." em 80,07 s e a voz vai até 80,66 s; o fim
   * do trecho escolhido na duração (80,22 s) comia o "-cial" (Roteiro 4). Sem esse silêncio (palavras coladas),
   * vai para o vale do envelope a até `span` ms, a fronteira entre as sílabas: "concentração | e da própria
   * performance, e da própria performance." (Roteiro 4, 95,4 s): o retake começava no "e" do Whisper, colado,
   * e cortava a voz em -16 dB; o vale (-54 dB) está 80 ms antes. Nem um nem outro: fica. O começo do 1º
   * trecho e o fim do último não mudam.
   */
  function settleEdges(keep, words, db, windowMs, thresholdDb, span, reach) {
    function at(ms) { return db[Math.floor(ms / windowMs)]; }
    function loud(ms) { return at(ms) >= thresholdDb; }
    function move(ms, dir) {
      if (!loud(ms)) return ms;
      var t;
      for (t = ms + dir * windowMs; Math.abs(t - ms) <= reach && t >= 0; t += dir * windowMs) {
        var to = t;
        if (words.some(function (w) { return dir > 0 ? w.startMs >= ms && w.startMs < to : w.endMs > to && w.endMs <= ms; })) break;
        if (!loud(t)) return dir > 0 ? t : t + windowMs;
      }
      var best = ms;
      for (t = ms - span; t <= ms + span; t += windowMs) if (t >= 0 && at(t) < at(best)) best = t;
      return at(best) <= at(ms) - 12 ? best : ms;
    }
    return keep.map(function (r, i) {
      var startMs = i > 0 ? Math.max(keep[i - 1].endMs, move(r.startMs, -1)) : r.startMs;
      var endMs = i < keep.length - 1 ? Math.min(keep[i + 1].startMs, move(r.endMs, 1)) : r.endMs;
      return endMs > startMs ? Object.assign({}, r, { startMs: startMs, endMs: endMs }) : r;
    });
  }

  /**
   * O settleEdges no plano de corte do painel: cortes ({startSeconds, endSeconds} na sequência, como o
   * cutPlan recebe; db no tempo da sequência, timelineEnvelope) -> os mesmos cortes, juntados onde se
   * sobrepõem, com as emendas fora da voz (120 ms de vale, 500 de silêncio, os números do app). O retake
   * do Roteiro 4 (95,4 s) começava no "e" colado a "concentração" e raspava a voz no Autocorte também.
   */
  function settleCuts(cuts, words, db, windowMs, thresholdDb) {
    var sorted = cuts.map(function (c) { return { startMs: c.startSeconds * 1000, endMs: c.endSeconds * 1000 }; })
      .sort(function (a, b) { return a.startMs - b.startMs; });
    // o último trecho vai até o infinito: o fim da sequência não importa e o último corte também se ajusta
    var keep = settleEdges(keepRanges(sorted, Infinity), words || [], db, windowMs, thresholdDb, 120, 500);
    var out = keep.length && keep[0].startMs > 0 ? [{ startSeconds: 0, endSeconds: keep[0].startMs / 1000 }] : [];
    for (var i = 0; i + 1 < keep.length; i += 1) out.push({ startSeconds: keep[i].endMs / 1000, endSeconds: keep[i + 1].startMs / 1000 });
    return out;
  }

  /**
   * Silêncios da sequência ({startSeconds, endSeconds}) em trechos de quadros inteiros para
   * extrair: arredondados ao quadro, sobrepostos ou encostados juntados, vazios descartados e
   * do fim para o começo (cada corte não muda a posição dos anteriores).
   */
  function cutPlan(silences, fps) {
    var rate = Number(fps) || 30;
    var frames = [];
    for (var i = 0; i < (silences || []).length; i += 1) {
      var a = Math.round(silences[i].startSeconds * rate);
      var b = Math.round(silences[i].endSeconds * rate);
      if (b > a) frames.push({ startFrame: Math.max(0, a), endFrame: b });
    }
    frames.sort(function (x, y) {
      return x.startFrame - y.startFrame;
    });
    var merged = [];
    var total = 0;
    var sliver = Math.round(0.2 * rate); // sobra menor que 0,2 s entre dois cortes é estalo, não fala (fx-2: 0,13 s)
    for (i = 0; i < frames.length; i += 1) {
      var last = merged[merged.length - 1];
      if (last && frames[i].startFrame - last.endFrame < sliver) last.endFrame = Math.max(last.endFrame, frames[i].endFrame);
      else merged.push(frames[i]);
    }
    for (i = 0; i < merged.length; i += 1) total += merged[i].endFrame - merged[i].startFrame;
    return { ranges: merged.reverse(), frames: total };
  }

  /**
   * Nível da voz num trecho: energia média só das janelas de fala (acima do limite automático)
   * e o pico. voiceLevel(db, windowMs) -> { levelDb, peakDb, speechMs }
   */
  function voiceLevel(db, windowMs) {
    var sorted = Array.prototype.slice.call(db).sort(function (a, b) { return a - b; });
    var limit = autoThreshold(sorted);
    var power = 0;
    var n = 0;
    var peak = MIN_DB;
    for (var i = 0; i < db.length; i += 1) {
      if (db[i] > peak) peak = db[i];
      if (db[i] <= limit) continue;
      power += Math.pow(10, db[i] / 10);
      n += 1;
    }
    return { levelDb: n ? 10 * Math.log10(power / n) : MIN_DB, peakDb: peak, speechMs: n * windowMs };
  }

  /**
   * Ganho de cada clipe para a voz ficar no mesmo volume no vídeo todo: o alvo é a mediana dos
   * níveis (pelo menos -20 dBFS, voz de Reel), até ±9 dB, sem passar o pico de -1 dBFS. Trecho
   * com menos de 0,3 s de fala e diferença abaixo de 0,5 dB ficam como estão (0).
   * levelGains([{levelDb, peakDb, speechMs}]) -> { targetDb, gains:[dB] }
   */
  var LEVEL_MIN_TARGET_DB = -20;
  var LEVEL_MAX_GAIN_DB = 9;
  function levelGains(levels) {
    var voiced = levels.filter(function (l) { return l.speechMs >= 300; })
      .map(function (l) { return l.levelDb; }).sort(function (a, b) { return a - b; });
    if (!voiced.length) return { targetDb: null, gains: levels.map(function () { return 0; }) };
    var target = Math.round(Math.max(LEVEL_MIN_TARGET_DB, percentile(voiced, 0.5)) * 10) / 10;
    return {
      targetDb: target,
      gains: levels.map(function (l) {
        if (l.speechMs < 300) return 0;
        var g = Math.max(-LEVEL_MAX_GAIN_DB, Math.min(LEVEL_MAX_GAIN_DB, target - l.levelDb, -1 - l.peakDb));
        return Math.abs(g) < 0.5 ? 0 : Math.round(g * 10) / 10;
      }),
    };
  }

  /**
   * Volume por janela de cada clipe da timeline, com um envelope por arquivo de mídia.
   * mediaSpans(clips) -> { arquivo: { from, to } }: o trecho da mídia que os clipes usam (s).
   * clipWindows(db, windowMs, spanFrom, clip) -> o pedaço de db daquele clipe.
   * timelineEnvelope(parts, windowMs, minLength) -> um envelope no tempo da sequência, -100 onde
   *   não há clipe, com pelo menos minLength janelas; parts: [{ startSeconds, db }].
   * clip: { mediaPath, inSeconds, startSeconds, endSeconds }
   */
  function mediaSpans(clips) {
    var spans = {};
    clips.forEach(function (c) {
      var s = spans[c.mediaPath] || (spans[c.mediaPath] = { from: Infinity, to: 0 });
      s.from = Math.min(s.from, c.inSeconds);
      s.to = Math.max(s.to, c.inSeconds + c.endSeconds - c.startSeconds);
    });
    return spans;
  }

  function clipWindows(db, windowMs, spanFrom, clip) {
    var a = Math.round((clip.inSeconds - spanFrom) * 1000 / windowMs);
    var b = Math.round((clip.inSeconds - spanFrom + clip.endSeconds - clip.startSeconds) * 1000 / windowMs);
    return Array.prototype.slice.call(db, a, b);
  }

  function timelineEnvelope(parts, windowMs, minLength) {
    var length = minLength || 0;
    parts.forEach(function (p) { length = Math.max(length, Math.round(p.startSeconds * 1000 / windowMs) + p.db.length); });
    var out = new Array(length);
    for (var i = 0; i < length; i += 1) out[i] = MIN_DB;
    parts.forEach(function (p) {
      var at = Math.round(p.startSeconds * 1000 / windowMs);
      for (var k = 0; k < p.db.length; k += 1) out[at + k] = p.db[k];
    });
    return out;
  }

  return {
    mediaSpans: mediaSpans,
    clipWindows: clipWindows,
    timelineEnvelope: timelineEnvelope,
    voiceLevel: voiceLevel,
    levelGains: levelGains,
    cutPlan: cutPlan,
    createEnvelope: createEnvelope,
    detectSilences: detectSilences,
    keepRanges: keepRanges,
    settleEdges: settleEdges,
    settleCuts: settleCuts,
    SILENCE_DEFAULTS: SILENCE_DEFAULTS,
  };
});
