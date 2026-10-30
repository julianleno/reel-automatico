/**
 * Reel na duração pedida: de um bruto longo (4 min) sai um Reel de N segundos que faz sentido.
 * Só contas, sem IA nem ffmpeg: quem chama traz as palavras da transcrição e, se tiver, os trechos
 * que a IA achou melhores (ai.js, findClips) e o que ela mandou tirar (findCuts). O painel, o app
 * sem Premiere e o site usam o mesmo plano (tests/reel-plan-core.test.js).
 *
 * words = [{ text, startMs, endMs }] em ordem. Trecho (segment) = { from, to }: índices da primeira
 * e da última palavra, inclusive. O Reel mantém a ordem do bruto.
 *
 * speechMs(words, from, to)        -> quanto o trecho dura no Reel (as pausas longas saem no corte)
 * sentences(words)                 -> [{ from, to }] frase a frase (ponto final ou pausa longa)
 * minus(segments, removed)         -> os trechos sem as palavras de removed (retake, ensaio, vício)
 * trimTo(segments, words, targetMs) -> corta no fim de frase para caber em ~targetMs
 * choose(clips, words, targetMs, removed) -> trechos do Reel a partir dos melhores trechos da IA
 * fallback(words, targetMs, removed) -> sem IA: as frases em ordem até dar a duração
 * avoid(plan, words, targetMs, removed, away) -> o plano sem as frases de away, se o resto ainda dá a duração
 * cutsOutside(segments, words, totalMs, padMs) -> [{ startMs, endMs }] o que sai do bruto
 */
