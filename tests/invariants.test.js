const test = require("node:test");
const assert = require("node:assert/strict");
const { followCuts } = require("../src/core/captions/transcript.js");
const { buildSegments } = require("../src/core/captions/segmenter.js");
const { buildFrames } = require("../src/core/captions/frames.js");

// npm run fuzz: FUZZ=40 multiplica as sementes (achou casos raros que as do CI não pegavam).
const FUZZ = Math.max(1, Number(process.env.FUZZ) || 1);

// Sorteio com semente: falha reproduzível (a mensagem diz o caso).
function rng(seed) {
  return () => (seed = (seed * 16807) % 2147483647) / 2147483647;
}

// Legendas com ou sem tempo por palavra, pausas variadas; cortes aleatórios (como o Autocorte).
function scenario(r) {
  const items = [];
  let t = Math.floor(r() * 500);
  const n = 3 + Math.floor(r() * 25);
  for (let i = 0; i < n; i += 1) {
    const wordsN = 1 + Math.floor(r() * 6);
    const words = [];
    let wt = t;
    for (let k = 0; k < wordsN; k += 1) {
      const d = 60 + Math.floor(r() * 500);
      words.push({ text: "p" + i + "_" + k, startMs: wt, endMs: wt + d });
      wt += d + Math.floor(r() * 80);
    }
    const item = { index: i + 1, startMs: t, endMs: wt, text: words.map((w) => w.text).join(" ") };
    if (r() < 0.6) item.words = words;
    items.push(item);
    t = wt + Math.floor(r() * 1500);
  }
  const removed = [];
  let c = Math.floor(r() * 800);
  while (c < t) {
    const len = 20 + Math.floor(r() * 1800);
    removed.push({ startMs: c, endMs: c + len });
    c += len + 200 + Math.floor(r() * 3000);
  }
  return { items, removed };
}

test("Reel na duração: trechos em ordem, sem palavra tirada, até +10% da meta; o que sai é o complemento exato", () => {
  const R = require("../src/core/video/reel-plan.js");
  for (let seed = 1; seed <= 300 * FUZZ; seed += 1) {
    const r = rng(seed * 7727);
    // frases com pontuação (às vezes sem nenhuma, como o Whisper sem ponto), palavras de 0 a 560 ms, pausas variadas
    const words = [];
    let t = Math.floor(r() * 2000);
    const punct = r() < 0.85;
    for (let s = 0, ns = 1 + Math.floor(r() * 60); s < ns; s += 1) {
      for (let k = 0, n = 1 + Math.floor(r() * 25); k < n; k += 1) {
        const d = r() < 0.04 ? 0 : 60 + Math.floor(r() * 500);
        words.push({ text: "p" + words.length + (k === n - 1 && punct ? [".", "?", "!", "…"][Math.floor(r() * 4)] : r() < 0.08 ? "," : ""), startMs: t, endMs: t + d });
        t += d + (r() < 0.1 ? 400 + Math.floor(r() * 1500) : Math.floor(r() * 120));
      }
      t += r() < 0.5 ? 200 + Math.floor(r() * 3000) : Math.floor(r() * 300);
    }
    const total = t + Math.floor(r() * 3000);
    const n = words.length;
    const removed = [];
    for (let i = 0; i < n; i += 1) if (r() < 0.04) { const to = Math.min(n - 1, i + Math.floor(r() * 12)); removed.push({ from: i, to }); i = to + 1; }
    const gone = new Set();
    removed.forEach((x) => { for (let i = x.from; i <= x.to; i += 1) gone.add(i); });
    const target = [5000, 15000, 30000, 60000, 90000][seed % 5];
    const clips = Array.from({ length: Math.floor(r() * 6) }, () => { const a = Math.floor(r() * n); return { from: a, to: Math.min(n - 1, a + Math.floor(r() * 80)), score: Math.floor(r() * 10) }; });
    [["sem IA", R.fallback(words, target, removed)], ["com IA", R.choose(clips, words, target, removed)]].forEach(([how, plan]) => {
      const where = how + ", semente " + seed + " " + JSON.stringify(plan).slice(0, 120);
      plan.forEach((s, k) => {
        assert.ok(Number.isInteger(s.from) && s.from >= 0 && s.from <= s.to && s.to < n, "trecho inválido, " + where);
        if (k) assert.ok(s.from > plan[k - 1].to, "fora de ordem ou por cima, " + where);
        for (let i = s.from; i <= s.to; i += 1) assert.ok(!gone.has(i), "trecho com palavra tirada, " + where);
      });
      // passar de 10% só no caso de propósito: a primeira frase inteira, quando nada menor cabe
      if (R.totalMs(plan, words) > target * 1.1 + 1e-6) assert.equal(plan.length, 1, "passou de 10% da meta, " + where);
      const cuts = R.cutsOutside(plan, words, total, 150);
      const inCut = (ms) => cuts.some((c) => c.startMs <= ms && ms < c.endMs);
      cuts.forEach((c, k) => {
        assert.ok(c.startMs >= 0 && c.endMs <= total && c.startMs < c.endMs, "corte fora do bruto ou vazio, " + where);
        if (k) assert.ok(c.startMs > cuts[k - 1].endMs, "cortes encostados ou por cima, " + where);
      });
      // complemento: palavra do plano nunca é cortada; palavra de fora sai inteira
      const kept = new Set();
      plan.forEach((s) => { for (let i = s.from; i <= s.to; i += 1) kept.add(i); });
      words.forEach((w, i) => {
        if (w.endMs <= w.startMs) return;
        for (const ms of [w.startMs, (w.startMs + w.endMs) / 2, w.endMs - 1]) {
          if (kept.has(i)) assert.ok(!inCut(ms), "corte dentro de palavra do plano, " + where);
          else if (ms < total) assert.ok(inCut(ms), "palavra de fora ficou, " + where);
        }
      });
    });
  }
});

