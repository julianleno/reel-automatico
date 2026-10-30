/**
 * IA no app sem Premiere: a mesma função ai-destaques do painel, pelo services/ai.js (destaques,
 * Boost de cortes e texto do post), com o código de acesso. Tudo opcional: sem código nada sai do
 * PC; erro da IA nunca derruba o Reel (quem chama segue com as regras) e só a 1ª falha avisa: as
 * outras chamadas da rodada nem saem (sem rede, cada uma esperaria de novo).
 * O pipeline.js usa; tests/reel-ia.test.js confere com fetch falso.
 */
"use strict";

const TIMEOUT_MS = 120000; // o Boost pensa em cima do bruto inteiro: 30 a 60 s num bruto de 3 min

// Respostas por texto enviado: a prévia que se refaz sozinha e o "Fazer de novo" mandam as mesmas
// palavras e não pagam outra vez (os destaques o ai.js já guarda).
const memo = new Map();

/**
 * session(AI, code, o) -> { on, cuts(words, timingReliable), keys(segments), post(words) }, cada um
 * com o resultado ou null (sem código, ou a IA falhou). o: { fetch, signal (Cancelar), onFail(o que, erro) }
 */
function session(AI, code, o) {
  o = o || {};
  let down = null;
  const fetchImpl = (url, init) => {
    const signals = [AbortSignal.timeout(o.timeoutMs || TIMEOUT_MS)].concat(o.signal ? [o.signal] : []);
    return (o.fetch || fetch)(url, Object.assign({}, init, { signal: AbortSignal.any(signals) }));
  };
  const ask = async (what, key, call) => {
    if (!code || down) return null;
    if (key && memo.has(key)) return memo.get(key);
    try {
      const r = await call({ code: code }, fetchImpl);
      if (key) memo.set(key, r);
      return r;
    } catch (e) {
      down = e;
      if (o.onFail) o.onFail(what, reason(e));
      return null;
    }
  };
  return {
    on: !!code,
    // Reel na duração pedida: os trechos que ficam e os zooms (planReel) -> { segments, zooms, title, hook, source }
    reel: (words, seconds) => ask("melhores momentos", "reel|" + AI.reelText(words, seconds), (a, f) => AI.planReel(a, words, seconds, f)),
    // Boost: o que cortar do bruto (ensaio, fala fora, retake) -> trechos como os das regras
    cuts: async (words, timingReliable) => {
      const cuts = await ask("cortes", "cuts|" + AI.cutText(words), (a, f) => AI.findCuts(a, words, f));
      return cuts && cutsToRanges(cuts, words, timingReliable);
    },
    // destaques da legenda e do zoom: posições das palavras (contando todas as legendas em ordem)
    keys: (segments) => ask("destaques", "", (a, f) => AI.pickKeyWords(a, segments, f)),
    // título, legenda e hashtags do post, a partir da fala que ficou no Reel
    post: (words) => ask("texto do post", "post|" + AI.postText(words), (a, f) => AI.writePost(a, words, f)),
  };
}

// O porquê em pt-BR para o aviso (o fetch fala inglês: "Failed to fetch", "signal timed out")
function reason(e) {
  if (e && e.name === "TimeoutError") return "a IA demorou mais de 2 minutos";
  if (e && e.name === "AbortError") return "cancelado";
  if (e && e.name === "TypeError" && /fetch/i.test(e.message)) return "sem conexão com a internet";
  return e && e.message ? e.message : String(e);
}

// O aviso da 1ª falha: depois dela nenhuma chamada sai, então o post também não vem (dizer "post pelas
// regras" enganava: sem IA não há post). withPost: a rodada ia escrever o post (não é prévia).
function failMessage(why, withPost) {
  return "IA indisponível (" + why + "): o Reel sai pelas regras do app" + (withPost ? ", sem o texto do post." : ".");
}

// Cortes da IA -> trechos do bruto, como o Boost do painel (silence.js): o fim vai até a palavra
// seguinte e trecho com o tempo das palavras espremido pelo Whisper fica (cortaria fala junto).
// O vício fica com as regras: a IA marca "E" e "Como" de verdade (bug 3) e aqui ninguém confere.
function cutsToRanges(cuts, words, timingReliable) {
  return cuts.filter((c) => c.reason !== "vicio" && (!timingReliable || timingReliable(words, c.from, c.to + 1))).map((c) => {
    const next = words[c.to + 1];
    return {
      kind: c.reason,
      startMs: words[c.from].startMs,
      endMs: next ? next.startMs : words[c.to].endMs,
      text: words.slice(c.from, c.to + 1).map((w) => w.text).join(" "),
      note: c.note,
    };
  });
}

