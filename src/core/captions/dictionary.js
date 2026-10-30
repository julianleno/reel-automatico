/**
 * Dicionário pessoal e buscar/substituir nas legendas.
 *
 * parseCorrections(text) -> Entry[]   uma por linha: "errado = certo" (também "->" ou "→"), ou só
 *   o nome certo, com maiúscula ("Guaratinguetá"): aí troca as grafias parecidas que o Whisper
 *   inventa ("Guaratingheta", "guaratingueta"), sem olhar acento nem maiúsculas.
 * applyCorrections(items, entries) -> { items, count }
 *   Troca palavras inteiras, sem diferenciar maiúsculas e ignorando a pontuação colada (que é
 *   mantida). Com tempo por palavra, o tempo continua certo: mesmo nº de palavras troca uma a uma;
 *   nº diferente junta o trecho numa palavra só, do começo da primeira ao fim da última.
 * Entry = { from: ["bom", "jardim"], to: "Bom Jardim" }   (nome solto: + near: true)
 */
(function (root, factory) {
  // No painel CEP o Node também define `module`; lá o destino é o global do painel.
  if (typeof window === "undefined" && typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.AppLegendasCore = root.AppLegendasCore || {};
    root.AppLegendasCore.parseCorrections = factory().parseCorrections;
    root.AppLegendasCore.applyCorrections = factory().applyCorrections;
  }
})(typeof self !== "undefined" ? self : this, function () {
  var TRAILING = /[.,!?;:…"”')\]]+$/;
  var LEADING = /^["“'(\[]+/;

  function key(text) {
    return String(text || "")
      .replace(TRAILING, "")
      .replace(LEADING, "")
      .toLowerCase();
  }

  // sem acento e minúsculo: "Guaratinguetá" e "guaratingueta" são o mesmo nome
  function plain(text) {
    return key(text).normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }

  function editDistance(a, b) {
    var prev = [];
    for (var j = 0; j <= b.length; j += 1) prev[j] = j;
    for (var i = 1; i <= a.length; i += 1) {
      var cur = [i];
      for (j = 1; j <= b.length; j += 1) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  // Palavra perto o bastante do nome (o open-clip-local faz o mesmo com difflib). Medido em 3.379
  // palavras reais: nome com menos de 8 letras só pega a grafia exata ("Escola" pegava "escolha",
  // "Pessoas" pegava "pessoal"), singular e plural não se trocam ("cliente" x "Clientes"); 1 letra
  // de diferença até 11 letras, 2 a partir de 12, e a primeira letra tem que bater.
  function near(word, name) {
    var w = plain(word);
    if (w === name) return true;
    if (name.length < 8 || w[0] !== name[0] || Math.abs(w.length - name.length) > 2) return false;
    if (w + "s" === name || name + "s" === w) return false;
    return editDistance(w, name) <= (name.length >= 12 ? 2 : 1);
  }

  function split(text) {
    return String(text || "")
      .split(/\s+/)
      .filter(function (w) {
        return w;
      });
  }

  function parseCorrections(text) {
    var entries = [];
    var lines = String(text || "").split(/\r?\n/);
    for (var i = 0; i < lines.length; i += 1) {
      var m = /^(.+?)\s*(?:=|->|→)\s*(.+)$/.exec(lines[i]);
      // pontuação em volta sai: uma linha de título como "Nomes:" não enfia os dois-pontos no texto
      var name = lines[i].replace(/^\s+|\s+$/g, "").replace(TRAILING, "").replace(LEADING, "");
      // só o nome, com maiúscula: vira correção por aproximação
      if (!m && name && name[0] !== name[0].toLowerCase()) {
        entries.push({ from: split(name).map(plain), to: name, near: true });
        continue;
      }
      if (!m) continue;
      var from = split(m[1]).map(key);
      var to = m[2].replace(/^\s+|\s+$/g, "");
      if (from.length && to) entries.push({ from: from, to: to });
    }
    return entries;
  }

  // Troca nas palavras (com ou sem tempo); devolve quantas trocas fez.
  function replaceInWords(words, entry) {
    var count = 0;
    var L = entry.from.length;
    var toWords = split(entry.to);
    var i = 0;
    while (i + L <= words.length) {
      var match = true;
      for (var k = 0; k < L && match; k += 1) {
        match = entry.near ? near(words[i + k].text, entry.from[k]) : key(words[i + k].text) === entry.from[k];
      }
      // nome já escrito certo: não conta como troca
      // (com maiúsculas: "guaratinguetá" ainda vira "Guaratinguetá")
      if (match && entry.near && words.slice(i, i + L).map(function (w) { return w.text.replace(TRAILING, "").replace(LEADING, ""); }).join(" ") === entry.to) {
        i += L;
        continue;
      }
      if (!match) {
        i += 1;
        continue;
      }
      var lead = (LEADING.exec(words[i].text) || [""])[0];
      var trail = (TRAILING.exec(words[i + L - 1].text) || [""])[0];
      if (toWords.length === L) {
        for (k = 0; k < L; k += 1) {
          words[i + k].text = (k === 0 ? lead : "") + toWords[k] + (k === L - 1 ? trail : "");
        }
        i += L;
      } else {
        var merged = { text: lead + entry.to + trail };
        if (isFinite(words[i].startMs)) {
          merged.startMs = words[i].startMs;
          merged.endMs = words[i + L - 1].endMs;
        }
        words.splice(i, L, merged);
        i += 1;
      }
      count += 1;
    }
    return count;
  }

  function applyCorrections(items, entries) {
    var count = 0;
    var out = [];
    for (var i = 0; i < (items || []).length; i += 1) {
      var item = items[i];
      var copy = {};
      for (var p in item) if (Object.prototype.hasOwnProperty.call(item, p)) copy[p] = item[p];
      var timed = item.words && item.words.length;
      var words = timed
        ? item.words.map(function (w) {
            var c = { text: w.text, startMs: w.startMs, endMs: w.endMs };
            if (w.estimated) c.estimated = true; // tempo espalhado (timing.js): o corte precisa saber
            if (w.quiet) c.quiet = true; // frase baixa da 2ª escuta: o Autocorte não a corta como silêncio
            return c;
          })
        : split(item.text).map(function (w) {
            return { text: w };
          });
      var before = count;
      for (var e = 0; e < entries.length; e += 1) count += replaceInWords(words, entries[e]);
      if (count !== before) {
        copy.text = words
          .map(function (w) {
            return w.text;
          })
          .join(" ");
        if (timed) copy.words = words;
      }
      out.push(copy);
    }
    return { items: out, count: count };
  }

  return { parseCorrections: parseCorrections, applyCorrections: applyCorrections };
});