(function (root) {
"use strict";

const SENTENCE_END = /[.!?…]["”')]?$/;
const LINE_PAUSE_MS = 700; // pausa que fecha uma frase mesmo sem ponto (fala sem pontuação do Whisper)
// O corte de silêncio (500 ms, folga de 120 ms de cada lado) deixa a pausa curta inteira e da longa só
// as folgas: medido no Roteiro 4, contar 400 ms por pausa dava 65 s de plano e 69,9 s de Reel.
const SHORT_PAUSE_MS = 500;
const KEPT_PAUSE_MS = 240;
const MIN_SEGMENT_MS = 1500; // trecho menor que isso picota o Reel: sai
const FIT_LOW = 0.85;
const FIT_HIGH = 1.1;
const FIT_TRIM = 1.05; // o corte final mira até 5% acima da meta
// as folgas de 150 ms em volta de cada trecho (cutsOutside): com 21 trechos, 6 s a mais no Roteiro 4
const SEGMENT_PAD_MS = 300;

function speechMs(words, from, to) {
  let ms = 0;
  for (let i = from; i <= to; i += 1) {
    ms += Math.max(0, words[i].endMs - words[i].startMs);
    if (i < to) {
      const gap = Math.max(0, words[i + 1].startMs - words[i].endMs);
      ms += gap < SHORT_PAUSE_MS ? gap : KEPT_PAUSE_MS;
    }
  }
  return ms;
}

// quanto os trechos duram no Reel, com as folgas de cada um
function totalMs(segments, words) {
  return segments.reduce((sum, s) => sum + speechMs(words, s.from, s.to) + SEGMENT_PAD_MS, 0);
}

function endsSentence(words, i) {
  const next = words[i + 1];
  return SENTENCE_END.test(String(words[i].text).trim()) || !next || next.startMs - words[i].endMs >= LINE_PAUSE_MS;
}

function sentences(words) {
  const out = [];
  let from = 0;
  for (let i = 0; i < words.length; i += 1) {
    if (endsSentence(words, i)) {
      out.push({ from, to: i });
      from = i + 1;
    }
  }
  return out;
}

// removed: [{ from, to }] em índices de palavra. Pedaço que sobra menor que MIN_SEGMENT_MS sai.
function minus(segments, removed, words) {
  const gone = new Set();
  (removed || []).forEach((r) => {
    for (let i = r.from; i <= r.to; i += 1) gone.add(i);
  });
  const out = [];
  segments.forEach((s) => {
    let start = -1;
    for (let i = s.from; i <= s.to + 1; i += 1) {
      const keep = i <= s.to && !gone.has(i);
      if (keep && start < 0) start = i;
      if (!keep && start >= 0) {
        out.push({ from: start, to: i - 1 });
        start = -1;
      }
    }
  });
  return words ? out.filter((s) => speechMs(words, s.from, s.to) >= MIN_SEGMENT_MS) : out;
}

// Trechos encostados (o fim de um e o começo do outro são palavras vizinhas) viram um só: não há corte
// entre eles, e a folga contaria duas vezes.
function merge(segments) {
  const out = [];
  segments.slice().sort((a, b) => a.from - b.from).forEach((s) => {
    const last = out[out.length - 1];
    if (last && s.from <= last.to + 1) last.to = Math.max(last.to, s.to);
    else out.push({ from: s.from, to: s.to });
  });
  return out;
}

// Mantém os trechos em ordem até ~targetMs e corta o último no fim de frase mais perto da meta (até 10%
// acima: a frase que fecha a ideia vale mais que o segundo exato). Fim de frase é a pontuação; a pausa longa
// só conta quando o trecho não tem pontuação ("sem abrir mão da saúde e da [pausa]" terminava o Reel no meio,
// Roteiro 4). Se nada cabe, fica a primeira frase inteira (melhor longo que picotado).
function trimTo(segments, words, targetMs) {
  const fits = targetMs * FIT_HIGH;
  const out = [];
  let used = 0;
  for (const s of merge(segments)) {
    const ms = speechMs(words, s.from, s.to) + SEGMENT_PAD_MS;
    if (used + ms <= targetMs * FIT_TRIM) {
      out.push(s);
      used += ms;
      continue;
    }
    // o trecho não cabe inteiro: o fim de frase mais perto da meta, sem passar de 10%
    const ends = (strong) => {
      const list = [];
      for (let i = s.from; i <= s.to; i += 1) {
        const ok = strong ? SENTENCE_END.test(String(words[i].text).trim()) || i === words.length - 1 : endsSentence(words, i);
        if (!ok) continue;
        const total = used + speechMs(words, s.from, i) + SEGMENT_PAD_MS;
        if (total > fits) break;
        if (speechMs(words, s.from, i) >= MIN_SEGMENT_MS) list.push({ i, total });
      }
      return list;
    };
    // um trecho a mais só entra se fecha uma frase ("funcionar bem," terminava o Reel na vírgula, Roteiro 4)
    const options = ends(true).length ? ends(true) : out.length ? [] : ends(false);
    const best = options.sort((a, b) => Math.abs(a.total - targetMs) - Math.abs(b.total - targetMs))[0];
    if (best) out.push({ from: s.from, to: best.i });
    break;
  }
  if (!out.length && segments.length) {
    const s = merge(segments)[0];
    let i = s.from;
    while (i < s.to && !endsSentence(words, i)) i += 1;
    out.push({ from: s.from, to: i });
  }
  return out;
}

// clips: [{ from, to, score }] (ai.js parseClips, índices das palavras do bruto). Junta os de maior
// score até chegar perto da meta, em ordem do bruto, sem o que a IA mandou tirar.
function choose(clips, words, targetMs, removed) {
  const ranked = (clips || []).slice().sort((a, b) => (b.score || 0) - (a.score || 0));
  const usable = ranked.map((c) => ({ c, segs: minus([{ from: c.from, to: c.to }], removed, words) }))
    .map((x) => Object.assign(x, { ms: totalMs(x.segs, words) }))
    .filter((x) => x.segs.length);
  if (!usable.length) return [];
  // um trecho só, inteiro, que já dá a duração: a ideia completa vale mais que juntar pedaços
  const single = usable.filter((x) => x.ms >= targetMs * FIT_LOW && x.ms <= targetMs * FIT_HIGH)[0];
  let picked;
  if (single) picked = single.segs;
  else {
    picked = [];
    let used = 0;
    for (const x of usable) {
      if (used >= targetMs * FIT_LOW) break;
      if (picked.length && used + x.ms > targetMs * FIT_HIGH) continue;
      picked = picked.concat(x.segs);
      used += x.ms;
    }
  }
  picked.sort((a, b) => a.from - b.from);
  return fill(trimTo(picked, words, targetMs), words, targetMs, removed);
}

// Frases pela pontuação só (a pausa no meio não quebra: "Se você [pausa] é empresário" é uma frase)
function strongSentences(words) {
  const out = [];
  let from = 0;
  for (let i = 0; i < words.length; i += 1) {
    if (SENTENCE_END.test(String(words[i].text).trim()) || i === words.length - 1) {
      out.push({ from, to: i });
      from = i + 1;
    }
  }
  return out;
}

// Plano curto demais (a IA achou só a abertura, "faça essas três perguntas" e acabava, Patrícia em 30 s;
// 2.MOV com 68 s de fala limpa saía com 47 s para 60): completa frase a frase com a fala limpa, primeiro
// a que fica entre os trechos (a história segue sem pulo), depois a seguinte, por último a de antes.
function fill(plan, words, targetMs, removed) {
  if (!plan.length || totalMs(plan, words) >= targetMs * 0.95) return plan;
  const units = minus(strongSentences(words), removed, words).filter((u) => !plan.some((s) => u.from <= s.to && u.to >= s.from));
  const first = plan[0].from;
  const last = plan[plan.length - 1].to;
  const order = units.filter((u) => u.from > first && u.to < last)
    .concat(units.filter((u) => u.from > last), units.filter((u) => u.to < first).reverse());
  let out = plan;
  let total = totalMs(out, words);
  for (const u of order) {
    if (total >= targetMs * 0.95) break;
    const next = merge(out.concat([u]));
    const t = totalMs(next, words);
    if (t > targetMs * FIT_HIGH) continue;
    out = next;
    total = t;
  }
  return out;
}

// Sem IA: as frases em ordem, sem o que foi marcado para sair, até dar a duração.
function fallback(words, targetMs, removed) {
  // da fala inteira, não frase a frase: "Se você [pausa] é empresário" quebrava em "Se você", curto demais, e sumia.
  // Frase longa demais para caber (o Whisper não pôs o ponto: 33 s no 1.MOV) parava o plano em 13 s para 30: as
  // frases seguintes completam, como no plano da IA
  return words.length ? fill(trimTo(minus([{ from: 0, to: words.length - 1 }], removed, words), words, targetMs), words, targetMs, removed) : [];
}

// Frases que perdem a vez (away: [{ from, to }], ex.: ditas olhando o paletó, sem olhar a câmera): saem do plano e
// outras frases limpas completam a duração. Se sem elas o Reel fica mais curto (abaixo de 85% da meta e do plano de
// antes), o plano fica como estava: é preferência, não regra (melhor a frase olhando para baixo que um Reel curto).
function avoid(plan, words, targetMs, removed, away) {
  if (!away || !away.length || !plan.length) return plan;
  const out = fill(minus(plan, away, words), words, targetMs, (removed || []).concat(away));
  return out.length && totalMs(out, words) >= Math.min(targetMs * FIT_LOW, totalMs(plan, words)) ? out : plan;
}

// O que sai do bruto: tudo fora dos trechos, com padMs de folga em volta de cada trecho (sem invadir
// a palavra de fora). totalMs é a duração do bruto.
function cutsOutside(segments, words, total, padMs) {
  const pad = padMs === undefined ? 150 : padMs;
  const out = [];
  let at = 0;
  segments.slice().sort((a, b) => a.from - b.from).forEach((s) => {
    const prevEnd = s.from > 0 ? words[s.from - 1].endMs : 0;
    const nextStart = s.to + 1 < words.length ? words[s.to + 1].startMs : total;
    const start = Math.max(prevEnd, words[s.from].startMs - pad);
    const end = Math.min(nextStart, words[s.to].endMs + pad);
    if (start > at) out.push({ startMs: at, endMs: start });
    at = Math.max(at, end);
  });
  if (at < total) out.push({ startMs: at, endMs: total });
  return out.filter((c) => c.endMs - c.startMs > 0);
}

const api = { speechMs, totalMs, sentences, strongSentences, minus, merge, trimTo, fill, choose, fallback, avoid, cutsOutside, MIN_SEGMENT_MS };
// No painel CEP (e no Electron do protótipo) o Node também define `module`; com window, o destino é o global.
if (typeof window === "undefined" && typeof module === "object" && module.exports) module.exports = api;
else root.AppLegendasReelPlan = api;
})(typeof self !== "undefined" ? self : this);