test("seguir quem fala: janelas contíguas cobrindo o vídeo, troca só no fim de palavra; pessoas nunca mais que rostos num quadro", () => {
  const S = require("../src/core/video/speaker.js");
  for (let seed = 1; seed <= 600 * FUZZ; seed += 1) {
    const r = rng(seed * 5323);
    const words = [];
    let t = r() * 2;
    for (let i = 0, n = Math.floor(r() * 60); i < n; i += 1) {
      const d = r() < 0.05 ? 0 : 0.05 + r() * 0.5;
      words.push({ text: "p" + i + (r() < 0.1 ? "." : ""), start: t, end: t + d });
      t += d + (r() < 0.15 ? 0.3 + r() * 2 : r() * 0.1);
    }
    const total = t + r() * 3;
    const min = [1, 3][seed % 2];
    const wins = S.speechWindows(words, S.boundaryIndices(words), total, min);
    const where = "semente " + seed + " " + JSON.stringify(wins).slice(0, 120);
    if (words.length) {
      assert.equal(wins[0][0], 0, "não começa no 0, " + where);
      assert.equal(wins[wins.length - 1][1], total, "não vai até o fim, " + where);
    }
    wins.forEach((w, k) => {
      assert.ok(w[1] > w[0] || (wins.length === 1 && w[1] >= w[0]), "janela vazia, " + where);
      if (k) assert.equal(w[0], wins[k - 1][1], "buraco entre janelas, " + where);
      if (k < wins.length - 1) assert.ok(words.some((x) => x.end === w[1]), "troca fora do fim de uma palavra, " + where);
    });
    // rostos sorteados (2 pessoas que se mexem, às vezes um rosto falso ou um quadro sem ninguém)
    const frames = Array.from({ length: 1 + Math.floor(r() * 8) }, () => {
      const faces = [];
      if (r() < 0.9) faces.push({ x: 100 + r() * 120, y: 100, w: 80, h: 100 });
      if (r() < 0.8) faces.push({ x: 900 + r() * 120, y: 100, w: 80, h: 100 });
      if (r() < 0.1) faces.push({ x: r() * 1800, y: r() * 900, w: 40, h: 50 });
      return faces;
    });
    const tracks = S.groupTracks(frames);
    const most = Math.max(0, ...frames.map((f) => f.length));
    assert.ok(tracks.length <= most, "mais pessoas que rostos num quadro, semente " + seed);
    const seen = new Set();
    tracks.forEach((tr) => tr.faces.forEach((f) => { assert.ok(!seen.has(f), "rosto em duas pessoas, semente " + seed); seen.add(f); }));
    const plan = S.followPlan(tracks.map(() => (r() < 0.2 ? null : r())), tracks.length);
    if (plan) assert.ok(plan.length === tracks.length && plan.every((x) => typeof x === "number"), "plano com buraco, semente " + seed);
  }
});

test("mapa de tempo do corte (Reel sem Premiere): instante do bruto -> do cortado em ordem; volta somando o que saiu", () => {
  const P = require("../prototypes/reel-sem-premiere/plan.js");
  for (let seed = 1; seed <= 600 * FUZZ; seed += 1) {
    const r = rng(seed * 4271);
    const keep = [];
    let t = Math.floor(r() * 1000);
    for (let i = 0, n = Math.floor(r() * 20); i < n; i += 1) {
      const len = 1 + Math.floor(r() * 4000);
      keep.push({ startMs: t, endMs: t + len });
      t += len + 1 + Math.floor(r() * 3000);
    }
    const tm = P.timeMap(keep);
    const where = "semente " + seed + " " + JSON.stringify(keep).slice(0, 120);
    assert.equal(tm.totalMs, keep.reduce((s, k) => s + k.endMs - k.startMs, 0), "total, " + where);
    let last = -1;
    for (let ms = 0; ms <= t + 500; ms += 37) {
      const out = tm.at(ms);
      assert.ok(out >= last && out >= 0 && out <= tm.totalMs, "fora de ordem ou do vídeo, " + where);
      last = out;
      // ida e volta: dentro de um trecho que ficou, somar o que saiu antes devolve o instante do bruto
      const k = keep.findIndex((x) => x.startMs <= ms && ms <= x.endMs);
      if (k >= 0) assert.equal(out + keep[k].startMs - keep.slice(0, k).reduce((s, x) => s + x.endMs - x.startMs, 0), ms, "ida e volta, " + where);
    }
    // palavra que fica: dentro do vídeo cortado, com duração
    for (let i = 0; i < 20; i += 1) {
      const a = Math.floor(r() * (t + 500)), w = tm.word({ text: "x", startMs: a, endMs: a + Math.floor(r() * 900) });
      if (w) assert.ok(w.startMs >= 0 && w.endMs > w.startMs && w.startMs <= tm.totalMs, "palavra fora do vídeo, " + where + " " + JSON.stringify(w));
    }
  }
});

