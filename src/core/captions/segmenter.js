/**
 * Transforma CaptionItem[] (saída do parser) em segmentos prontos para a timeline.
 * Aplica limpeza de texto, quebra por tamanho/nº de palavras, offset, gap mínimo e remove
 * sobreposições.
 *
 * buildSegments(items, options) -> { segments: Segment[], warnings: string[] }
 * Segment = { id, inSeconds, outSeconds, text, words: [{ text, inSeconds, outSeconds }] }
 * (com wordMarks, a palavra leva também quiet/estimated do item)
 *
 * Um CaptionItem pode trazer `words: [{ text, startMs, endMs }]` (transcrição com tempo por
 * palavra). Nesse caso a quebra usa o tempo real de cada palavra em vez de estimar.
 */
(function (root, factory) {
  // No painel CEP o Node também define `module`; lá o destino é o global do painel.
  if (typeof window === "undefined" && typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.AppLegendasCore = root.AppLegendasCore || {};
    root.AppLegendasCore.buildSegments = factory().buildSegments;
    root.AppLegendasCore.DEFAULT_OPTIONS = factory().DEFAULT_OPTIONS;
    root.AppLegendasCore.clipToRange = factory().clipToRange;
    root.AppLegendasCore.moveSegment = factory().moveSegment;
  }
})(typeof self !== "undefined" ? self : this, function () {
  var DEFAULT_OPTIONS = {
    offsetMs: 0, // desloca todas as legendas (+/-)
    gapMs: 0, // espaço mínimo entre o fim de uma e o início da próxima
    minDurationMs: 200, // legendas mais curtas são esticadas até este valor (quando há espaço)
    maxChars: 0, // 0 = não quebrar; >0 divide legendas longas em partes
    maxLines: 0, // com maxChars: maxChars vira caracteres por linha e a legenda tem até maxLines linhas
    maxDurationMs: 0, // 0 = sem limite; >0 tira da tela a legenda que sobra depois da fala
    maxWords: 0, // 0 = não quebrar; >0 limita o nº de palavras por legenda (estilo Reels/Shorts)
    stripTags: true, // remove <i>, <b>, {\an8} etc.
    joinLines: true, // troca quebras de linha por espaço
    uppercase: false,
    cutsMs: null, // cortes de câmera (ms, crescentes): nenhuma legenda atravessa um corte
    wordMarks: false, // true: as palavras saem com quiet/estimated (editor de linhas do painel: a aba Cortes precisa delas)
  };

  function merge(base, extra) {
    var out = {};
    var k;
    for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    for (k in extra || {}) {
      if (Object.prototype.hasOwnProperty.call(extra, k) && extra[k] !== undefined && extra[k] !== null) {
        out[k] = extra[k];
      }
    }
    return out;
  }

  function cleanText(text, opt) {
    var t = String(text || "");
    if (opt.stripTags) {
      t = t
        .replace(/<[^>]+>/g, "") // <i>, <b>, <font ...>
        .replace(/\{\\[^}]*\}/g, "") // {\an8} (tags estilo ASS)
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
    }
    if (opt.joinLines) {
      t = t.replace(/\s*\n\s*/g, " ");
    }
    t = t.replace(/[ \t]{2,}/g, " ").replace(/^\s+|\s+$/g, "");
    if (opt.uppercase) t = t.toUpperCase();
    return t;
  }

  // Palavras do item: com tempo real (item.words) quando existir, senão só o texto.
  function tokenize(item, text, opt) {
    var tokens = [];
    var i;
    if (item.words && item.words.length) {
      for (i = 0; i < item.words.length; i += 1) {
        var wt = cleanText(item.words[i].text, opt);
        if (wt) tokens.push({ text: wt, startMs: Number(item.words[i].startMs), endMs: Number(item.words[i].endMs), timed: true, manualKey: !!item.words[i].manualKey, quiet: !!item.words[i].quiet, estimated: !!item.words[i].estimated });
      }
      if (tokens.length) return tokens;
    }
    var parts = text.split(/\s+/);
    for (i = 0; i < parts.length; i += 1) {
      if (parts[i]) tokens.push({ text: parts[i], timed: false });
    }
    return tokens;
  }

  // Palavras que não fecham uma legenda: o leitor fica esperando o resto ("vou para a").
  var WEAK_WORDS = {};
  ("a o as os um uma uns umas de da do das dos em na no nas nos e ou que pra para pro por pelo " +
    "pela com sem se ao aos à às meu minha seu sua nosso nossa the of to and")
    .split(" ")
    .forEach(function (w) {
      WEAK_WORDS[w] = true;
    });
  var PAUSE_BREAK_MS = 300;
  var QUICK_MS = 350;

  // Tratamentos que andam junto com o nome: "professor Carlos", "dona Maria".
  var TITLES = {};
  "professor professora doutor doutora dr dra dona seu senhor senhora padre pastor irmão irmã tio tia vó vô mestre"
    .split(" ")
    .forEach(function (w) {
      TITLES[w] = true;
    });

  // "Bom" + "Jardim", "João" + "Correia", "professor" + "cliente 2", "pré-" + "treino": nome próprio
  // e palavra hifenizada não se dividem.
  function sticks(a, b) {
    if (WEAK_WORDS[bare(a.text)] || /\S-$/.test(a.text)) return true;
    if (/[.,!?;:…]$/.test(a.text) || !/^[A-ZÀ-Ý]/.test(b.text)) return false;
    return /^[A-ZÀ-Ý]/.test(a.text) || TITLES[bare(a.text)] === true;
  }

  function bare(text) {
    return String(text).toLowerCase().replace(/[.,!?;:"'“”…]/g, "");
  }

  // Agrupa palavras em legendas de até maxChars caracteres e/ou maxWords palavras, quebrando de
  // preferência em pontuação e pausas da fala e nunca terminando em artigo ou preposição.
  function groupTokens(tokens, maxChars, maxWords) {
    var groups = [];
    var current = [];
    var len = 0;
    function lengthOf(list) {
      var n = 0;
      for (var k = 0; k < list.length; k += 1) n += (k ? 1 : 0) + list[k].text.length;
      return n;
    }
    function close() {
      if (current.length) groups.push(current);
      current = [];
      len = 0;
    }
    for (var i = 0; i < tokens.length; i += 1) {
      var tok = tokens[i];
      var nextLen = current.length ? len + 1 + tok.text.length : tok.text.length;
      // Fala rápida: a legenda de maxWords palavras ficaria menos de QUICK_MS na tela (pisca); leva
      // mais uma. Medido em 5 vídeos reais com 2 por legenda.
      var quick = maxWords && current.length === maxWords && tok.timed && current[0].timed && tok.startMs - current[0].startMs < QUICK_MS;
      var full = current.length && ((maxChars && nextLen > maxChars) || (maxWords && current.length >= maxWords && !quick));
      if (full) {
        // Palavras fracas do fim (e o começo de um nome próprio) passam para a próxima legenda.
        // Se o que sobra é só palavra fraca ou uma palavrinha ("do", "É"), vai tudo junto: uma
        // palavra a mais lê melhor do que uma palavra sozinha na tela.
        var cut = current.length;
        while (cut > 0 && sticks(current[cut - 1], cut < current.length ? current[cut] : tok)) cut -= 1;
        var rest = current.slice(0, cut);
        var allWeak = rest.every(function (t) {
          return WEAK_WORDS[bare(t.text)];
        });
        if (cut < current.length && (allWeak || (rest.length === 1 && bare(rest[0].text).length <= 3))) cut = 0;
        // "vai tudo junto" aceita uma palavra a mais, não uma fila delas ("vou na na para Jota")
        if (cut === 0 && maxWords && current.length >= maxWords + 1) cut = current.length;
        if (cut) groups.push(current.slice(0, cut));
        current = current.slice(cut).concat([tok]);
        len = lengthOf(current);
      } else {
        current.push(tok);
        len = nextLen;
      }
      var next = tokens[i + 1];
      var half = (maxWords && current.length >= Math.ceil(maxWords / 2)) || (maxChars && len >= maxChars / 2);
      var sentenceEnd = /[.!?…]["”']?$/.test(tok.text);
      // vírgula com uma palavra só não fecha (com 2 por legenda, "1," ficava 100 ms na tela; fx-2)
      var clauseEnd = /[,;:]$/.test(tok.text) && half && (current.length >= 2 || !(maxWords >= 2));
      // Pausa só fecha legenda já pela metade: os tempos do Whisper têm falsos buracos, e uma
      // palavra solta na tela lê pior do que uma quebra um pouco depois da pausa.
      var pause = half && !WEAK_WORDS[bare(tok.text)] && next && tok.timed && next.timed && next.startMs - tok.endMs >= PAUSE_BREAK_MS;
      if (next && (sentenceEnd || clauseEnd || pause)) close();
    }
    close();
    // Legenda que pisca: o grupo que fica menos de MIN_READ_MS até o começo do seguinte junta com o vizinho, se
    // couber com uma palavra a mais e sem passar de um fim de frase. Fim de frase junta para trás ("vazia" +
    // "novamente.", 297 ms); o resto, para frente ("não" + "fecha.", 270 ms; "bem", 52 ms): juiz, 22/10.
    var ends = function (g) {
      return /[.!?…]["”']?$/.test(g[g.length - 1].text);
    };
    var fits = function (list) {
      return (!maxWords || list.length <= maxWords + 1) && (!maxChars || lengthOf(list) <= maxChars);
    };
    for (var g = 0; g < groups.length; g += 1) {
      var cur = groups[g];
      var until = g + 1 < groups.length ? groups[g + 1][0].startMs : cur[cur.length - 1].endMs;
      if (!cur[0].timed || !(until - cur[0].startMs < MIN_READ_MS)) continue;
      var back = g > 0 && !ends(groups[g - 1]) && fits(groups[g - 1].concat(cur)) ? g - 1 : -1;
      var ahead = g + 1 < groups.length && !ends(cur) && fits(cur.concat(groups[g + 1])) ? g : -1;
      var at = ends(cur) ? (back >= 0 ? back : ahead) : (ahead >= 0 ? ahead : back);
      if (at < 0) continue;
      groups.splice(at, 2, groups[at].concat(groups[at + 1]));
      g = at - 1; // o grupo novo também pode ser curto
    }
    return groups;
  }
  var MIN_READ_MS = 400;

  function groupText(group) {
    var words = [];
    for (var i = 0; i < group.length; i += 1) words.push(group[i].text);
    return words.join(" ");
  }

  // Início de cada grupo pelo tempo real da primeira palavra; null se os tempos não servirem.
  // Dois inícios iguais (o Whisper às vezes repete o tempo) ficam a MIN_STEP_MS um do outro em
  // vez de jogar fora os tempos da frase inteira.
  var MIN_STEP_MS = 40;
  var MIN_SEGMENT_MS = 40; // um quadro a 25 fps
  function timedStarts(item, groups) {
    var starts = [item.startMs];
    for (var i = 1; i < groups.length; i += 1) {
      var first = groups[i][0];
      if (!first.timed || isNaN(first.startMs)) return null;
      var at = Math.max(first.startMs, starts[i - 1] + MIN_STEP_MS);
      if (at >= item.endMs) return null;
      starts.push(at);
    }
    return starts;
  }

  // Sem tempo por palavra: distribui a duração proporcionalmente ao nº de caracteres.
  function proportionalStarts(item, texts) {
    var totalChars = 0;
    var i;
    for (i = 0; i < texts.length; i += 1) totalChars += texts[i].length;
    var duration = item.endMs - item.startMs;
    var starts = [item.startMs];
    for (i = 0; i < texts.length - 1; i += 1) {
      starts.push(starts[i] + Math.round((duration * texts[i].length) / totalChars));
    }
    return starts;
  }

  // Onde cada palavra começa dentro da legenda, de 0 a 1: pelo tempo real quando a
  // transcrição traz, senão proporcional ao nº de caracteres.
  function wordFractions(tokens, startMs, endMs) {
    var duration = endMs - startMs;
    var fractions = [0];
    var i;
    var timed = duration > 0;
    var step = duration > 0 ? Math.min(MIN_STEP_MS / duration, 1 / (tokens.length + 1)) : 0;
    for (i = 1; timed && i < tokens.length; i += 1) {
      var f = tokens[i].timed ? Math.max((tokens[i].startMs - startMs) / duration, fractions[i - 1] + step) : NaN;
      if (isNaN(f) || f >= 1) timed = false;
      else fractions.push(f);
    }
    if (timed) return fractions;

    var total = 0;
    for (i = 0; i < tokens.length; i += 1) total += tokens[i].text.length;
    fractions = [];
    var acc = 0;
    for (i = 0; i < tokens.length; i += 1) {
      fractions.push(acc / total);
      acc += tokens[i].text.length;
    }
    return fractions;
  }

  function splitItem(item, text, opt) {
    var maxChars = Math.max(0, Number(opt.maxChars) || 0) * Math.max(1, Number(opt.maxLines) || 1);
    var maxWords = Math.max(0, Number(opt.maxWords) || 0);
    var tokens = tokenize(item, text, opt);
    var whole = [{ startMs: item.startMs, endMs: item.endMs, text: text, tokens: tokens }];
    // Linha arrumada à mão no editor de linhas (core/captions/lines.js): fica como está.
    if (item.locked || (!maxWords && (!maxChars || text.length <= maxChars))) return whole;

    var groups = groupTokens(tokens, maxChars, maxWords);
    if (groups.length < 2) return whole;

    var texts = [];
    var i;
    for (i = 0; i < groups.length; i += 1) texts.push(groupText(groups[i]));

    var starts = timedStarts(item, groups) || proportionalStarts(item, texts);
    var out = [];
    for (i = 0; i < groups.length; i += 1) {
      out.push({
        startMs: starts[i],
        endMs: i === groups.length - 1 ? item.endMs : starts[i + 1],
        text: texts[i],
        tokens: groups[i],
      });
    }
    return out;
  }

  // Quantos cortes estão em t ou antes dele (cuts crescentes).
  function cutsBefore(cuts, t) {
    var k = 0;
    while (k < cuts.length && cuts[k] <= t) k += 1;
    return k;
  }

  // Divide o item nos cortes de câmera; cada palavra fica do lado em que está o seu meio.
  // Item sem tempo por palavra não tem onde dividir e fica inteiro.
  function splitAtCuts(item, cuts) {
    if (!cuts.length || !item.words || !item.words.length) return [item];
    var pieces = [];
    for (var i = 0; i < item.words.length; i += 1) {
      var w = item.words[i];
      var k = cutsBefore(cuts, (Number(w.startMs) + Number(w.endMs)) / 2);
      if (!pieces.length || pieces[pieces.length - 1].k !== k) pieces.push({ k: k, words: [] });
      pieces[pieces.length - 1].words.push(w);
    }
    if (pieces.length < 2) return [item];
    return pieces.map(function (p) {
      var start = p.k ? Math.max(item.startMs, cuts[p.k - 1]) : item.startMs;
      var end = p.k < cuts.length ? Math.min(item.endMs, cuts[p.k]) : item.endMs;
      var words = p.words.map(function (w) {
        return { text: w.text, startMs: Math.min(end, Math.max(start, w.startMs)), endMs: Math.min(end, Math.max(start, w.endMs)), manualKey: w.manualKey, quiet: w.quiet, estimated: w.estimated };
      });
      return { index: item.index, startMs: start, endMs: end, text: words.map(function (w) { return w.text; }).join(" "), words: words, locked: item.locked, keyManual: item.keyManual };
    });
  }

  function buildSegments(items, options) {
    var opt = merge(DEFAULT_OPTIONS, options);
    var raw = [];
    var warnings = [];
    var i;

    var cuts = (opt.cutsMs || []).slice().sort(function (a, b) {
      return a - b;
    });
    var pieces = [];
    for (i = 0; i < (items || []).length; i += 1) pieces = pieces.concat(splitAtCuts(items[i], cuts));

    for (i = 0; i < pieces.length; i += 1) {
      var item = pieces[i];
      var text = cleanText(item.text, opt);
      if (!text) {
        warnings.push("Legenda #" + item.index + " ficou vazia após a limpeza e foi ignorada.");
        continue;
      }
      var parts = splitItem(item, text, opt);
      for (var p = 0; p < parts.length; p += 1) {
        raw.push({
          sourceIndex: item.index,
          startMs: parts[p].startMs + Number(opt.offsetMs || 0),
          endMs: parts[p].endMs + Number(opt.offsetMs || 0),
          text: parts[p].text,
          tokens: parts[p].tokens,
          keyManual: !!item.keyManual,
          fractions: wordFractions(parts[p].tokens, parts[p].startMs, parts[p].endMs),
        });
      }
    }

    raw.sort(function (a, b) {
      return a.startMs - b.startMs || a.endMs - b.endMs;
    });

    var segments = [];
    var gap = Math.max(0, Number(opt.gapMs) || 0);
    var minDur = Math.max(0, Number(opt.minDurationMs) || 0);
    var maxDur = Math.max(0, Number(opt.maxDurationMs) || 0);

    for (i = 0; i < raw.length; i += 1) {
      var seg = raw[i];
      var start = Math.max(0, seg.startMs);
      var end = Math.max(start, seg.endMs);

      if (seg.startMs < 0) {
        warnings.push("Legenda #" + seg.sourceIndex + " começava antes de 0s e foi ajustada.");
      }

      if (end - start < minDur) end = start + minDur;
      // a duração mínima não leva a legenda para depois do corte
      var nextCut = cuts[cutsBefore(cuts, start)];
      if (nextCut !== undefined && end > nextCut) end = Math.max(nextCut, Math.min(end, seg.endMs));

      // não invadir a próxima legenda
      if (i + 1 < raw.length) {
        var nextStart = Math.max(0, raw[i + 1].startMs) - gap;
        if (end > nextStart) {
          if (nextStart > start) {
            end = nextStart;
          } else {
            warnings.push(
              "Legenda #" + seg.sourceIndex + " sobrepõe totalmente a seguinte; duração mínima aplicada.",
            );
            // nunca passa do começo da seguinte (sem espaço nem para um quadro, sai abaixo)
            end = Math.min(start + Math.max(40, Math.min(minDur || 40, seg.endMs - seg.startMs)), Math.max(0, raw[i + 1].startMs));
          }
        }
      }

      // menos de um quadro não se lê e, arredondada para o quadro, cai em cima da seguinte
      if (end - start < MIN_SEGMENT_MS) continue;

      // As palavras acompanham os ajustes de início/fim feitos acima.
      var words = [];
      for (var w = 0; w < seg.tokens.length; w += 1) {
        var wordStart = start + seg.fractions[w] * (end - start);
        var wordEnd = w + 1 < seg.tokens.length ? start + seg.fractions[w + 1] * (end - start) : end;
        var out = { text: seg.tokens[w].text, inSeconds: wordStart / 1000, outSeconds: wordEnd / 1000 };
        if (seg.keyManual) out.manualKey = !!seg.tokens[w].manualKey;
        if (opt.wordMarks && seg.tokens[w].quiet) out.quiet = true;
        if (opt.wordMarks && seg.tokens[w].estimated) out.estimated = true;
        words.push(out);
      }

      // Duração máxima: encurta só o fim; a última palavra fica pelo menos 300 ms na tela.
      if (maxDur && end - start > maxDur) {
        var cut = Math.max(start + maxDur, words[words.length - 1].inSeconds * 1000 + Math.max(minDur, 300));
        if (cut < end) {
          end = cut;
          for (w = 0; w < words.length; w += 1) words[w].outSeconds = Math.min(words[w].outSeconds, end / 1000);
        }
      }

      segments.push({
        id: String(segments.length + 1) + "-" + seg.sourceIndex,
        inSeconds: start / 1000,
        outSeconds: end / 1000,
        text: seg.text,
        words: words,
        keyManual: seg.keyManual || undefined, // destaque escolhido no editor de linhas
      });
    }

    return { segments: segments, warnings: warnings };
  }

  /**
   * Mantém só as legendas que começam no trecho [inSeconds, outSeconds) e corta no Out a que
   * passar dele, para trechos vizinhos com outro estilo não se sobreporem.
   */
  function clipToRange(segments, inSeconds, outSeconds) {
    var out = [];
    for (var i = 0; i < segments.length; i += 1) {
      var s = segments[i];
      if (s.inSeconds < inSeconds - 0.0005 || s.inSeconds >= outSeconds) continue;
      var end = Math.min(s.outSeconds, outSeconds);
      var words = [];
      for (var w = 0; w < (s.words || []).length; w += 1) {
        if (s.words[w].inSeconds >= end) break;
        words.push({ text: s.words[w].text, inSeconds: s.words[w].inSeconds, outSeconds: Math.min(s.words[w].outSeconds, end) });
      }
      out.push({ id: s.id, inSeconds: s.inSeconds, outSeconds: end, text: words.length ? words.map(function (x) { return x.text; }).join(" ") : s.text, words: words });
    }
    return out;
  }

  // Um segmento já colocado, levado para começar em `inSeconds` (o clipe pode ter sido movido
  // na timeline) e, com `outSeconds`, terminar ali (o clipe pode ter sido aparado). Com `text`:
  // mesmo nº de palavras mantém o tempo de cada uma; outro nº reparte o trecho por igual.
  function moveSegment(seg, inSeconds, text, outSeconds) {
    var delta = inSeconds - seg.inSeconds;
    var words = (seg.words || []).map(function (w) {
      return { text: w.text, inSeconds: w.inSeconds + delta, outSeconds: w.outSeconds + delta };
    });
    var end = outSeconds > inSeconds ? outSeconds : seg.outSeconds + delta;
    words.forEach(function (w) {
      w.inSeconds = Math.min(w.inSeconds, end);
      w.outSeconds = Math.min(w.outSeconds, end);
    });
    var out = { id: seg.id, inSeconds: inSeconds, outSeconds: end, text: seg.text, words: words };
    var parts = String(text === undefined || text === null ? "" : text).split(/\s+/).filter(Boolean);
    if (!parts.length) return out;
    out.text = parts.join(" ");
    if (parts.length === words.length) {
      parts.forEach(function (p, i) { words[i].text = p; });
      return out;
    }
    var step = (out.outSeconds - out.inSeconds) / parts.length;
    out.words = parts.map(function (p, i) {
      return { text: p, inSeconds: inSeconds + i * step, outSeconds: inSeconds + (i + 1) * step };
    });
    return out;
  }

  return { buildSegments: buildSegments, DEFAULT_OPTIONS: DEFAULT_OPTIONS, clipToRange: clipToRange, moveSegment: moveSegment };
});
