/**
 * Palavrões na fala (português do Brasil): achar, censurar na legenda e marcar onde o bipe entra.
 *
 * isProfane(text)          -> a palavra é palavrão? (ignora maiúsculas, acento e pontuação)
 * findProfanity(words)     -> [{ index, text, startMs, endMs }] na ordem da fala
 * censorWord(text)         -> "porra," vira "p***a,": primeira e última letra, pontuação intacta
 * censorSegments(segments) -> cópia dos segmentos com os palavrões censurados (texto e palavras)
 *
 * Lista curta e de propósito: só o que é palavrão em qualquer contexto. Palavras que também são
 * inocentes ("pinto", "cacete" de pão, "porrada") ficam de fora; o editor ajusta no dicionário.
 */
(function (root, factory) {
  // No painel CEP o Node também define `module`; lá o destino é o global do painel.
  if (typeof window === "undefined" && typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    var api = factory();
    root.AppLegendasCore = root.AppLegendasCore || {};
    root.AppLegendasCore.isProfane = api.isProfane;
    root.AppLegendasCore.findProfanity = api.findProfanity;
    root.AppLegendasCore.censorWord = api.censorWord;
    root.AppLegendasCore.censorSegments = api.censorSegments;
  }
})(typeof self !== "undefined" ? self : this, function () {
  // palavra inteira
  var EXACT = [
    "porra", "porras", "caralho", "caralhos", "krl", "crl", "merda", "merdas", "puta", "putas",
    "puto", "putos", "putaria", "putarias", "foda", "fodas", "fodase", "foder", "fodeu", "fodido",
    "fodida", "fodidos", "fodidas", "fudeu", "fudido", "fudida", "buceta", "bucetas", "bosta",
    "bostas", "arrombado", "arrombada", "arrombados", "cu", "cus", "pqp", "vsf", "fdp", "tnc",
    "viado", "viados", "desgraçado", "desgraçada",
  ];
  // começo de palavra, para as variações ("merdinha", "caralhada", "fodendo")
  var STEMS = ["caralh", "merd", "fod", "bucet", "arrombad"];
  // começam igual, mas não são palavrão
  var SAFE = ["fodder", "merdeiro"];

  function bare(text) {
    return String(text || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]/g, "");
  }

  var exact = {};
  EXACT.forEach(function (w) {
    exact[bare(w)] = true;
  });

  function isProfane(text) {
    var b = bare(text);
    if (!b || SAFE.indexOf(b) >= 0) return false;
    if (exact[b]) return true;
    return STEMS.some(function (s) {
      return b.indexOf(s) === 0 && b.length >= s.length + 1;
    });
  }

  function findProfanity(words) {
    var out = [];
    (words || []).forEach(function (w, i) {
      if (isProfane(w.text)) out.push({ index: i, text: String(w.text).trim(), startMs: w.startMs, endMs: w.endMs });
    });
    return out;
  }

  function censorWord(text) {
    var s = String(text || "");
    var m = s.match(/^([^A-Za-zÀ-ÿ0-9]*)([A-Za-zÀ-ÿ0-9]+)([^A-Za-zÀ-ÿ0-9]*)$/);
    if (!m) return s;
    var core = m[2];
    if (core.length < 2) return s; // uma letra não tem o que esconder
    var hidden = core.length <= 2 ? core.charAt(0) + "*" : core.charAt(0) + new Array(core.length - 1).join("*") + core.charAt(core.length - 1);
    return m[1] + hidden + m[3];
  }

  function censorSegments(segments) {
    return (segments || []).map(function (seg) {
      if (!seg.words || !seg.words.some(function (w) { return isProfane(w.text); })) {
        if (!seg.words && isProfane(seg.text)) return Object.assign({}, seg, { text: censorWord(seg.text) });
        return seg;
      }
      var words = seg.words.map(function (w) {
        return isProfane(w.text) ? Object.assign({}, w, { text: censorWord(w.text) }) : w;
      });
      return Object.assign({}, seg, {
        words: words,
        text: words.map(function (w) { return w.text; }).join(" "),
      });
    });
  }

  return { isProfane: isProfane, findProfanity: findProfanity, censorWord: censorWord, censorSegments: censorSegments };
});