test("quem fala, batidas e nível da voz: invariantes em envelopes sorteados", () => {
  const { speakerTurns } = require("../src/core/audio/speakers.js");
  const { findBeats } = require("../src/core/audio/beats.js");
  const { levelGains } = require("../src/core/audio/silence.js");
  for (let seed = 1; seed <= 450 * FUZZ; seed += 1) {
    const r = rng(seed * 104729);
    const n = 200 + Math.floor(r() * 3000);
    const mics = 2 + Math.floor(r() * 2);
    const tracks = Array.from({ length: mics }, () => Array.from({ length: n }, () => -70 + r() * 60));
    const turns = speakerTurns(tracks, 10);
    turns.forEach((t, i) => {
      assert.ok(t.track >= 0 && t.track < mics, "trilha fora, semente " + seed);
      assert.ok(t.endMs > t.startMs, "vez vazia, semente " + seed);
      if (i) assert.equal(t.startMs, turns[i - 1].endMs, "buraco ou sobreposição entre vezes, semente " + seed);
      if (i) assert.notEqual(t.track, turns[i - 1].track, "mesma pessoa duas vezes seguidas, semente " + seed);
    });
    if (turns.length) assert.deepEqual([turns[0].startMs, turns[turns.length - 1].endMs], [0, n * 10], "não cobre a sequência, semente " + seed);

    const b = findBeats(tracks[0], 10);
    b.beats.forEach((ms, i) => {
      assert.ok(ms >= 0 && ms < n * 10, "batida fora, semente " + seed);
      if (i) assert.ok(ms > b.beats[i - 1], "batidas fora de ordem, semente " + seed);
    });

    const levels = Array.from({ length: 1 + Math.floor(r() * 12) }, () => ({ levelDb: -50 + r() * 45, peakDb: -30 + r() * 30, speechMs: Math.floor(r() * 3000) }));
    const g = levelGains(levels);
    g.gains.forEach((x, i) => {
      assert.ok(Math.abs(x) <= 9 + 1e-9, "ganho acima de 9 dB, semente " + seed);
      if (x > 0) assert.ok(levels[i].peakDb + x <= -1 + 0.05, "estoura o pico, semente " + seed);
      if (levels[i].speechMs < 300) assert.equal(x, 0, "mexeu em clipe sem fala, semente " + seed);
    });
  }
});

test("área segura: subir/descer o que o app sugere tira do topo e do rodapé; diminuir tira das laterais", () => {
  const { safeZoneIssues, liftIntoSafe, shrinkIntoSafe, SAFE_ZONES } = require("../src/core/captions/safezone.js");
  const ids = Object.keys(SAFE_ZONES);
  for (let seed = 1; seed <= 1500 * FUZZ; seed += 1) {
    const r = rng(seed * 31337);
    const w = 0.1 + r() * 0.85, h = 0.03 + r() * 0.4, top = r() * (1 - h), cx = 0.5;
    const box = { left: cx - w / 2, right: cx + w / 2, top, bottom: top + h };
    const pick = seed % 4 === 0 ? [] : [ids[seed % ids.length]];
    const lift = liftIntoSafe(box, pick);
    if (lift === null) continue; // não cabe na altura: o app avisa e não sugere
    const moved = { left: box.left, right: box.right, top: box.top + lift, bottom: box.bottom + lift };
    const vertical = safeZoneIssues(moved, pick).filter((i) => i.sides.some((s) => s === "top" || s === "bottom"));
    assert.equal(vertical.length, 0, "ainda no topo/rodapé depois de mover, semente " + seed + " " + JSON.stringify(moved));
    const scale = shrinkIntoSafe(moved, pick);
    const half = (moved.right - moved.left) / 2 * scale;
    const narrowed = { left: 0.5 - half, right: 0.5 + half, top: moved.top, bottom: moved.bottom };
    assert.equal(safeZoneIssues(narrowed, pick).length, 0, "ainda encosta depois de estreitar, semente " + seed + " " + JSON.stringify(narrowed));
  }
});

test("regras de corte: toda sugestão cai dentro da fala, com começo antes do fim", () => {
  const core = require("../src/core/captions/disfluency.js");
  const vocab = ["hã", "é", "tipo", "né", "então", "um", "dois", "três", "eu", "fui", "lá", "ontem", "vou", "falar", "isso", "corta", "de", "novo", "a", "casa", "ficou", "bom", "acho", "que"];
  for (let seed = 1; seed <= 600 * FUZZ; seed += 1) {
    const r = rng(seed * 4099);
    const words = [];
    let t = 0;
    const n = 5 + Math.floor(r() * 120);
    for (let i = 0; i < n; i += 1) {
      const text = vocab[Math.floor(r() * vocab.length)] + (r() < 0.12 ? "." : r() < 0.05 ? "?" : r() < 0.04 ? "..." : "");
      const d = r() < 0.05 ? 0 : 80 + Math.floor(r() * 400); // às vezes tempo espremido, como o Whisper
      words.push({ text, startMs: t, endMs: t + d });
      t += d + (r() < 0.15 ? 800 + Math.floor(r() * 2000) : Math.floor(r() * 60));
    }
    const all = core.findFillers(words).concat(core.findRetakes(words), core.findOffscript(words));
    all.forEach((c) => {
      assert.ok(c.startMs >= 0 && c.endMs <= t + 1 && c.startMs < c.endMs, "sugestão fora ou vazia, semente " + seed + " " + JSON.stringify(c).slice(0, 160));
      // a palavra que fica depois do corte nunca perde o começo (o "P" de "Passava", 1.MOV)
      const next = words.find((w) => (w.startMs + w.endMs) / 2 >= c.endMs && w.endMs > w.startMs);
      assert.ok(!next || next.startMs >= c.endMs, "corte pega o começo da palavra que fica, semente " + seed + " " + JSON.stringify(c).slice(0, 160));
      const prev = words.filter((w) => (w.startMs + w.endMs) / 2 < c.startMs && w.endMs > w.startMs).pop();
      assert.ok(!prev || prev.endMs <= c.startMs, "corte pega o fim da palavra de antes, semente " + seed + " " + JSON.stringify(c).slice(0, 160));
    });
  }
});

