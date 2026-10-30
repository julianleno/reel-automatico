/**
 * Composição: distribui as palavras de uma legenda em linhas com papéis diferentes, como nos
 * modelos de texto do CapCut ("Se gostou" pequeno, "desse" grande, "vídeo," em destaque).
 *
 * composeLines(words) -> [{ role: "lead" | "main" | "accent", from, to }]   (to exclusivo)
 *   words = textos da legenda, na ordem. A última palavra fecha a composição; a penúltima ganha
 *   linha própria quando é forte; conjunção/preposição antes do fim vai junto com ele ("e envia").
 *
 * keyLines(keys) -> mesmas linhas, pela palavra de destaque (estilo Dourado elegante): o que vem
 *   antes numa linha pequena ("lead"), o destaque grande ("main") e o resto embaixo ("tail").
 *   keys = [true/false] por palavra; sem destaque, tudo numa linha "lead".
 */
(function (root, factory) {
  // No painel CEP o Node também define `module`; lá o destino é o global do painel.
  if (typeof window === "undefined" && typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.AppLegendasCore = root.AppLegendasCore || {};
    root.AppLegendasCore.composeLines = factory().composeLines;
    root.AppLegendasCore.keyLines = factory().keyLines;
  }
})(typeof self !== "undefined" ? self : this, function () {
  var JOINS = /^(e|ou|de|da|do|das|dos|com|pra|para|no|na|nos|nas|em|que|a|o|as|os)$/;

  function bare(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/[.,!?;:"'“”…()]/g, "");
  }

  // Palavra curta ou de ligação não sustenta uma linha grande sozinha.
  function weak(text) {
    var b = bare(text);
    return b.length <= 3 || JOINS.test(b);
  }

  function composeLines(words) {
    var n = (words || []).length;
    if (!n) return [];
    if (n === 1) return [{ role: "main", from: 0, to: 1 }];

    var tailFrom = n - 1;
    while (tailFrom > 1 && JOINS.test(bare(words[tailFrom - 1]))) tailFrom -= 1;

    if (n >= 3 && tailFrom === n - 1 && !weak(words[n - 2])) {
      var lines = [];
      if (n - 2 > 0) lines.push({ role: "lead", from: 0, to: n - 2 });
      lines.push({ role: "main", from: n - 2, to: n - 1 });
      lines.push({ role: "accent", from: n - 1, to: n });
      return lines;
    }
    // Uma palavra só antes do fecho vira a principal ("Salva / e envia").
    var head = tailFrom === 1 ? "main" : "lead";
    // Sem linha do meio: apoio curto pede o fecho em destaque ("pro seu / AMIGO."); apoio de 3+
    // palavras equilibra com o fecho grande ("Me segue aí / galera!"). Medido no modelo do Jota.
    var tail = head === "main" || tailFrom <= 2 ? "accent" : "main";
    return [{ role: head, from: 0, to: tailFrom }, { role: tail, from: tailFrom, to: n }];
  }

  function keyLines(keys) {
    var n = (keys || []).length;
    if (!n) return [];
    var first = -1;
    var last = -1;
    for (var i = 0; i < n; i += 1) {
      if (!keys[i]) continue;
      if (first < 0) first = i;
      last = i;
    }
    if (first < 0) return [{ role: "lead", from: 0, to: n }];
    var lines = [];
    if (first > 0) lines.push({ role: "lead", from: 0, to: first });
    lines.push({ role: "main", from: first, to: last + 1 });
    if (last + 1 < n) lines.push({ role: "tail", from: last + 1, to: n });
    return lines;
  }

  return { composeLines: composeLines, keyLines: keyLines };
});
