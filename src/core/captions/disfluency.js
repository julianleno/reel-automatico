/**
 * Vícios de linguagem e retakes a partir das palavras da transcrição (tempo por palavra).
 * Só sugere: o painel mostra a lista desmarcada e corta apenas o que o editor marcar.
 *
 * findFillers(words, list) -> Candidate[]   ("hã", "éé"; "é" solto só depois de vírgula/pausa)
 * findRetakes(words)       -> Candidate[]   (frase recomeçada: corta as tentativas e mantém a última)
 * findOffscript(words)     -> Candidate[]   (contagem "um, dois, três" e fala sobre a gravação)
 * filterByScript(cands, roteiro) -> Candidate[]  (tira o que o roteiro mostra que é proposital)
 * Candidate = { kind: "vicio"|"repeticao"|"retake"|"ensaio"|"fora", startMs, endMs, text, keep, sure? }
 *   text = o que sai; keep = as palavras logo depois, que ficam (para conferir na lista)
 * words = [{ text, startMs, endMs }] em ordem, no tempo da sequência.
 */
(function (root, factory) {
  // No painel CEP o Node também define `module`; lá o destino é o global do painel.
  if (typeof window === "undefined" && typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.AppLegendasCore = root.AppLegendasCore || {};
    root.AppLegendasCore.findFillers = factory().findFillers;
    root.AppLegendasCore.findRetakes = factory().findRetakes;
    root.AppLegendasCore.findOffscript = factory().findOffscript;
    root.AppLegendasCore.timingReliable = factory().timingReliable;
    root.AppLegendasCore.filterByScript = factory().filterByScript;
    root.AppLegendasCore.DEFAULT_FILLERS = factory().DEFAULT_FILLERS;
    root.AppLegendasCore.retakeShare = factory().retakeShare;
  }
})(typeof self !== "undefined" ? self : this, function () {
  var DEFAULT_FILLERS = ["hã", "ãh", "ahn", "hum", "hmm", "eh", "é", "ah", "uh"];
  var RETAKE_MIN_WORDS = 3;
  var RETAKE_WINDOW_MS = 10000;
  var SENTENCE_RETAKE_WINDOW_MS = 60000; // regravar a frase inteira pode vir depois de outras
  // Começo longo repetido na mesma frase recomeça mais longe: "A Câmara de Vila Rica queria muito agradar o
  // governador [...] e queria oferecer, a Câmara de Vila Rica queria agradar..." (2.MOV, 12 s depois; o editor tirou)
  var LONG_RETAKE_WORDS = 5;
  var LONG_RETAKE_WINDOW_MS = 30000;
  var FILLER_PAUSE_MS = 250;
  var FILLER_LONG_MS = 250; // "é" arrastado: vício, não verbo
  var VERB_NEXT = /^(o|a|os|as|um|uma|uns|umas|isso|isto|aquilo|esse|essa|este|esta|aquele|aquela|que)$/;

  function norm(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/[.,!?;:"'“”‘’()…\-–—]/g, "")
      .replace(/^\s+|\s+$/g, "");
  }

  function textOf(words, from, to) {
    var out = [];
    for (var i = from; i < to && i < words.length; i += 1) out.push(String(words[i].text).replace(/^\s+|\s+$/g, ""));
    return out.join(" ");
  }

  // to = a primeira palavra depois do corte. O corte que acaba no começo dela deixa o respiro antes (o mesmo do
  // corte de silêncio), sem pegar a palavra que sai: emendado com a pausa, o retake comia a folga e o "P" de
  // "Passava" (1.MOV, 148,1 s) e o "T" de "Tem uma palavra" (2.MOV, 62,2 s)
  // E o que começa na palavra que sai pega 40 ms antes dela (mais que um quadro): o arredondamento ao quadro
  // deixava a ponta do "A" de "Acho que é bom" (2.MOV, 100,8 s); nunca pega a palavra de antes, que fica.
  var LEAD_MS = 120;
  var PREROLL_MS = 40;
  function candidate(kind, words, from, to, startMs, endMs) {
    if (to < words.length && endMs >= words[to].startMs) endMs = Math.min(endMs, Math.max(words[to - 1].endMs, words[to].startMs - LEAD_MS, startMs + 1));
    if (from > 0 && startMs <= words[from].startMs) startMs = Math.min(startMs, Math.max(words[from - 1].endMs, words[from].startMs - PREROLL_MS));
    return { kind: kind, startMs: startMs, endMs: endMs, text: textOf(words, from, to), keep: textOf(words, to, to + 4) };
  }

  /**
   * timingReliable(words, from, to) -> o tempo do trecho [from, to) dá para cortar? O Whisper às
   * vezes espreme várias palavras no mesmo instante (duração zero): "Eles acreditando que teriam
   * sorte, lançaram as" todas em 160,36 s. Aí o começo do trecho não diz onde a palavra começa de
   * verdade, e cortar pelo tempo levaria junto o que vem antes. O mesmo vale para o fim.
   */
  function timingReliable(words, from, to) {
    // grudada na anterior, ou as duas com tempo espalhado por estimativa (timing.js, spreadCollapsed)
    var collapsed = function (k) {
      return k > 0 && k < words.length && (words[k].startMs <= words[k - 1].startMs || (!!words[k].estimated && !!words[k - 1].estimated));
    };
    return !collapsed(from) && !(to < words.length && collapsed(to));
  }

  function findFillers(words, list) {
    var wanted = {};
    var i;
    for (i = 0; i < (list || DEFAULT_FILLERS).length; i += 1) wanted[norm((list || DEFAULT_FILLERS)[i])] = true;
    var out = [];
    for (i = 0; i < words.length; i += 1) {
      var raw = norm(words[i].text);
      var collapsed = raw.replace(/(.)\1+/g, "$1"); // "ééé" -> "é", "hummm" -> "hum"
      if (!raw || !(wanted[raw] || wanted[collapsed])) continue;
      var prev = words[i - 1];
      var next = words[i + 1];
      // "é" sozinho quase sempre é verbo ("É impossível"); só conta solto no meio da frase.
      if (collapsed === "é" && raw.length === 1) {
        // Depois de vírgula, "é" curto é verbo ("Sim, é isso mesmo", "ou seja, é muito difícil": 6 de
        // 6 nos brutos do cliente 2 e da cliente 1 e em 3 vídeos editados, todos com 20 a 120 ms); o
        // vício se arrasta ou para antes da palavra seguinte.
        var drawn = words[i].endMs - words[i].startMs >= FILLER_LONG_MS || (next && next.startMs - words[i].endMs >= FILLER_PAUSE_MS);
        // Depois de pausa, só se também parar depois (ou acabar ali): o verbo vem colado na palavra seguinte
        // ("corrigir [1,2 s] é essencial.", Roteiro 4: fx-3); o vício fica sozinho ("falei. [pausa] é [pausa] eu acho")
        var pausedAfter = !next || next.startMs - words[i].endMs >= FILLER_PAUSE_MS;
        // A vírgula vale no mesmo fôlego; com pausa antes, só a regra da pausa: "bem, [5,8 s] é fazer o seu
        // organismo" (Roteiro 4, a tomada boa) tinha o "é" esticado pelo encaixe na volta da fala e saía como vício
        var afterBreak = prev && (words[i].startMs - prev.endMs >= FILLER_PAUSE_MS ? pausedAfter : /,\s*$/.test(prev.text) && drawn);
        if (!afterBreak || String(words[i].text).replace(/^\s+/, "").charAt(0) !== "é") continue;
        // seguido de artigo ou "isso/que" é verbo mesmo com pausa: "não é o quanto você cobra, é o quanto de tempo
        // você perde" (bruto do Jota, música de fundo) virava "você cobra, o quanto". Cortar o verbo estraga a frase;
        // deixar um vício é só um tropeço
        if (next && VERB_NEXT.test(norm(next.text))) continue;
      }
      var start = prev ? Math.max(words[i].startMs, prev.endMs) : words[i].startMs;
      var end = next ? Math.min(words[i].endMs, next.startMs) : words[i].endMs;
      if (end > start) out.push(candidate("vicio", words, i, i + 1, start, end));
    }
    return out;
  }

  // Bloco repetido precisa de uma palavra de verdade: "de que a" se repete sem ser retake.
  function hasContentWord(n, from, length) {
    for (var k = from; k < from + length; k += 1) if (n[k].length >= 4) return true;
    return false;
  }

  function endsSentenceBefore(words, from, last) {
    for (var k = from; k < last; k += 1) if (/[.!?…]["”']?$/.test(String(words[k].text).trim())) return true;
    return false;
  }

  function findRetakes(words) {
    var n = [];
    var i;
    for (i = 0; i < words.length; i += 1) n.push(norm(words[i].text));
    var out = [];
    i = 0;
    while (i < words.length) {
      var found = null;
      var skip = 0; // anáfora reconhecida: as aberturas de dentro dela também não são retake
      for (var j = i + 1; j < words.length && words[j].startMs - words[i].startMs <= LONG_RETAKE_WINDOW_MS; j += 1) {
        var length = 0;
        while (j + length < words.length && i + length < j && n[i + length] && n[i + length] === n[j + length]) length += 1;
        if (!length) continue;
        // longe, só a frase que recomeça do começo depois de uma vírgula: no meio dela, "da equipe pedagógica é
        // especialista..." emendava duas tomadas diferentes da cliente 1 no meio da frase
        if (words[j].startMs - words[i].startMs > RETAKE_WINDOW_MS && (length < LONG_RETAKE_WORDS || !/,["”']?$/.test(String(words[j - 1].text).trim()) ||
          (i > 0 && !/[.!?…]["”']?$/.test(String(words[i - 1].text).trim())))) continue;
        var adjacent = j === i + length;
        // Frase terminada antes da repetição não é tentativa: é o roteiro repetindo de propósito
        // ("ela voltou vazia. Lançaram pela segunda vez e ela voltou vazia novamente").
        // Nem a oração completa, com vírgula, seguida da mesma abertura com outro fim: é anáfora
        // ("nós temos uma mãe, nós temos uma protetora"; "qual é esse caminho, qual é esse recurso"),
        // que os editores do cliente 2 e da cliente 1 mantiveram. A tentativa de verdade para no meio.
        // (a vírgula pode vir antes de um "mas"/"e": "o Vale da Paraíba, mas sonha em conhecer...")
        var clauseEnd = /,["”']?$/.test(String(words[j - 1].text).trim()) ||
          (j - 2 > i && /^(mas|e|ou|porém|porem)$/.test(n[j - 1]) && /,["”']?$/.test(String(words[j - 2].text).trim()));
        var anaphora = j > i + length && j - i - length <= 6 && n.slice(i + length, j).indexOf(n[i]) < 0 && clauseEnd;
        if (anaphora && length >= RETAKE_MIN_WORDS && hasContentWord(n, i, length)) {
          skip = j;
          break;
        }
        // Três vezes seguidas é de propósito: "faz tudo de novo e de novo e de novo" (bruto do Jota, 20/10) perdia um
        // "de novo e". Tentativa regravada não vem em trio colado.
        if (adjacent && length >= 2 && n[j + length] === n[i] && n[j + length + 1] === n[i + 1]) {
          skip = j + length;
          break;
        }
        if (length >= RETAKE_MIN_WORDS && hasContentWord(n, i, length) && !endsSentenceBefore(words, i, j - 1)) {
          found = { kind: "retake", j: j };
          break;
        }
        // Palavra dobrada logo em seguida ("que que", "eu eu"): gagueira ou ênfase; o editor decide.
        if (adjacent && length < RETAKE_MIN_WORDS && j === i + 1) {
          found = { kind: "repeticao", j: j };
          break;
        }
        // Duas palavras repetidas logo em seguida, com conteúdo ("Domingos Garcia Domingos Garcia"):
        // tropeço num nome ou termo; também vai para o editor decidir.
        // Com uma de conteúdo e um respiro no meio (vírgula ou pausa), também: "A Câmara, a Câmara de Vila Rica"
        // (2.MOV, o editor tirou a primeira); "pouco a pouco a gente" e "é isso é isso mesmo", sem respiro, não
        var restart = /,["”']?$/.test(String(words[j - 1].text).trim()) || words[j].startMs - words[j - 1].endMs >= FILLER_PAUSE_MS;
        if (adjacent && length === 2 && j === i + 2 && ((hasContentWord(n, i, 1) && hasContentWord(n, i + 1, 1)) || (restart && hasContentWord(n, i, 2)))) {
          found = { kind: "repeticao", j: j };
          break;
        }
      }
      if (!found) {
        i = Math.max(i + 1, skip);
        continue;
      }
      // Corta da primeira tentativa até o começo da seguinte; a última tentativa fica.
      if (timingReliable(words, i, found.j)) out.push(candidate(found.kind, words, i, found.j, words[i].startMs, words[found.j].startMs));
      i = found.j;
    }
    var whole = sentenceRetakes(words, n, out);
    return out.filter(function (c) {
      return !c.covered;
    }).concat(whole);
  }

  // Quanto das palavras de verdade (4 letras ou mais) da frase a aparece na frase b.
  function sharedContent(n, a, b) {
    var later = {};
    var k;
    for (k = b.from; k < b.to; k += 1) if (n[k].length >= 4) later[n[k]] = true;
    var content = 0;
    var shared = 0;
    for (k = a.from; k < a.to; k += 1) {
      if (n[k].length < 4) continue;
      content += 1;
      if (later[n[k]]) shared += 1;
    }
    return { content: content, ratio: content ? shared / content : 0 };
  }

  // A frase começa igual à de depois (2 palavras) e divide com ela a maioria das palavras.
  // Regravada sem o conector da frente: "Por isso, os parlamentares chamaram." e, 14 s depois, "Os parlamentares
  // chamaram Domingos Garcia" (2.MOV; o editor tirou a primeira). O resto precisa começar igual e se repetir.
  function isBareRetakeOf(n, a, b) {
    if (a.to - a.from < RETAKE_MIN_WORDS + 2 || !CONNECTORS[n[a.from] + " " + n[a.from + 1]] || n[a.from + 2] !== n[b.from] || n[a.from + 3] !== n[b.from + 1]) return false;
    var bare = sharedContent(n, { from: a.from + 2, to: a.to }, b);
    return bare.content > 0 && bare.ratio >= 0.4;
  }

  function isRetakeOf(n, a, b) {
    if (a.to - a.from < RETAKE_MIN_WORDS || n[a.from] !== n[b.from] || n[a.from + 1] !== n[b.from + 1]) return false;
    // Começo que é só um conector ("Para isso, sinta-te em primeiro lugar." e, 40 s depois, "Para
    // isso é muito importante..."): o resto é que precisa se repetir. Com começo de conteúdo
    // ("Segunda pergunta, ...", "Domingos Garcia, ..."), o começo conta, como sempre.
    if (CONNECTORS[n[a.from] + " " + n[a.from + 1]]) {
      var rest = sharedContent(n, { from: a.from + 2, to: a.to }, b);
      return rest.content > 0 && rest.ratio >= 0.4;
    }
    return sharedContent(n, a, b).ratio >= 0.4;
  }
  var CONNECTORS = {};
  ["para isso", "por isso", "além disso", "alem disso", "depois disso", "com isso", "nesse caso", "neste caso",
    "por exemplo", "ou seja", "sendo assim", "dessa forma", "desse jeito", "só que", "so que", "e aí", "e ai",
    "e depois", "e também", "e tambem", "mas também", "mas tambem", "então você", "entao voce", "então eu", "entao eu",
  ].forEach(function (c) { CONNECTORS[c] = true; });

  // Pergunta refeita com outro começo, comum no gancho ("Por que envolverem Nossa Senhora na
  // política?" e depois "O que tem a ver Nossa Senhora com política?"): a primeira sai.
  var QUESTION_WINDOW_MS = 30000;
  function isRequestion(words, n, a, b) {
    var ask = function (s) {
      return /\?["”']?$/.test(String(words[s.to - 1].text).trim());
    };
    if (!ask(a) || !ask(b) || words[b.from].startMs - words[a.from].startMs > QUESTION_WINDOW_MS) return false;
    var s = sharedContent(n, a, b);
    return s.content >= 3 && s.ratio >= 0.6;
  }

  // Frase largada no meio ("Por isso, os parlamentares chamaram...") que volta logo depois com
  // outro começo ("Os parlamentares chamaram Domingos Garcia"): a de antes sai.
  var ABANDONED_WINDOW_MS = 20000;
  function isAbandonedRetake(words, n, a, b) {
    if (!/(\.\.\.|…)["”']?$/.test(String(words[a.to - 1].text).trim())) return false;
    if (words[b.from].startMs - words[a.from].startMs > ABANDONED_WINDOW_MS) return false;
    var s = sharedContent(n, a, b);
    return s.content >= 2 && s.ratio >= 0.6;
  }

  // Frase dita inteira e regravada mais adiante (às vezes depois de outras): a anterior sai.
  function sentenceRetakes(words, n, found) {
    var sentences = [];
    var start = 0;
    for (var i = 0; i < words.length; i += 1) {
      if (i === words.length - 1 || /[.!?…]["”']?$/.test(String(words[i].text).trim())) {
        sentences.push({ from: start, to: i + 1 });
        start = i + 1;
      }
    }
    var out = [];
    for (var a = 0; a < sentences.length - 1; a += 1) {
      var s = sentences[a];
      for (var b = a + 1; b < sentences.length && words[sentences[b].from].startMs - words[s.from].startMs <= SENTENCE_RETAKE_WINDOW_MS; b += 1) {
        var other = isRetakeOf(n, s, sentences[b]) || isAbandonedRetake(words, n, s, sentences[b]) || isRequestion(words, n, s, sentences[b]);
        var bare = !other && isBareRetakeOf(n, s, sentences[b]);
        if (!other && !bare) continue;
        // os limites já com o respiro e o recuo (candidate), os mesmos dos outros retakes: com o recuo de 40 ms, o
        // retake seguinte "encostava" nesta frase e a tirava (cliente 1, "Primeira pergunta, quem da equipe...")
        var whole = candidate("retake", words, s.from, s.to, words[s.from].startMs, words[sentences[a + 1].from].startMs);
        var startMs = whole.startMs;
        var endMs = whole.endMs;
        // retake menor que cai inteiro dentro da frase fica coberto por ela ("Por isso, os
        // parlamentares chamaram..." inteira, não só "os parlamentares chamaram...")
        var overlap = function (c) {
          return c.startMs < endMs && c.endMs > startMs;
        };
        var inside = function (c) {
          return c.startMs >= startMs && c.endMs <= endMs;
        };
        // sem o conector, com a repetição colada já achada dentro: fica ela, e o "Por isso," fica na frase que segue
        if (bare && found.some(inside)) break;
        var taken = out.some(overlap) || found.some(function (c) {
          return overlap(c) && !inside(c);
        });
        if (!taken && timingReliable(words, s.from, sentences[a + 1].from)) {
          found.forEach(function (c) {
            if (inside(c)) c.covered = true;
          });
          out.push(whole);
        }
        break;
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ fora do roteiro

  var COUNT = { um: 1, uma: 1, "1": 1, dois: 2, duas: 2, "2": 2, tres: 3, "três": 3, "3": 3, quatro: 4, "4": 4 };
  var OFF_PAUSE_MS = 700; // pausa que separa uma fala solta do resto (a mesma do Boost)
  // Marcas de conversa sobre a gravação. Fortes valem em frase de até 25 palavras; fracas, que
  // também aparecem no conteúdo ("ele corta a cebola"), só em frase de até 6.
  // "deixa eu" sozinho não: "deixa eu te contar" é gancho de Reels, conteúdo.
  var META_STRONG = [
    "deixa eu ver", "deixa eu só", "deixa eu terminar", "deixa eu repetir", "deixa eu refazer",
    "deixa eu tentar", "deixa eu começar", "acho que é bom", "acho que ficou", "ficou bom",
    "ficou ruim", "vou de novo", "vamos de novo", "começar de novo", "fazer de novo",
    "gravar de novo", "falar de novo", "do começo", "errei", "tá gravando", "está gravando",
    "é um gancho", "vou ficar melhor", "peraí", "pera aí",
  ];
  // Sem dúvida nenhuma de que é sobre a gravação: o Autocorte tira sozinho (sure). As outras
  // fortes aparecem no conteúdo ("acho que ficou claro", "eu errei muito") e ficam para o editor.
  var META_SURE = [
    "deixa eu ver", "deixa eu repetir", "deixa eu refazer", "vou de novo", "vamos de novo",
    "começar de novo", "gravar de novo", "tá gravando", "está gravando",
  ];
  var META_WEAK = ["corta", "pera", "espera", "esquece", "calma", "valendo", "gravando"];

  function plain(words, from, to) {
    var out = [];
    for (var i = from; i < to; i += 1) out.push(norm(words[i].text));
    return " " + out.join(" ").replace(/\s+/g, " ") + " ";
  }

  // Contagem para começar: "um, dois, três" (ou "três, dois, um"), pelo menos dois números seguidos.
  function counting(words) {
    var out = [];
    var i = 0;
    while (i < words.length) {
      var first = COUNT[norm(words[i].text)];
      var step = first === 1 ? 1 : first >= 3 ? -1 : 0;
      var j = i + 1;
      while (step && j < words.length && COUNT[norm(words[j].text)] === COUNT[norm(words[j - 1].text)] + step) j += 1;
      if (j - i >= 2) {
        // tempo espremido (duração zero) não dá trecho para cortar (achado com 20.000 sementes)
        if (timingReliable(words, i, j) && words[j - 1].endMs > words[i].startMs) {
          out.push(candidate("ensaio", words, i, j, words[i].startMs, words[j - 1].endMs));
          out[out.length - 1].sure = true; // contar para começar nunca é conteúdo
        }
        // O resto da frase depois da contagem costuma ser o ensaio ("um, dois, três, a Câmara, a
        // Câmara, como se falava..."): vira sugestão, desmarcada, se a frase fecha logo.
        var end = j;
        while (end < words.length && end - j < 25 && !/[.!?…]["”']?$/.test(String(words[end].text).trim())) end += 1;
        if (end < words.length - 1 && end > j && end - j < 25 && timingReliable(words, j, end + 1) && words[end + 1].startMs > words[j].startMs) {
          out.push(candidate("ensaio", words, j, end + 1, words[j].startMs, words[end + 1].startMs));
        }
        i = j;
      } else {
        i += 1;
      }
    }
    return out;
  }

  /**
   * findOffscript(words) -> Candidate[] de kind "ensaio" (contagem, com sure: true) e "fora"
   * (frase curta que fala da gravação, como "acho que é bom, deixa eu só terminar essa frase").
   * Frases separadas por ponto final ou por pausa; só sugere, a fala fica desmarcada.
   */
  function findOffscript(words) {
    var out = counting(words);
    var start = 0;
    for (var i = 0; i < words.length; i += 1) {
      var last = i === words.length - 1;
      var ends = /[.!?…]["”']?$/.test(String(words[i].text).trim()) || (!last && words[i + 1].startMs - words[i].endMs >= OFF_PAUSE_MS);
      if (!last && !ends) continue;
      var from = start, to = i + 1;
      start = i + 1;
      var size = to - from;
      var text = plain(words, from, to);
      var hit = (size <= 25 && META_STRONG.some(function (m) { return text.indexOf(" " + m + " ") >= 0; })) ||
        (size <= 6 && META_WEAK.some(function (m) { return text.indexOf(" " + m + " ") >= 0; }));
      if (!hit) continue;
      if ((to < words.length ? words[to].startMs : words[to - 1].endMs) <= words[from].startMs) continue; // palavra de duração zero no fim: nada para cortar
      var said = candidate("fora", words, from, to, words[from].startMs, to < words.length ? words[to].startMs : words[to - 1].endMs);
      var taken = out.some(function (c) {
        return c.startMs < said.endMs && c.endMs > said.startMs;
      });
      if (!taken && timingReliable(words, from, to)) {
        out.push(said);
        // duas marcas fortes diferentes na mesma frase também é certeza: "esse é um gancho, depois eles veem que eu
        // vou ficar melhor" (1.MOV) e "acho que é bom, mas deixa eu só terminar essa frase" (2.MOV) ficavam no Reel
        var strong = META_STRONG.filter(function (m) { return text.indexOf(" " + m + " ") >= 0; }).length;
        if (strong >= 2 || META_SURE.some(function (m) { return text.indexOf(" " + m + " ") >= 0; })) out[out.length - 1].sure = true;
      }
    }
    return out.sort(function (a, b) {
      return a.startMs - b.startMs;
    });
  }

  // Sem acento, minúsculo, só letras e números: "Eu fui lá, ontem!" e "eu fui la ontem" batem.
  function plainText(t) {
    return String(t || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  }

  // Com o roteiro do vídeo: a frase que o roteiro repete é proposital (VSL repete a promessa e a
  // chamada), então não é repetição nem retake; e fala que está no roteiro não é ensaio nem fora
  // do vídeo. Vícios e a contagem "um, dois, três" continuam.
  function filterByScript(cands, script) {
    var s = " " + plainText(script) + " ";
    if (!s.trim()) return cands;
    return cands.filter(function (c) {
      var t = plainText(c.text);
      if (!t || c.kind === "vicio" || c.sure) return true;
      // conta ocorrências coladas também ("eu fui lá ontem eu fui lá ontem no mercado")
      var needle = " " + t + " ";
      var times = 0;
      for (var at = s.indexOf(needle); at >= 0; at = s.indexOf(needle, at + needle.length - 1)) times += 1;
      if (c.kind === "repeticao" || c.kind === "retake") return times < 2;
      if (c.kind === "ensaio" || c.kind === "fora") return times < 1;
      return true;
    });
  }

  // Quanto da fala (soma das palavras) os trechos marcados tiram, sem contar vícios: 0 a 1. Sem
  // ninguém para conferir, acima de 40% é suspeito (um bruto com duas versões do gancho perdia as duas).
  function retakeShare(words, candidates) {
    var total = 0;
    var gone = 0;
    var cuts = candidates.filter(function (c) { return c.checked && c.kind !== "vicio"; });
    words.forEach(function (w) {
      var len = w.endMs - w.startMs;
      if (!(len > 0)) return;
      total += len;
      var mid = (w.startMs + w.endMs) / 2;
      if (cuts.some(function (c) { return mid >= c.startMs && mid < c.endMs; })) gone += len;
    });
    return total ? gone / total : 0;
  }

  return { findFillers: findFillers, findRetakes: findRetakes, findOffscript: findOffscript, timingReliable: timingReliable, filterByScript: filterByScript, DEFAULT_FILLERS: DEFAULT_FILLERS, retakeShare: retakeShare };
});