test("SRT ida e volta, censura, tempos espremidos e dividir/juntar linhas", () => {
  const { formatSrt, parseSrt } = require("../src/core/captions/srt.js");
  const { censorWord } = require("../src/core/captions/profanity.js");
  const { spreadCollapsed, snapWordsToSpeech } = require("../src/core/captions/timing.js");
  const lines = require("../src/core/captions/lines.js");
  const letters = "abcdefghijklmnopqrstuvwxyzáéíóúãõçàêô";
  const word = (r) => Array.from({ length: 1 + Math.floor(r() * 9) }, () => letters[Math.floor(r() * letters.length)]).join("");
  for (let seed = 1; seed <= 600 * FUZZ; seed += 1) {
    const r = rng(seed * 2311);
    // SRT: o que sai volta igual (texto e tempo em ms)
    const items = [];
    let t = 0;
    for (let i = 0; i < 1 + Math.floor(r() * 15); i += 1) {
      const d = 1 + Math.floor(r() * 4000);
      items.push({ startMs: t, endMs: t + d, text: Array.from({ length: 1 + Math.floor(r() * 6) }, () => word(r)).join(" ") });
      t += d + Math.floor(r() * 2000);
    }
    const back = parseSrt(formatSrt(items)).items;
    assert.deepEqual(back.map((i) => [i.startMs, i.endMs, i.text]), items.map((i) => [i.startMs, i.endMs, i.text]), "SRT ida e volta, semente " + seed);
    // censura: mesmo tamanho, primeira letra visível, pontuação no lugar
    const w = word(r) + (r() < 0.3 ? "!" : "");
    const c = censorWord(w);
    assert.equal(c.length, w.length, "censura mudou o tamanho, semente " + seed);
    assert.equal(c[0], w[0], "censura escondeu a primeira letra, semente " + seed);
    // tempos: espalhar e assentar na fala mantém a ordem e o trecho
    const ws = [];
    let wt = 0;
    for (let i = 0; i < 2 + Math.floor(r() * 30); i += 1) {
      const d = r() < 0.3 ? 0 : Math.floor(r() * 500);
      ws.push({ text: word(r), startMs: wt, endMs: wt + d });
      wt += d + (r() < 0.3 ? 0 : Math.floor(r() * 300));
    }
    const silences = [];
    for (let s = Math.floor(r() * 500); s < wt; s += 400 + Math.floor(r() * 1500)) silences.push({ startMs: s, endMs: s + 150 + Math.floor(r() * 600) });
    [spreadCollapsed(ws), snapWordsToSpeech(ws, silences)].forEach((out, k) => {
      assert.equal(out.length, ws.length, "palavras sumiram, semente " + seed);
      out.forEach((x, i) => {
        assert.ok(x.endMs >= x.startMs, (k ? "assentar" : "espalhar") + ": fim antes do começo, semente " + seed);
        if (i) assert.ok(x.startMs >= out[i - 1].startMs, (k ? "assentar" : "espalhar") + ": fora de ordem, semente " + seed);
      });
    });
    // linhas: dividir e juntar de volta dá o mesmo texto
    const lw = Array.from({ length: 2 + Math.floor(r() * 8) }, (_, i) => ({ text: word(r), inSeconds: i * 0.4, outSeconds: i * 0.4 + 0.35 }));
    const line = { id: "1", inSeconds: 0, outSeconds: lw[lw.length - 1].outSeconds, words: lw, text: lw.map((x) => x.text).join(" ") };
    const at = 1 + Math.floor(r() * (lw.length - 1));
    const parts = lines.splitLine(line, at);
    assert.ok(parts && parts.length === 2, "não dividiu, semente " + seed);
    const joined = lines.mergeLines(parts[0], parts[1]);
    assert.equal(joined.words.map((x) => x.text).join(" "), line.text, "dividir e juntar mudou o texto, semente " + seed);
    assert.ok(parts[0].outSeconds <= parts[1].inSeconds + 1e-9, "metades se sobrepõem, semente " + seed);
  }
});