// Regras + IA, como no Boost: o que as regras acharam dentro de um corte da IA sai (ela já cobre).
function mergeCuts(rules, ai) {
  return rules.filter((c) => !ai.some((a) => c.startMs < a.endMs && c.endMs > a.startMs)).concat(ai).sort((a, b) => a.startMs - b.startMs);
}

// Reel na duração pedida: trecho do plano que começa ou termina no meio da frase vai até a borda dela se
// faltam até 3 palavras (sem entrar no trecho vizinho); senão encolhe até a frase inteira mais perto.
// 2.MOV de 60 s pela IA (21/10): "O governador gostava muito de" e o Reel pulava para "Os parlamentares
// chamaram" (o "peixe." saiu junto com o ensaio seguinte). Sem frase inteira no trecho, fica como veio.
// removed (opcional, [{from, to}] em palavras): o que já sai como retake. Trecho separado do vizinho só por ele
// continua a mesma frase: "…da concentração [e da própria performance,] e da própria performance." (Roteiro 4 em
// 60 s) perdia a tomada boa, que começa "no meio da frase", e o Reel emendava "concentração" em "Então,".
const SENTENCE_END = /[.!?…]["”')]?$/;
const REACH = 3;
function closeSentences(segments, words, removed) {
  const gone = new Set();
  (removed || []).forEach((r) => { for (let i = r.from; i <= r.to; i += 1) gone.add(i); });
  const ends = (i) => i < 0 || i >= words.length - 1 || SENTENCE_END.test(String(words[i].text).trim());
  // encostados (o fim de um e o começo do outro são vizinhos) são um trecho só
  segments = segments.reduce((out, s) => {
    const last = out[out.length - 1];
    if (last && s.from <= last.to + 1) last.to = Math.max(last.to, s.to);
    else out.push({ from: s.from, to: s.to });
    return out;
  }, []);
  return segments.map((s, k) => {
    const prev = k ? segments[k - 1].to : -1;
    const next = k + 1 < segments.length ? segments[k + 1].from : words.length;
    let { from, to } = s;
    let before = from - 1, after = to + 1;
    while (gone.has(before)) before -= 1;
    while (gone.has(after)) after += 1;
    // ou o retake logo antes começou a frase: o trecho é a tomada boa dela, do começo ("[A Câmara … queria oferecer,] a
    // Câmara de Vila Rica queria agradar…" no 2.MOV saía quando a frase de antes, olhando o paletó, deixava o plano)
    const joinedBefore = before < from - 1 && ((k > 0 && before === prev) || ends(before));
    const joinedAfter = k + 1 < segments.length && after === next && after > to + 1;
    if (!joinedBefore && !ends(from - 1)) {
      let a = from - 1;
      while (a > prev && a >= from - REACH && !ends(a - 1)) a -= 1;
      if (a > prev && a >= from - REACH) from = a;
      else {
        a = from;
        while (a <= to && !ends(a - 1)) a += 1;
        if (a <= to) from = a;
      }
    }
    if (!joinedAfter && !ends(to)) {
      let b = to + 1;
      while (b < next && b <= to + REACH && !ends(b)) b += 1;
      if (b < next && b <= to + REACH) to = b;
      else {
        b = to;
        while (b >= from && !ends(b)) b -= 1;
        if (b >= from) to = b;
      }
    }
    return from <= to ? { from, to } : s;
  });
}

// O <nome> post.txt: como se cola no Instagram e no TikTok (legenda, capítulos, hashtags), com o
// título em cima. BOM para o Bloco de Notas abrir os acentos certos.
function postFile(post, chaptersText) {
  const tags = post.hashtags.map((h) => "#" + h).join(" ");
  return "﻿" + [post.title, post.caption, chaptersText(post.chapters), tags].filter(Boolean).join("\n\n") + "\n";
}

module.exports = { session, reason, failMessage, cutsToRanges, mergeCuts, closeSentences, postFile, memo };
