/**
 * Acerta o início das palavras do Whisper pelo áudio.
 *
 * O Whisper erra o tempo justo onde mais aparece: na palavra depois de uma pausa. O modelo
 * "Boa" costuma pôr a palavra ainda no silêncio (legenda antes da fala); o "Máxima", depois
 * que a fala já começou (legenda atrasada, até 0,5 s). O áudio diz onde a fala recomeça.
 *
 * snapWordsToSpeech(words, silences, options) -> words (cópia)
 *   words:    [{ text, startMs, endMs }] em ordem
 *   silences: [{ startMs, endMs }] crescentes (core/audio/silence.js, sem respiro)
 *   1) palavra que começa dentro de um silêncio passa para o fim dele (onde a fala volta);
 *   2) a primeira palavra depois de um silêncio que acabou pouco antes volta para o fim dele;
 *   3) palavra que termina dentro de um silêncio termina onde ele começa;
 *   4) fim de frase que o Whisper carimbou no silêncio volta para antes dele (tempo estimado).
 *   Os inícios ficam sempre crescentes, a pelo menos MIN_GAP_MS um do outro.
 */
(function (root, factory) {
  // No painel CEP o Node também define `module`; lá o destino é o global do painel.
  if (typeof window === "undefined" && typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.AppLegendasCore = root.AppLegendasCore || {};
    root.AppLegendasCore.snapWordsToSpeech = factory().snapWordsToSpeech;
    root.AppLegendasCore.spreadCollapsed = factory().spreadCollapsed;
    root.AppLegendasCore.SPEECH_SILENCE = factory().SPEECH_SILENCE;
  }
})(typeof self !== "undefined" ? self : this, function () {
  // Para detectSilences: pausa entre frases, não o fechamento de uma consoante (p, t, k ~100 ms).
  var SPEECH_SILENCE = { minSilenceMs: 150, paddingMs: 0, minSpeechMs: 60 };
  var FORWARD_MS = 600; // até quanto a palavra anda para frente, saindo do silêncio
  // Para trás é mais arriscado: se o Whisper tirou um "é" ou "hã", o recomeço da fala é desse
  // vício, não da palavra.
  var BACK_MS = 400;
  var MIN_GAP_MS = 40;

  function containing(silences, t) {
    for (var i = 0; i < silences.length; i += 1) {
      if (silences[i].startMs <= t && t < silences[i].endMs) return silences[i];
      if (silences[i].startMs > t) break;
    }
    return null;
  }

  // Último silêncio que acabou em (after, t].
  function endedBefore(silences, after, t) {
    var found = null;
    for (var i = 0; i < silences.length && silences[i].endMs <= t; i += 1) {
      if (silences[i].endMs > after) found = silences[i];
    }
    return found;
  }

  // Palavras que começam num silêncio e ainda são da frase anterior: até a última com pontuação
  // ("mim," "só o anel."). Elas mostram que o Whisper atrasou, e levá-las para depois da pausa
  // pioraria o atraso.
  function staysBehind(words, silences) {
    var stays = [];
    var i = 0;
    while (i < words.length) {
      var sil = containing(silences, words[i].startMs);
      var j = i;
      while (j < words.length && sil && containing(silences, words[j].startMs) === sil) j += 1;
      if (!sil) j = i + 1;
      var last = -1;
      for (var k = i; sil && k < j; k += 1) if (/[.,!?;:…]["”')]?$/.test(words[k].text)) last = k;
      // depois de ponto final é frase nova, não o fim da anterior: "performance. [4 s] Então," (Roteiro 4, 104,1 s)
      // ia para 99,7 s, em cima do "performance.", e o Reel na duração emendava no meio da palavra
      if (i > 0 && /[.!?…]["”')]?$/.test(String(words[i - 1].text).trim())) last = -1;
      for (k = i; k < j; k += 1) stays.push(k <= last);
      i = j;
    }
    return stays;
  }

  // A primeira pausa de PAUSE_IN_WORD_MS ou mais inteira entre start e end (ms), ou null
  var PAUSE_IN_WORD_MS = 300;
  function pauseWithin(silences, start, end) {
    for (var i = 0; i < silences.length; i += 1) {
      var s = silences[i];
      if (s.startMs >= start + MIN_GAP_MS && s.endMs <= end && s.endMs - s.startMs >= PAUSE_IN_WORD_MS) return s;
    }
    return null;
  }

  // Estalo no meio de uma pausa longa não é a fala voltando ("ninguém" ia para 60 ms a -37 dB em 156,04 s,
  // entre 3,4 s e 6,5 s de silêncio, no 2.MOV: fx-3): as duas pausas valem como uma.
  var CLICK_MS = 120, CLICK_PAUSE_MS = 1000;
  function withoutClicks(silences) {
    var out = [];
    silences.forEach(function (s) {
      var last = out[out.length - 1];
      if (last && s.startMs - last.endMs < CLICK_MS && last.endMs - last.startMs >= CLICK_PAUSE_MS && s.endMs - s.startMs >= CLICK_PAUSE_MS) last.endMs = s.endMs;
      else out.push({ startMs: s.startMs, endMs: s.endMs });
    });
    return out;
  }

  // Palavras inteiras dentro de uma pausa, logo antes da volta da fala e sem pontuação ("quando existe
  // uma" em 67,9-70,8 s numa pausa até 71,0, com "alteração" atravessando a volta; "excesso" antes de
  // "de": fx-3, Roteiro 4): foram ditas na volta. Vão para lá, divididas pelo tamanho até o fim da que
  // vem depois, e marcadas estimated. Com pontuação ficam (staysBehind: ainda são da frase anterior).
  var PULL_MS = 300;
  var GAP_MS = 2500; // vão sem palavra maior que isso é fala que o Whisper perdeu inteira: não dá para saber onde

  function pullIntoSpeech(words, silences) {
    var out = words.map(function (w) {
      return Object.assign({}, w);
    });
    for (var i = 0; i < out.length; i += 1) {
      var sil = containing(silences, out[i].startMs);
      if (!sil) continue;
      var j = i;
      while (j < out.length && containing(silences, out[j].startMs) === sil && out[j].endMs <= sil.endMs && !/[.,!?;:…]["”')]?$/.test(out[j].text)) j += 1;
      if (j === i || j >= out.length) continue;
      var next = out[j];
      // a que atravessa com pontuação fecha a frase de antes: o Whisper atrasou o fim dela para dentro
      // da pausa ("funcionar bem com melhores resultados," dito antes da pausa, Roteiro 4); fica atrás.
      // Só em pausa longa: numa de respiro, a vírgula é do meio da frase ("Se você [0,78 s] é empresário,")
      if (/[.,!?;:…]["”')]?$/.test(next.text) && sil.endMs - sil.startMs >= CLICK_PAUSE_MS) {
        i = j;
        continue;
      }
      var crosses = containing(silences, next.startMs) === sil && next.endMs > sil.endMs;
      var right = next.startMs >= sil.endMs && next.startMs - sil.endMs <= PULL_MS;
      // A fala volta e segue sem palavra até a seguinte: as da pausa foram ditas nesse vão, e só nele
      // ("Lançaram" no começo de 5,7 s de pausa e a fala voltando 1,4 s antes de "pela segunda vez", 2.MOV;
      // "contar" antes de "essa história", 1.MOV: a legenda pulava a palavra que se ouvia no Reel; bug 10)
      // (um estalo de menos de CLICK_MS seguido de outra pausa ainda não é a volta: 175,43-175,52 s no 2.MOV)
      var back = sil.endMs;
      for (var s = 0; s < silences.length; s += 1) {
        if (silences[s].startMs >= back && silences[s].startMs - back < CLICK_MS && silences[s].endMs < next.startMs) back = silences[s].endMs;
      }
      var gap = next.startMs > back + PULL_MS && next.startMs - back <= GAP_MS && !pauseWithin(silences, back, next.startMs);
      var a = gap ? back : sil.endMs;
      var b = gap ? next.startMs : next.endMs;
      // sem espaço até o fim da que atravessa ("Mas" numa pausa de 8 s e "havia" com 130 ms depois da volta,
      // 2.MOV: fx-3), divide junto com até 3 palavras seguintes
      var last = gap ? j - 1 : j;
      while ((crosses || right) && b - a < (last - i + 1) * MIN_GAP_MS * 2 && last + 1 < out.length && last - j < 3) b = out[++last].endMs;
      if ((!crosses && !right && !gap) || b - a < (last - i + 1) * MIN_GAP_MS * 2) {
        i = j - 1;
        continue;
      }
      var total = 0;
      var k;
      for (k = i; k <= last; k += 1) total += String(out[k].text).length + 1;
      var at = a;
      for (k = i; k <= last; k += 1) {
        out[k].startMs = Math.round(at);
        at += ((b - a) * (String(out[k].text).length + 1)) / total;
        out[k].endMs = Math.round(at);
        out[k].estimated = true;
      }
      i = last;
    }
    return out;
  }

  /**
   * spreadCollapsed(words) -> cópia. O Whisper às vezes espreme várias palavras no mesmo instante
   * (duração zero) e joga o tempo todo na última: "Eles acreditando que teriam sorte, lançaram as"
   * em 160,36 s e "redes," de 160,36 a 165,64 s. Espalha o trecho pelas palavras, proporcional
   * ao tamanho de cada uma, e marca estimated: a legenda entra no ritmo da fala, e o corte sabe
   * que ali o tempo é palpite (core/captions/disfluency.js, timingReliable).
   */
  function spreadCollapsed(words) {
    var out = (words || []).map(function (w) {
      return Object.assign({}, w);
    });
    var i = 0;
    while (i < out.length) {
      var j = i + 1;
      while (j < out.length && out[j].startMs <= out[i].startMs) j += 1;
      if (j - i < 2) {
        i += 1;
        continue;
      }
      var start = out[i].startMs;
      var end = start;
      for (var k = i; k < j; k += 1) end = Math.max(end, out[k].endMs);
      if (j < out.length && out[j].startMs > start) end = end > start ? Math.min(end, out[j].startMs) : out[j].startMs;
      // nada para dividir: ritmo de fala, mas sem passar da palavra seguinte (fica apertado, é palpite)
      var limit = j < out.length && out[j].startMs > start ? out[j].startMs : Infinity;
      if (end - start < (j - i) * MIN_GAP_MS) end = Math.min(start + (j - i) * 250, limit);
      var weights = [];
      var total = 0;
      for (k = i; k < j; k += 1) {
        weights.push(String(out[k].text).length + 1);
        total += weights[weights.length - 1];
      }
      var at = start;
      for (k = i; k < j; k += 1) {
        var length = ((end - start) * weights[k - i]) / total;
        out[k].startMs = Math.round(at);
        out[k].endMs = Math.round(at + length);
        out[k].estimated = true;
        at += length;
      }
      i = j;
    }
    return out;
  }

  function snapWordsToSpeech(words, silences, options) {
    var opt = options || {};
    var forward = opt.forwardMs || FORWARD_MS;
    var back = opt.backMs || BACK_MS;
    var list = withoutClicks(silences || []);
    words = pullIntoSpeech(spreadCollapsed(words), list);
    var stays = staysBehind(words || [], list);
    var out = [];
    var prevStart = -Infinity;
    for (var i = 0; i < (words || []).length; i += 1) {
      var w = words[i];
      var start = w.startMs;
      var end = w.endMs;
      var inside = containing(list, start);
      var onset = -1;
      if (inside) {
        // perto da volta da fala, ou atravessando ela (o Whisper pôs "aliada" 1,1 s dentro do silêncio e
        // terminando depois dele; parada ali, o corte da pausa levava a palavra: fx-3, Roteiro 4)
        if (!stays[i] && (inside.endMs - start <= forward || end > inside.endMs)) start = onset = inside.endMs;
      } else {
        var before = endedBefore(list, prevStart, start);
        if (before && start - before.endMs <= back) start = onset = before.endMs;
      }
      start = Math.max(start, prevStart + MIN_GAP_MS);
      var tail = containing(list, end);
      if (tail && tail.startMs > start) end = tail.startMs;
      // uma pausa inteira dentro da palavra: ela acabou antes da pausa ("redes," esticada sobre 690 ms de
      // silêncio até o "mas", no 2.MOV; o corte da pausa levava a palavra: fx-3)
      var pause = pauseWithin(list, start, end);
      if (pause) end = pause.startMs;
      end = Math.max(end, start + MIN_GAP_MS);
      // o resto da palavra vai junto: sem o quiet da 2ª escuta, o Autocorte do painel cortava como
      // silêncio a frase baixa que ela recuperou (o keepQuietWords não achava nenhuma)
      var snapped = Object.assign({}, w, { startMs: Math.round(start), endMs: Math.round(end) });
      delete snapped.estimated;
      // começo encaixado na volta da fala depois de um silêncio vem do áudio, não da estimativa: dá
      // para cortar ali (frase regravada depois de uma pausa, com o tempo do Whisper espalhado)
      if (w.estimated && start !== onset) snapped.estimated = true;
      out.push(snapped);
      prevStart = start;
    }
    // 4) Fim de frase que ficou no silêncio (staysBehind): o Whisper atrasou até 1 s (fx-2, Premiere
    // real), e ali o áudio é silêncio. A fala delas acabou quando o silêncio começou: divide, da
    // última palavra fora dele até o começo dele, pelo tamanho de cada uma. Sem espaço depois da
    // anterior (o Whisper atrasou a frase inteira: "nada, ninguém conseguia pescar." uns 4 s no 2.MOV,
    // fx-3), divide desde o começo do trecho de fala antes da pausa, junto com as palavras dele.
    for (i = 1; i < out.length; ) {
      var sil = stays[i] ? containing(list, words[i].startMs) : null;
      if (!sil || containing(list, words[i - 1].startMs) === sil) {
        i += 1;
        continue;
      }
      var j = i;
      while (j < out.length && stays[j] && containing(list, words[j].startMs) === sil) j += 1;
      var a = out[i - 1].startMs, b = sil.startMs, total = 0, k, from = i - 1;
      if (b - a < (j - i + 1) * MIN_GAP_MS * 2 && sil.endMs - sil.startMs >= CLICK_PAUSE_MS) {
        var r0 = 0;
        for (k = 0; k < list.length; k += 1) if (list[k].endMs <= out[i - 1].startMs) r0 = Math.max(r0, list[k].endMs);
        if (r0 > 0) {
          a = r0;
          while (from > 0 && out[from - 1].startMs >= a) from -= 1;
        }
      }
      if (b - a >= (j - from) * MIN_GAP_MS * 2) { // as palavras de from até j - 1
        for (k = from; k < j; k += 1) total += String(out[k].text).length + 1;
        for (k = from, start = a; k < j; k += 1) {
          out[k].startMs = Math.round(start);
          start += ((b - a) * (String(out[k].text).length + 1)) / total;
          out[k].endMs = Math.round(start);
          out[k].estimated = true;
        }
      }
      i = j;
    }
    // O fim nunca passa do começo da seguinte (a regra 2 puxa a palavra depois da pausa para trás):
    // em 3 vídeos reais eram 24 palavras sobrepostas, e cortar uma delas levaria o começo da outra.
    for (i = 0; i + 1 < out.length; i += 1) if (out[i].endMs > out[i + 1].startMs) out[i].endMs = out[i + 1].startMs;
    return out;
  }

  return { snapWordsToSpeech: snapWordsToSpeech, spreadCollapsed: spreadCollapsed, SPEECH_SILENCE: SPEECH_SILENCE };
});