test("segmentação: nenhuma palavra some nem repete, limites de linha respeitados; destaque e composição cobrem tudo", () => {
  const { decorateSegments } = require("../src/core/captions/emphasis.js");
  const { composeLines, keyLines } = require("../src/core/captions/compose.js");
  const vocab = ["eu", "vou", "te", "mostrar", "como", "ganhei", "500", "reais", "em", "uma", "semana", "com", "o", "Jota", "na", "praia", "de", "Copacabana", "isso", "muda", "tudo", "para", "quem", "vende", "doce", "anticonstitucionalissimamente"];
  for (let seed = 1; seed <= 750 * FUZZ; seed += 1) {
    const r = rng(seed * 6007);
    const items = [];
    let t = 0;
    for (let i = 0; i < 1 + Math.floor(r() * 12); i += 1) {
      const words = [];
      let wt = t;
      for (let k = 0; k < 1 + Math.floor(r() * 14); k += 1) {
        const d = 80 + Math.floor(r() * 400);
        words.push({ text: vocab[Math.floor(r() * vocab.length)] + (r() < 0.1 ? "," : r() < 0.06 ? "." : ""), startMs: wt, endMs: wt + d });
        wt += d + (r() < 0.1 ? 600 : 40);
      }
      items.push({ index: i + 1, startMs: t, endMs: wt, text: words.map((w) => w.text).join(" "), words });
      t = wt + 300 + Math.floor(r() * 900);
    }
    const maxChars = [0, 12, 20, 32][seed % 4], maxLines = [0, 1, 2][seed % 3], maxWords = [0, 2, 3, 4][seed % 4];
    const segs = buildSegments(items, { maxChars, maxLines, maxWords }).segments;
    const want = items.flatMap((i) => i.words.map((w) => w.text)).join(" ");
    const got = segs.flatMap((s) => s.words.map((w) => w.text)).join(" ");
    assert.equal(got, want, "palavras perdidas ou repetidas, semente " + seed + " (maxChars " + maxChars + ", maxLines " + maxLines + ", maxWords " + maxWords + ")");
    // Uma palavra a mais é de propósito (palavra fraca não fica sozinha na tela); mais que isso, não.
    // Letras podem passar: nome próprio não se divide e palavra longa não cabe.
    segs.forEach((s) => {
      if (maxWords) assert.ok(s.words.length <= maxWords + 1, "mais de uma palavra além do limite, semente " + seed + ": " + s.text);
    });
    const deco = decorateSegments(segs, { emojis: true });
    assert.deepEqual(deco.map((s) => s.words.map((w) => w.text).join(" ")), segs.map((s) => s.words.map((w) => w.text).join(" ")), "o destaque mudou o texto, semente " + seed);
    deco.forEach((s) => {
      const texts = s.words.map((w) => w.text);
      [composeLines(texts), keyLines(s.words.map((w) => !!w.key))].forEach((roles) => {
        if (!texts.length) return;
        let next = 0;
        roles.forEach((role) => { assert.equal(role.from, next, "composição pulou palavra, semente " + seed); next = role.to; });
        assert.equal(next, texts.length, "composição não cobriu tudo, semente " + seed + ": " + texts.join(" "));
      });
    });
  }
});

test("dicionário, frases da transcrição, trecho In/Out e .prfpset estragado", () => {
  const { parseCorrections, applyCorrections } = require("../src/core/captions/dictionary.js");
  const { itemsFromWords } = require("../src/core/captions/transcript.js");
  const { clipToRange } = require("../src/core/captions/segmenter.js");
  const { parsePrfpset } = require("../src/core/effects/prfpset.js");
  const odd = ["(", ")", "[", "*", "+", "?", ".", "$", "^", "\\", "|", "{", "é", "ç", "a", "b", "jota", "Jota", " "];
  for (let seed = 1; seed <= 600 * FUZZ; seed += 1) {
    const r = rng(seed * 9973);
    const pick = () => odd[Math.floor(r() * odd.length)];
    const words = [];
    let t = 0;
    for (let i = 0; i < 1 + Math.floor(r() * 40); i += 1) {
      const text = Array.from({ length: 1 + Math.floor(r() * 4) }, pick).join("").trim() || "x";
      const d = 50 + Math.floor(r() * 400);
      words.push({ text: text + (r() < 0.1 ? "." : ""), startMs: t, endMs: t + d });
      t += d + (r() < 0.2 ? 900 : 30);
    }
    // frases: todas as palavras, na ordem, uma vez
    const items = itemsFromWords(words);
    assert.equal(items.flatMap((i) => i.words.map((w) => w.text)).join(" "), words.map((w) => w.text).join(" "), "frases perderam palavras, semente " + seed);
    // dicionário com caracteres de regex: não quebra e não mexe nos tempos
    // + nome solto (correção por aproximação) a uma letra de "jotajota", que os sorteios formam
    const dict = parseCorrections(Array.from({ length: 3 }, () => pick() + pick() + " = " + pick() + "Z").join("\n") + "\njota = Jota\n" + ["Jotajotb", "Jotaéjota", "Bjotaj"][seed % 3]);
    const fixed = applyCorrections(items, dict);
    assert.equal(fixed.items.length, items.length, "dicionário mudou o número de frases, semente " + seed);
    fixed.items.forEach((it, i) => assert.deepEqual([it.startMs, it.endMs], [items[i].startMs, items[i].endMs], "dicionário mexeu no tempo, semente " + seed));
    // In/Out: tudo que sai começa e termina dentro do trecho
    const segs = buildSegments(items, {}).segments;
    const a = r() * t / 1000, b = a + r() * 10;
    clipToRange(segs, a, b).forEach((s) => {
      assert.ok(s.inSeconds >= a - 0.001 && s.outSeconds <= b + 0.001 && s.outSeconds > s.inSeconds, "fora do In/Out, semente " + seed);
    });
    // .prfpset estragado: erro claro ou leitura, nunca outra exceção
    const xml = '<PremiereData><FilterPresetItem ObjectID="6"><FilterPresets><FilterPreset Index="0" ObjectRef="7"/></FilterPresets></FilterPresetItem>' +
      (r() < 0.5 ? '<FilterPreset ObjectID="7"><FilterMatchName>X</FilterMatchName><Component ObjectRef="' + (r() < 0.5 ? 8 : 99) + '"/><Type>' + Math.floor(r() * 4) + "</Type></FilterPreset>" : "") +
      (r() < 0.5 ? '<VideoFilterComponent ObjectID="8"><Component><DisplayName>Y</DisplayName><Params><Param Index="0" ObjectRef="' + (r() < 0.5 ? 9 : 77) + '"/></Params></Component></VideoFilterComponent>' : "") +
      (r() < 0.5 ? '<VideoComponentParam ObjectID="9"><Keyframes>' + (r() < 0.5 ? "abc;;," : "914457600000000,1.,5;") + "</Keyframes><StartKeyframe>x</StartKeyframe></VideoComponentParam>" : "") + "</PremiereData>";
    try {
      parsePrfpset(xml.slice(0, r() < 0.2 ? Math.floor(r() * xml.length) : xml.length));
    } catch (e) {
      assert.match(e.message, /predefinição de efeitos/, "erro inesperado no .prfpset, semente " + seed + ": " + e.message);
    }
  }
});

