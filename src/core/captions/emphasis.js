/**
 * Destaque inteligente e emojis automáticos, por regras e dicionário pt-BR locais.
 *
 * decorateSegments(segments, { emojis, keys }) -> segments (cópia)
 *   keys: posições (contando as palavras de todos os segmentos em ordem) escolhidas fora daqui,
 *   pela IA; sem keys valem as regras abaixo. Segmento com keyManual (escolha feita no editor de
 *   linhas) usa words[i].manualKey e ignora os dois.
 *   words[i].key = true em números ("19", "R$ 50", "30%", "mil"), nomes próprios no meio da
 *   frase e palavras de ênfase ("nunca", "grátis", "segredo").
 *   seg.emoji = um emoji do dicionário para a legenda, no máximo um a cada EMOJI_GAP_SECONDS,
 *   para não encher a tela.
 */
(function (root, factory) {
  // No painel CEP o Node também define `module`; lá o destino é o global do painel.
  if (typeof window === "undefined" && typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.AppLegendasCore = root.AppLegendasCore || {};
    root.AppLegendasCore.decorateSegments = factory().decorateSegments;
    root.AppLegendasCore.zoomMoments = factory().zoomMoments;
    root.AppLegendasCore.zoomLayers = factory().zoomLayers;
  }
})(typeof self !== "undefined" ? self : this, function () {
  var EMOJI_GAP_SECONDS = 3;

  var EMPHASIS = {};
  ("nunca sempre jamais grátis gratuito gratuita segredo segredos dica dicas importante atenção " +
    "cuidado incrível absurdo melhor pior erro erros verdade mentira urgente agora rápido fácil " +
    "simples ninguém demais proibido garantido perigo")
    .split(" ")
    .forEach(function (w) {
      EMPHASIS[w] = true;
    });
  var NUMBER_WORDS = /^(mil|milhão|milhões|bilhão|bilhões|reais|real|dólares|dólar|euros|porcento|metade|dobro|triplo)$/;

  // Radical -> emoji. A palavra casa se começa com o radical ("dinheir" pega dinheiro/dinheiros).
  var EMOJIS = [
    ["dinheir grana reais real dólar lucro pagar salári", "💰"],
    ["amor amo coraç paixão", "❤️"],
    ["fogo quente pegando", "🔥"],
    ["ideia dica", "💡"],
    ["tempo hora horas relógio minuto", "⏰"],
    ["casa lar", "🏠"],
    ["carro", "🚗"],
    ["comida comer almoço jantar fome", "🍽️"],
    ["feliz alegria", "😄"],
    ["triste chorar", "😢"],
    ["rir risada engraçad", "😂"],
    ["atenção cuidado alerta perigo", "⚠️"],
    ["sucesso vitória vencer campeã", "🏆"],
    ["crescer cresciment aumentar subir", "📈"],
    ["deus oraç igreja fé jesus maria", "🙏"],
    ["música cantar louvor", "🎵"],
    ["trabalh empresa negócio", "💼"],
    ["estud aprender livro escola", "📚"],
    ["celular telefone", "📱"],
    ["foto câmera vídeo", "📸"],
    ["viagem viajar avião", "✈️"],
    ["sol calor praia", "☀️"],
    ["chuva", "🌧️"],
    ["festa comemor", "🎉"],
    ["presente", "🎁"],
    ["força forte treino academia", "💪"],
    ["segredo", "🤫"],
    ["pergunta dúvida", "❓"],
    ["grupo família amigos", "👥"],
  ].map(function (row) {
    return { stems: row[0].split(" "), emoji: row[1] };
  });

  function bare(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/[.,!?;:"'“”…()]/g, "");
  }

  function isKey(word, prev) {
    var t = String(word.text || "");
    var b = bare(t);
    if (!b) return false;
    if (/\d/.test(b) || /^r\$/.test(b) || /%$/.test(t) || NUMBER_WORDS.test(b)) return true;
    if (EMPHASIS[b]) return true;
    // Maiúscula no meio da frase é nome próprio; no começo da frase, não.
    var sentenceStart = !prev || /[.!?…]["”']?$/.test(prev.text);
    return !sentenceStart && /^[A-ZÀ-Ý]/.test(t) && b.length > 1;
  }

  function emojiFor(words) {
    for (var i = 0; i < words.length; i += 1) {
      var b = bare(words[i].text);
      if (b.length < 3) continue;
      for (var e = 0; e < EMOJIS.length; e += 1) {
        for (var s = 0; s < EMOJIS[e].stems.length; s += 1) {
          if (b.indexOf(EMOJIS[e].stems[s]) === 0) return EMOJIS[e].emoji;
        }
      }
    }
    return "";
  }

  function decorateSegments(segments, options) {
    var emojis = !!(options && options.emojis);
    var picked = null;
    if (options && options.keys) {
      picked = {};
      for (var q = 0; q < options.keys.length; q += 1) picked[options.keys[q]] = true;
    }
    var flat = 0;
    var prev = null;
    var lastEmojiAt = -Infinity;
    var out = [];
    for (var i = 0; i < (segments || []).length; i += 1) {
      var seg = segments[i];
      var words = [];
      for (var w = 0; w < (seg.words || []).length; w += 1) {
        var word = {};
        for (var k in seg.words[w]) if (Object.prototype.hasOwnProperty.call(seg.words[w], k)) word[k] = seg.words[w][k];
        // escolhido à mão no editor de linhas > IA > regras
        word.key = seg.keyManual ? !!word.manualKey : picked ? !!picked[flat] : isKey(word, prev);
        flat += 1;
        words.push(word);
        prev = word;
      }
      var copy = {};
      for (var p in seg) if (Object.prototype.hasOwnProperty.call(seg, p)) copy[p] = seg[p];
      copy.words = words;
      copy.emoji = "";
      if (emojis && seg.inSeconds - lastEmojiAt >= EMOJI_GAP_SECONDS) {
        copy.emoji = emojiFor(words);
        if (copy.emoji) lastEmojiAt = seg.inSeconds;
      }
      out.push(copy);
    }
    return out;
  }

  /**
   * Momentos de zoom no vídeo: a primeira palavra de destaque de cada legenda, no máximo um a
   * cada gapSeconds. O zoom entra com a palavra e sai no fim da legenda (entre 0,6 e 2 s).
   * -> [{ inSeconds, outSeconds }]
   */
  function zoomMoments(segments, options) {
    var gap = Math.max(0, Number(options && options.gapSeconds) || 0);
    var out = [];
    var last = -Infinity;
    var decorated = decorateSegments(segments, { keys: options && options.keys });
    for (var i = 0; i < decorated.length; i += 1) {
      var seg = decorated[i];
      for (var w = 0; w < seg.words.length; w += 1) {
        var at = seg.words[w].inSeconds;
        // um zoom nunca começa antes do anterior terminar
        if (!seg.words[w].key || at - last < gap || (out.length && at < out[out.length - 1].outSeconds)) continue;
        out.push({ inSeconds: at, outSeconds: at + Math.min(2, Math.max(0.6, seg.outSeconds - at)) });
        last = at;
        break;
      }
    }
    return out;
  }

  /**
   * Zoom em camadas de ajuste (o jeito do Jota: Transformar com chaves suavizadas, numa camada que
   * dá para arrastar e copiar). Cada camada: { inSeconds, outSeconds, keys:[{seconds, value}] },
   * com seconds contado do começo da camada e value em % da escala.
   * smooth: uma camada por destaque, encostadas; alterna aproximar (100 -> scale em 2 s) e afastar
   *   (scale -> 100), segurando o valor até a próxima. Termina sempre afastado: se o último foi
   *   aproximar, entra uma camada de 2 s que afasta.
   * sem smooth: uma camada só no momento, entra e sai em ~0,3 s.
   * endSeconds: fim da sequência; nenhuma camada passa dele.
   */
  function zoomLayers(moments, options) {
    var scale = Number(options && options.scale) || 120;
    var end = Number(options && options.endSeconds) || Infinity;
    var smooth = !!(options && options.smooth);
    var out = [];
    function add(a, b, keys) {
      b = Math.min(b, end);
      if (b - a > 0.05) out.push({ inSeconds: a, outSeconds: b, keys: keys(b - a) });
    }
    var list = (moments || []).filter(function (m) { return m.inSeconds < end; });
    if (!smooth) {
      list.forEach(function (m) {
        add(m.inSeconds, m.outSeconds, function (d) {
          var ramp = Math.min(0.3, d / 3);
          return [{ seconds: 0, value: 100 }, { seconds: ramp, value: scale }, { seconds: d - ramp, value: scale }, { seconds: d, value: 100 }];
        });
      });
      return out;
    }
    list.forEach(function (m, i) {
      var zoomIn = i % 2 === 0;
      var next = list[i + 1];
      var b = next ? next.inSeconds : m.inSeconds + Math.max(2.5, m.outSeconds - m.inSeconds);
      add(m.inSeconds, b, function (d) {
        var ramp = Math.min(2, d);
        return zoomIn ? [{ seconds: 0, value: 100 }, { seconds: ramp, value: scale }] : [{ seconds: 0, value: scale }, { seconds: ramp, value: 100 }];
      });
    });
    if (out.length % 2 === 1) {
      var last = out[out.length - 1].outSeconds;
      add(last, last + 2, function (d) { return [{ seconds: 0, value: scale }, { seconds: d, value: 100 }]; });
    }
    return out;
  }

  return { decorateSegments: decorateSegments, zoomMoments: zoomMoments, zoomLayers: zoomLayers };
});