test("respostas da IA estragadas: erro claro ou resultado válido, nunca outra exceção", () => {
  const ai = require("../src/adobe/cep/js/services/ai.js");
  const friendly = /fora do formato|sem texto|recusou|cortada/;
  const pieces = ["null", "[]", "5", '"x"', "{}", '{"cuts":null}', '{"cuts":[null,{"from":"1","to":2,"reason":"vicio"},{"from":3,"to":1,"reason":"retake"},{"from":0,"to":2,"reason":"fora","note":5}]}',
    '{"picks":[{"sentence":0,"word":1},{"word":-1},null,{"sentence":"0","word":0}]}', '{"clips":[{"from":0,"to":9,"title":7,"score":"a"},null]}',
    '{"title":1,"caption":"c","hashtags":"#a","chapters":"x"}', "{nada", '{"title":"t","caption":"c","hashtags":[null,"#A b",""],"chapters":[{"at":"1"},{"at":3.5,"title":""}]}'];
  const words = Array.from({ length: 30 }, (_, i) => ({ text: "p" + i + (i % 7 === 6 ? "." : ""), startMs: i * 500, endMs: i * 500 + 400 }));
  const numbered = ai.numberedText([{ words }]);
  for (let seed = 1; seed <= 360 * FUZZ; seed += 1) {
    const r = rng(seed * 1223);
    const text = pieces[Math.floor(r() * pieces.length)];
    const response = r() < 0.1 ? { stop_reason: ["refusal", "max_tokens"][seed % 2], content: [] } : r() < 0.1 ? { content: [] } : { content: [{ type: "text", text }] };
    const tries = [
      () => { const k = ai.parseKeys(response, numbered); assert.ok(k.every((w) => w >= 0 && w < numbered.count)); },
      () => { const c = ai.parseCuts(response, words.length); assert.ok(c.every((x) => x.from <= x.to && x.to < words.length)); },
      () => { const c = ai.parseClips(response, words); assert.ok(c.every((x) => x.from <= x.to)); },
      () => { const p = ai.parsePost(response); assert.ok(typeof p.title === "string" && Array.isArray(p.hashtags) && Array.isArray(p.chapters)); },
    ];
    tries.forEach((run, k) => {
      try { run(); } catch (e) {
        assert.match(e.message, friendly, "parser " + k + " deu erro feio com " + text + " (semente " + seed + "): " + e.message);
      }
    });
  }
});

test("depois de qualquer corte: legendas em ordem, sem sobrepor e com pelo menos um quadro; quadros idem", () => {
  for (let seed = 1; seed <= 900 * FUZZ; seed += 1) {
    const r = rng(seed * 7919);
    const { items, removed } = scenario(r);
    const cut = followCuts(items, removed.map((x) => (r() < 0.5 ? { ...x, silence: true } : x))); // silêncio: palavras dentro voltam para a peça vizinha
    const opts = { minDurationMs: [0, 200, 500][seed % 3], gapMs: [0, 40][seed % 2], maxWords: [0, 2, 3][seed % 3], maxDurationMs: [0, 3000][seed % 2] };
    const segs = buildSegments(cut, opts).segments;
    for (let i = 0; i < segs.length; i += 1) {
      const s = segs[i];
      const where = "semente " + seed + ", legenda " + i + " " + JSON.stringify(s).slice(0, 120);
      assert.ok(s.outSeconds - s.inSeconds >= 0.04 - 1e-9, "curta demais: " + where);
      if (i) assert.ok(s.inSeconds >= segs[i - 1].outSeconds - 1e-9, "sobrepõe a anterior: " + where);
    }
    const frames = buildFrames(segs, { highlight: seed % 2 === 0 });
    for (let i = 1; i < frames.length; i += 1) {
      assert.ok(frames[i].inSeconds >= frames[i - 1].outSeconds - 1e-9, "quadros sobrepostos, semente " + seed + ", quadro " + i);
      assert.ok(frames[i].outSeconds > frames[i].inSeconds, "quadro vazio, semente " + seed + ", quadro " + i);
    }
  }
});

test("palavras do Whisper: aspas, pontuação e palavra longa nunca deixam texto vazio, tempo invertido ou fora de ordem", () => {
  const { wordsFromWhisperJson } = require("../src/adobe/cep/js/services/transcribe.js");
  const pieces = ["oi", "\"Hoje", "vou", "falar.\"", "\"a\"", "pré-", "treino", "!!!!!!", "bonitos!!!!!!", "“certo”.", "[MÚSICA]", "\"", ".", "é", "isso?\""];
  for (let seed = 1; seed <= 1500 * FUZZ; seed += 1) {
    const r = rng(seed * 6007);
    const list = [];
    let t = Math.floor(r() * 1000);
    const n = 1 + Math.floor(r() * 40);
    for (let i = 0; i < n; i += 1) {
      const text = pieces[Math.floor(r() * pieces.length)];
      const d = r() < 0.1 ? 0 : r() < 0.05 ? 3000 + Math.floor(r() * 30000) : 50 + Math.floor(r() * 600);
      list.push({ text: (r() < 0.9 ? " " : "") + text, offsets: { from: t, to: t + d } });
      t += r() < 0.2 ? 0 : d + Math.floor(r() * 400);
    }
    const words = wordsFromWhisperJson({ transcription: list });
    const where = "semente " + seed + " " + JSON.stringify(words).slice(0, 200);
    words.forEach((w, k) => {
      assert.ok(w.text.length > 0 && w.endMs >= w.startMs, "palavra vazia ou tempo invertido, " + where);
      if (k) assert.ok(w.startMs >= words[k - 1].startMs, "fora de ordem, " + where);
      const squeezed = k > 0 && words[k - 1].startMs >= w.startMs;
      assert.ok(squeezed || w.endMs - w.startMs <= 3000, "palavra de mais de 3 s, " + where);
    });
  }
});

test("silêncios e plano de corte: em ordem, sem sobrepor, dentro do áudio, sem lasca entre cortes", () => {
  const { detectSilences, cutPlan } = require("../src/core/audio/silence.js");
  for (let seed = 1; seed <= 600 * FUZZ; seed += 1) {
    const r = rng(seed * 7151);
    const db = [];
    const n = 50 + Math.floor(r() * 3000);
    let level = -20;
    for (let i = 0; i < n; i += 1) {
      if (r() < 0.03) level = [-75, -60, -35, -30, -22, -16, -100][Math.floor(r() * 7)];
      db.push(level + (r() - 0.5) * 6);
    }
    const opts = { quietSpeechDb: [0, 10, 12][seed % 3], paddingMs: [0, 120][seed % 2], minSilenceMs: [150, 500][seed % 2] };
    const sil = detectSilences(db, 10, opts).silences;
    const where = "semente " + seed + " " + JSON.stringify(sil).slice(0, 160);
    sil.forEach((x, k) => {
      assert.ok(x.startMs >= 0 && x.endMs <= n * 10 && x.startMs < x.endMs, "silêncio fora ou vazio, " + where);
      if (k) assert.ok(x.startMs >= sil[k - 1].endMs, "silêncios sobrepostos, " + where);
    });
    const fps = [24, 25, 30][seed % 3];
    const plan = cutPlan(sil.map((x) => ({ startSeconds: x.startMs / 1000, endSeconds: x.endMs / 1000 })), fps);
    const ranges = plan.ranges.slice().reverse();
    let total = 0;
    ranges.forEach((x, k) => {
      total += x.endFrame - x.startFrame;
      assert.ok(x.endFrame > x.startFrame, "corte vazio, " + where);
      if (k) assert.ok(x.startFrame - ranges[k - 1].endFrame >= Math.round(0.2 * fps), "lasca entre cortes, " + where);
    });
    assert.equal(total, plan.frames, "total de quadros, " + where);
  }
});

test("ajuste pelo áudio: palavras em ordem, com duração e sem passar da seguinte, com silêncios sorteados", () => {
  const { snapWordsToSpeech } = require("../src/core/captions/timing.js");
  const texts = ["oi", "então", "mercado", "da", "esquina.", "mim,", "vende", "é", "isso?"];
  for (let seed = 1; seed <= 900 * FUZZ; seed += 1) {
    const r = rng(seed * 9173);
    const words = [];
    let t = Math.floor(r() * 500);
    const n = 1 + Math.floor(r() * 60);
    for (let i = 0; i < n; i += 1) {
      const d = r() < 0.1 ? 0 : 40 + Math.floor(r() * 900);
      words.push({ text: texts[Math.floor(r() * texts.length)], startMs: t, endMs: t + d });
      t += r() < 0.1 ? 0 : d + Math.floor(r() * 1500);
    }
    const silences = [];
    let c = Math.floor(r() * 800);
    while (c < t) {
      const len = 150 + Math.floor(r() * 3000);
      silences.push({ startMs: c, endMs: c + len });
      c += len + 100 + Math.floor(r() * 2500);
    }
    const out = snapWordsToSpeech(words, silences);
    const where = "semente " + seed + " " + JSON.stringify(out).slice(0, 160);
    assert.equal(out.length, words.length, "perdeu palavra, " + where);
    out.forEach((w, k) => {
      assert.ok(w.endMs > w.startMs, "palavra sem duração, " + where);
      if (k) assert.ok(w.startMs > out[k - 1].startMs && out[k - 1].endMs <= w.startMs, "fora de ordem ou por cima, " + where);
      // palavra que não é palpite não atravessa uma pausa inteira (o corte da pausa levaria a palavra: "redes," no 2.MOV)
      if (!w.estimated) assert.ok(!silences.some((s) => s.endMs - s.startMs >= 300 && s.startMs >= w.startMs + 40 && s.endMs <= w.endMs), "atravessa uma pausa, " + where);
    });
  }
});

test("sons: em ordem, sem sobrepor e nunca mais perto que o mínimo", () => {
  const { sfxSlots } = require("../src/core/captions/sfx.js");
  for (let seed = 1; seed <= 900 * FUZZ; seed += 1) {
    const r = rng(seed * 4513);
    const times = Array.from({ length: Math.floor(r() * 80) }, () => (r() < 0.05 ? NaN : r() * 60));
    const minSeconds = [1 / 30, 0.15, 0.5][seed % 3];
    const slots = sfxSlots(times, { lead: r() * 0.1, seconds: 0.05 + r() * 0.5, minSeconds });
    const where = "semente " + seed + " " + JSON.stringify(slots.slice(0, 4));
    slots.forEach((x, k) => {
      assert.ok(x.inSeconds >= 0 && x.outSeconds > x.inSeconds, "som vazio, " + where);
      if (k) assert.ok(x.inSeconds >= slots[k - 1].inSeconds + minSeconds - 1e-9 && slots[k - 1].outSeconds <= x.inSeconds + 1e-9, "perto demais ou por cima, " + where);
    });
  }
});

test("meus estilos importados de outra pessoa: só nome, base própria e valores simples, com lixo sorteado", () => {
  const { cleanUserStyles } = require("../src/core/captions/userstyles.js");
  const FIELDS = ["preset", "fontFamily", "fontSize", "highlight"];
  const PRESETS = { clean: {}, compose: {} };
  const junk = [null, undefined, 0, -1, NaN, Infinity, "", "x".repeat(300), "clean", "compose", "__proto__", "constructor", "toString", true, [], {}, { toString: 1 }, "  Nome  "];
  for (let seed = 1; seed <= 1500 * FUZZ; seed += 1) {
    const r = rng(seed * 3049);
    const pick = () => junk[Math.floor(r() * junk.length)];
    const list = Array.from({ length: Math.floor(r() * 130) }, () => (r() < 0.1 ? pick() : { name: pick(), style: r() < 0.1 ? pick() : { preset: pick(), fontFamily: pick(), fontSize: pick(), highlight: pick(), evil: pick() } }));
    const out = cleanUserStyles(r() < 0.05 ? pick() : list, FIELDS, PRESETS);
    assert.ok(out.length <= 100, "mais de 100, semente " + seed);
    out.forEach((it) => {
      const where = "semente " + seed + " " + JSON.stringify(it).slice(0, 120);
      assert.ok(typeof it.name === "string" && it.name.length > 0 && it.name.length <= 40, "nome, " + where);
      assert.ok(Object.prototype.hasOwnProperty.call(PRESETS, it.style.preset), "base, " + where);
      Object.keys(it.style).forEach((k) => {
        const v = it.style[k];
        assert.ok(FIELDS.includes(k) && (typeof v === "boolean" || (typeof v === "number" && isFinite(v)) || (typeof v === "string" && v.length <= 200)), "campo " + k + ", " + where);
      });
    });
  }
});

test("transcrição de arquivo com formato estranho: não quebra e só devolve tempos válidos", () => {
  const { parseTranscript } = require("../src/core/captions/transcript.js");
  const junk = [null, 0, -5, 1e12, NaN, "", "oi", "12", true, [], {}, { toString: 1 }, "__proto__", "constructor"];
  for (let seed = 1; seed <= 1500 * FUZZ; seed += 1) {
    const r = rng(seed * 2311);
    const pick = () => junk[Math.floor(r() * junk.length)];
    const num = () => (r() < 0.2 ? pick() : Math.floor(r() * 100000) / (r() < 0.5 ? 1 : 1000));
    const word = () => (r() < 0.1 ? pick() : { word: r() < 0.2 ? pick() : "palavra", text: r() < 0.3 ? pick() : undefined, start: num(), end: num(), startMs: num(), endMs: num() });
    const seg = () => (r() < 0.1 ? pick() : { text: r() < 0.2 ? pick() : " frase", start: num(), end: num(), offsets: r() < 0.5 ? { from: num(), to: num() } : pick(), words: r() < 0.5 ? Array.from({ length: Math.floor(r() * 6) }, word) : pick() });
    const shapes = [() => Array.from({ length: Math.floor(r() * 8) }, seg), () => ({ segments: Array.from({ length: Math.floor(r() * 8) }, seg), words: r() < 0.5 ? Array.from({ length: Math.floor(r() * 8) }, word) : pick() }), () => ({ transcription: Array.from({ length: Math.floor(r() * 8) }, seg) }), () => ({ words: Array.from({ length: Math.floor(r() * 12) }, word) }), () => pick()];
    const content = r() < 0.05 ? "{ não é json" : JSON.stringify(shapes[Math.floor(r() * shapes.length)]());
    let out;
    assert.doesNotThrow(() => { out = parseTranscript(content); }, "quebrou, semente " + seed);
    (out.items || []).forEach((it) => {
      const where = "semente " + seed + " " + JSON.stringify(it).slice(0, 140);
      assert.ok(isFinite(it.startMs) && isFinite(it.endMs) && it.endMs >= it.startMs && it.startMs >= 0, "tempo inválido, " + where);
      assert.ok(typeof it.text === "string", "texto, " + where);
      (it.words || []).forEach((w) => assert.ok(typeof w.text === "string" && w.text && isFinite(w.startMs) && isFinite(w.endMs) && w.endMs >= w.startMs, "palavra, " + where));
    });
  }
});

test(".srt estragado: não quebra e só devolve legendas com tempo válido", () => {
  const { parseSrt } = require("../src/core/captions/srt.js");
  const bits = ["1", "2", "-3", "", "00:00:01,000 --> 00:00:02,500", "00:00:05,000 --> 00:00:04,000", "99:99:99,999 --> 00:00:01,000", "00:00:01.200 --> 00:00:01.900", "0:0:1,5 --> 0:0:2,5", "-->", "texto", "<i>itálico</i>", "\ufeff1", "\r", "linha\r\n", "00:00:03,000 -->", "a --> b"];
  for (let seed = 1; seed <= 1500 * FUZZ; seed += 1) {
    const r = rng(seed * 8191);
    const lines = Array.from({ length: Math.floor(r() * 40) }, () => bits[Math.floor(r() * bits.length)]);
    let out;
    assert.doesNotThrow(() => { out = parseSrt(lines.join(r() < 0.5 ? "\n" : "\r\n")); }, "quebrou, semente " + seed);
    (out.items || []).forEach((it) => {
      const where = "semente " + seed + " " + JSON.stringify(it).slice(0, 120);
      assert.ok(isFinite(it.startMs) && isFinite(it.endMs) && it.startMs >= 0 && it.endMs >= it.startMs, "tempo inválido, " + where);
      assert.ok(typeof it.text === "string", "texto, " + where);
    });
  }
});
