/**
 * As contas do Reel sem Premiere, sem Electron e sem ffmpeg rodando: mapa de tempo do bruto para o
 * vídeo cortado, quantos quadros o corte deixa, tamanho do vídeo já girado e o grafo de filtros da
 * passada final. O pipeline.js usa; tests/reel-plan.test.js confere (inclusive rodando o grafo).
 */
"use strict";

// Trecho sem nenhuma palavra sai: respiração, estalo, barulho entre tomadas (bruto da Patrícia, 20/10:
// 0,3 s soltos no meio do Reel) ou falso começo curto ("Primeira pergunta." largada, 1,9 s, sem legenda).
// A fala longa sem palavra já passou pela 2ª escuta (relisten do transcribe.js); se ainda está sem, é ruído.
function dropStrayNoise(keep, words) {
  return keep.filter((r) => words.some((w) => w.startMs < r.endMs && w.endMs > r.startMs));
}

// A frase da 2ª escuta (palavras com quiet) é fala abaixo do limite do detector: o "silêncio" dentro
// dela não é pausa ("a escola identifica" saía do corte). Tira esses trechos das pausas a cortar: cada palavra
// com o respiro `pad`, nos tempos já afinados pelo áudio (snapWordsToSpeech). O vão entre duas palavras baixas
// maior que os dois respiros é pausa e sai como as outras: juntar as palavras até 2 s deixava 1,7 s parado
// dentro da frase baixa ("Como [1,7 s] que a escola", 1 (1).mov aos 87 s, juiz 22/10).
function keepQuietSpeech(silences, words, pad) {
  const p = pad === undefined ? 120 : pad;
  const spans = [];
  for (const w of words) {
    if (!w.quiet) continue;
    const last = spans[spans.length - 1];
    if (last && w.startMs - p <= last.endMs) last.endMs = Math.max(last.endMs, w.endMs + p);
    else spans.push({ startMs: w.startMs - p, endMs: w.endMs + p });
  }
  let out = silences;
  for (const p of spans) {
    out = out.flatMap((s) => (s.endMs <= p.startMs || s.startMs >= p.endMs ? [s]
      : [s.startMs < p.startMs && Object.assign({}, s, { endMs: p.startMs }), s.endMs > p.endMs && Object.assign({}, s, { startMs: p.endMs })].filter(Boolean)));
  }
  return out;
}

// Folga da emenda presa às palavras, como o editor faz: cada trecho começa no máximo `pre` ms antes da sua
// 1ª palavra e termina no máximo `post` ms depois da última (o último do Reel, `tail`: a última legenda
// precisa de tempo para ser lida). Só encolhe. Medido em 21/10: o corte por silêncio deixava 340 a 830 ms
// sem voz em cada emenda (respiração, estalo de boca, 1 s antes da 1ª fala); o Jota deixa ~135 ms
// (80 antes do corte + 55 depois) e ~0,5 s no fim.
// voiced(ms) (opcional): há voz nesse instante (10 ms)? O fim da palavra do Whisper vem cedo ("essencial." no
// Roteiro 4 fecha em 80,07 s e a voz vai até ~80,5 s: o "-cial" saía no corte); a folga conta de onde a voz acaba.
// E a folga para a 40 ms da voz clara que sai (clearVoice(ms), opcional): a de 80 ms antes de "Nossa" entrava no
// ensaio colado a ela (1.MOV, 39,9 s, vale de 30 ms entre os dois) e a de 100 ms depois de "essencial." na fala sem
// palavra 50 ms adiante (Roteiro 4, 80,7 s): a emenda raspava a voz. Chiado baixo (o "-s" de "perguntas.") não conta.
const GUARD_MS = 40;
function hugWords(keep, words, pre, post, tail, voiced, clearVoice) {
  const clear = (a, b) => { for (let t = a; t < b; t += 10) if (clearVoice(t)) return false; return true; };
  return keep.map((r, i) => {
    const inside = words.filter((w) => (w.startMs + w.endMs) / 2 >= r.startMs && (w.startMs + w.endMs) / 2 <= r.endMs);
    if (!inside.length) return r;
    let first = Math.min(...inside.map((w) => w.startMs));
    let last = Math.max(...inside.map((w) => w.endMs));
    while (voiced && last < r.endMs && voiced(last)) last += 10;
    while (voiced && first > r.startMs && voiced(first - 10)) first -= 10;
    const lo = Math.max(r.startMs, first - pre);
    const hi = Math.min(r.endMs, last + (i === keep.length - 1 ? tail : post));
    if (!clearVoice) return { startMs: lo, endMs: hi };
    let startMs = Math.max(lo, Math.min(first, hi)), endMs = Math.min(hi, Math.max(last, lo));
    while (startMs > lo && clear(Math.max(lo, startMs - 10) - GUARD_MS, startMs)) startMs = Math.max(lo, startMs - 10);
    while (endMs < hi && clear(endMs, Math.min(hi, endMs + 10) + GUARD_MS)) endMs = Math.min(hi, endMs + 10);
    return { startMs, endMs };
  }).filter((r) => r.endMs > r.startMs);
}

// A emenda que cai dentro da voz vai para o silêncio ou o vale: settleEdges do núcleo (src/core/audio/silence.js),
// o mesmo que o Autocorte do painel usa.

// Plano curto entre dois cortes pisca (e o punch-in alternado vai e volta nele): o trecho cresce até `min` ms
// para dentro do que sai (silêncio), primeiro depois dele e depois antes. "Como" sozinho com 0,3 s entre duas
// pausas cortadas (1 (1).mov, 87 s); o Jota não faz plano de menos de 0,33 s.
function holdShots(keep, min) {
  return keep.map((r, i) => {
    const out = Object.assign({}, r);
    const need = () => min - (out.endMs - out.startMs);
    if (need() > 0) out.endMs = Math.min(i + 1 < keep.length ? keep[i + 1].startMs : out.endMs, out.endMs + need());
    if (need() > 0) out.startMs = Math.max(i > 0 ? keep[i - 1].endMs : out.startMs, out.startMs - need());
    return out;
  });
}

// Legenda que pisca: fica na tela pelo menos `min` s (sem passar do começo da seguinte), e um buraco de menos
// de 0,4 s até a seguinte é coberto (a legenda some e volta = piscada). "pra você." ficava 0,2 s no 1 (1).mov
// (juiz, 21/10); o Jota troca a cada ~0,6 s sem buraco. Mexe nos segmentos e devolve a mesma lista.
function holdCaptions(segments, min) {
  segments.forEach((s, i) => {
    const next = segments[i + 1];
    const until = next ? next.inSeconds : Infinity;
    if (until - s.outSeconds < 0.4) s.outSeconds = Math.max(s.outSeconds, until);
    if (s.outSeconds - s.inSeconds < min) s.outSeconds = Math.max(s.outSeconds, Math.min(until, s.inSeconds + min));
  });
  return segments;
}

// Tempo do bruto -> tempo do vídeo cortado. A palavra fica se o meio dela ficou; começo e fim são
// presos ao trecho onde o meio está (empurrar a palavra cortada para o próximo trecho empilhava
// 5 legendas no mesmo instante, bruto do Jota em 19/10).
function timeMap(keep) {
  let acc = 0;
  const spans = keep.map((r) => {
    const s = { startMs: r.startMs, endMs: r.endMs, outMs: acc };
    acc += r.endMs - r.startMs;
    return s;
  });
  return {
    totalMs: acc,
    // um instante do bruto no vídeo cortado; caído num trecho que saiu, vai para o começo do
    // próximo trecho que ficou (ou para o fim)
    at(ms) {
      for (const s of spans) {
        if (ms < s.startMs) return s.outMs;
        if (ms <= s.endMs) return s.outMs + (ms - s.startMs);
      }
      return acc;
    },
    word(w) {
      const mid = (w.startMs + w.endMs) / 2;
      for (const s of spans) {
        if (mid < s.startMs || mid > s.endMs) continue;
        const a = Math.max(w.startMs, s.startMs);
        const b = Math.min(w.endMs, s.endMs);
        return { text: w.text, startMs: Math.round(s.outMs + a - s.startMs), endMs: Math.round(s.outMs + Math.max(b, a + 60) - s.startMs) };
      }
      return null;
    },
  };
}

// Começo de frase com maiúscula na legenda: a 1ª palavra do Reel e a que vem depois de ponto. O corte
// tira o começo da frase ("a Câmara" depois de "passagem"." no 2.MOV, quando o Boost tirou o "A Câmara,"
// regravado) e o Whisper escreve minúscula no meio da fala ("e memoriza", 1ª palavra do bruto).
function sentenceCase(words) {
  return words.map((w, i) => (i && !/[.!?…]["”')]?$/.test(words[i - 1].text) ? w
    : Object.assign({}, w, { text: w.text.replace(/^([“"'(¿¡]*)(\p{Ll})/u, (m, a, b) => a + b.toUpperCase()) })));
}

// Aspa sem par na frase sai (legenda e capa): o Whisper abriu "A Câmara de Vila Rica… e não fechou (2.MOV;
// a capa saía com uma aspa solta na frente). Frase = até o ponto final; aspa com par fica ("passagem").
function oddQuotes(words) {
  const out = words.map((w) => Object.assign({}, w));
  let from = 0;
  out.forEach((w, i) => {
    if (i < out.length - 1 && !/[.!?…]["”')]?$/.test(w.text)) return;
    const part = out.slice(from, i + 1);
    if (part.reduce((n, x) => n + (x.text.match(/["“”]/g) || []).length, 0) % 2) part.forEach((x) => (x.text = x.text.replace(/["“”]/g, "")));
    from = i + 1;
  });
  return out.filter((w) => w.text);
}

// Trechos presos à grade de quadros: o trecho [a, b) em quadros (a/fps a b/fps). Imagem e som cortam no
// mesmo quadro; antes cada trecho arredondava a imagem para um lado (±1 quadro) e o som cortava em pacotes
// de 21 ms, e a diferença somava: 40 a 79 ms de boca fora do som depois de 3 cortes (2.MOV, 21/10). Trecho
// que encosta no seguinte vira um só (não há corte).
function snapKeep(keep, fps) {
  const out = [];
  for (const r of keep) {
    const a = Math.round((r.startMs / 1000) * fps), b = Math.round((r.endMs / 1000) * fps);
    if (b <= a) continue;
    const last = out[out.length - 1];
    if (last && a <= last.b) last.b = Math.max(last.b, b);
    else out.push({ a, b });
  }
  return out.map((s) => ({ startMs: (s.a * 1000) / fps, endMs: (s.b * 1000) / fps }));
}

// [a, b) em quadros de um trecho já preso à grade
function frameSpan(r, fps) {
  return [Math.round((r.startMs / 1000) * fps), Math.round((r.endMs / 1000) * fps)];
}

// Quadros do vídeo cortado (trechos presos à grade), menos 1 de folga (o pipe não pode mandar mais quadros
// do que o vídeo tem; o overlay passa o resto sem legenda).
function keptFrameCount(keep, fps) {
  const n = keep.reduce((sum, r) => {
    const [a, b] = frameSpan(r, fps);
    return sum + Math.max(0, b - a);
  }, 0);
  return Math.max(0, n - 1);
}

// Até onde a passada final lê o bruto (o -t da entrada): o fim do último trecho e 1 s de folga. Sem isso o
// ffmpeg decodificava o bruto até o fim e o select jogava fora: 2.MOV de 40 s com o último trecho em 30,4 s,
// 9 s de HEVC 10 bits a mais (o ffmpeg da passada final de 28,9 para 23,2 s, PC carregado, 2 rodadas).
// -> segundos em texto, ou null sem trecho
function readUntil(keep, fps) {
  const end = keep.reduce((m, r) => Math.max(m, frameSpan(r, fps)[1]), 0);
  return end > 0 ? (end / fps + 1).toFixed(3) : null;
}

// Emendas com micro fade: 8 ms descendo e 8 subindo em cada uma (o estalo some mesmo se o corte cair num
// resto de voz; no silêncio não se ouve). Faixa usada pelo Jota e pela pesquisa: 5 a 15 ms.
const SPLICE_FADE = 0.008;

// O corte, com os trechos presos à grade (snapKeep). Imagem: fps fixo (o do iPhone varia um pouco), select
// com o limite no meio entre dois quadros (nenhum quadro cai em cima do limite, então a conta aqui e a do
// ffmpeg dão os mesmos quadros) e o tempo renumerado. Som: cada trecho cortado na amostra exata (atrim), com
// o micro fade, e emendado (concat). O asplit não junta o áudio todo na memória: cada atrim joga fora o que
// é de fora dele e o concat só segura o trecho seguinte.
function cutFilters(keep, fps) {
  const f = fps || 30;
  // gainDb (opcional, de levelSpans): o volume da voz daquele trecho igualado aos outros
  const spans = keep.map((r) => Object.assign(frameSpan(r, f), { gain: r.gainDb || 0 })).filter(([a, b]) => b > a);
  const sec = (n) => (n / f).toFixed(6);
  const between = spans.map(([a, b]) => "between(t\\," + ((a - 0.5) / f).toFixed(5) + "\\," + ((b - 0.5) / f).toFixed(5) + ")").join("+");
  const piece = (s) => {
    const [a, b] = s;
    const len = (b - a) / f, d = Math.min(SPLICE_FADE, len / 3);
    return "atrim=start=" + sec(a) + ":end=" + sec(b) + ",asetpts=PTS-STARTPTS" + (s.gain ? ",volume=" + s.gain + "dB" : "") +
      ",afade=t=in:d=" + d.toFixed(4) + ",afade=t=out:st=" + (len - d).toFixed(6) + ":d=" + d.toFixed(4);
  };
  const audio = spans.length === 1 ? piece(spans[0])
    : "asplit=" + spans.length + spans.map((_, k) => "[c" + k + "]").join("") + ";" +
      spans.map((s, k) => "[c" + k + "]" + piece(s) + "[d" + k + "]").join(";") + ";" +
      spans.map((_, k) => "[d" + k + "]").join("") + "concat=n=" + spans.length + ":v=0:a=1";
  return {
    video: "fps=" + f + ",select='" + between + "',setpts=N/FRAME_RATE/TB",
    audio,
  };
}

// Punch-in alternado (como o Jota: 41% dos cortes do Reel da Patrícia mudam o enquadramento, de 8% a 22%):
// trecho sim, trecho não, o vídeo fica mais perto, e o pulo do corte vira mudança de plano. Fator no tempo
// do vídeo cortado, com o degrau no meio entre dois quadros (cai exatamente no quadro do corte).
function punchExpr(keep, fps, amount) {
  if (!(amount > 0) || keep.length < 2) return "1";
  const terms = [];
  let acc = 0;
  keep.forEach((r, k) => {
    const [a, b] = frameSpan(r, fps);
    if (k % 2 === 1) terms.push("between(t\\," + ((acc - 0.5) / fps).toFixed(5) + "\\," + ((acc + b - a - 0.5) / fps).toFixed(5) + ")");
    acc += b - a;
  });
  return "(1+" + amount + "*(" + terms.join("+") + "))";
}

// Largura e altura como o vídeo aparece: celular grava deitado com "rotation of -90".
function videoSize(probeText) {
  const dim = /Video:.*?\b(\d{3,5})x(\d{3,5})\b/.exec(probeText) || [];
  const rot = Math.abs(Number((/rotation of (-?[\d.]+)/.exec(probeText) || [])[1]) || 0);
  const turned = rot === 90 || rot === 270;
  return { W: Number(dim[turned ? 2 : 1]) || 1080, H: Number(dim[turned ? 1 : 2]) || 1920 };
}

// Cor do iPhone (HDR) para o Reel: o iPhone grava HLG em BT.2020 e o Reel saía com essas marcas, em 8 bits.
// Quem não entende HDR (a maioria dos players) mostrava as cores lavadas; o Jota entrega SDR BT.709 (o
// Premiere converte). O HLG foi feito para passar como SDR: basta trocar as cores primárias (2020 -> 709) e
// marcar 709. Lado a lado com o quadro do Jota (2.MOV, 21/10): o mais parecido, sem o rosa e o estouro do
// zscale+tonemap. PQ (HDR10 de alguns Android) não passa como SDR: aí vai o tonemap de verdade.
// -> filtro (sem vírgula nas pontas) ou "" (vídeo SDR, nada a fazer)
function toneFilter(probeText) {
  const v = (/Video:[^\n]*/.exec(probeText || "") || [""])[0];
  if (/smpte2084/.test(v)) return "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p";
  if (/bt2020/.test(v)) return "colorspace=all=bt709:iall=bt2020:itrc=bt2020-10:format=yuv420p";
  return "";
}

// Bruto deitado (16:9) vira Reel em pé: recorte 9:16 e escala para 1080x1920. faceX (0..1, onde
// está o rosto na largura) puxa o recorte para a pessoa; sem ele, o recorte é no centro.
// Em pé no tamanho certo (1080x1920 do celular) fica como está; em pé em 4K ou 720p vira 1080x1920
// (Reels, TikTok e Shorts entregam no máximo isso: 4K só deixava o canvas e o vídeo 4x mais lentos).
// -> { crop: "crop=..,scale=..", W, H } ou { crop: "", W, H } quando já está no tamanho.
// scale (opcional, 0..1): a prévia rápida sai menor (0,5 = 540x960), com a mesma conta.
function reframe(W, H, faceX, format, scale) {
  const full = FORMATS[format] || FORMATS.reels;
  const k = scale > 0 && scale < 1 ? scale : 1;
  const out = { w: Math.round((full.w * k) / 2) * 2, h: Math.round((full.h * k) / 2) * 2 };
  const want = out.w / out.h;
  if (Math.abs(W / H - want) < 0.01) return { crop: W === out.w ? "" : "scale=" + out.w + ":" + out.h + ",setsar=1", W: out.w, H: out.h };
  let crop;
  if (W / H > want) {
    // mais largo que o formato: corta dos lados, puxando para o rosto
    const cw = Math.round((H * want) / 2) * 2;
    const x = faceX >= 0 && faceX <= 1
      ? String(Math.max(0, Math.min(W - cw, Math.round((faceX * W - cw / 2) / 2) * 2)))
      : "(in_w-" + cw + ")/2";
    crop = "crop=" + cw + ":" + H + ":" + x + ":0";
  } else {
    // mais alto que o formato (em pé para 4:5 ou quadrado): corta embaixo e em cima, guardando a
    // parte de cima, onde fica o rosto de quem fala para a câmera
    const ch = Math.round(W / want / 2) * 2;
    crop = "crop=" + W + ":" + ch + ":0:(in_h-" + ch + ")*0.3";
  }
  return { crop: crop + ",scale=" + out.w + ":" + out.h + ",setsar=1", W: out.w, H: out.h };
}

// Formatos de saída: Reels/TikTok/Shorts em pé, feed do Instagram 4:5 e quadrado.
const FORMATS = {
  reels: { w: 1080, h: 1920 },
  feed: { w: 1080, h: 1350 },
  quadrado: { w: 1080, h: 1080 },
};

// Onde o rosto fica no vídeo: a mediana dos centros achados nos quadros de amostra (fração da
// largura); null sem rosto. A mediana ignora um quadro em que o detector errou.
function faceCenter(boxes, width) {
  return median(boxes.map((b) => (b.x + b.width / 2) / width));
}

function median(list) {
  const xs = list.slice().sort((a, b) => a - b);
  if (!xs.length) return null;
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
}

// Ponto que o zoom mantém parado (fração do quadro de saída): o rosto, se achado; senão o centro,
// um pouco acima (onde costuma estar o rosto de quem fala para a câmera).
// boxes em pixels de uma amostra de largura sw e altura sh; crop: a fração da largura que o
// recorte em pé guardou ({x0, w}), para converter a posição do bruto deitado para a saída.
function zoomFocus(boxes, sw, sh, crop) {
  const fx = median(boxes.map((b) => (b.x + b.width / 2) / sw));
  const fy = median(boxes.map((b) => (b.y + b.height / 2) / sh));
  if (fx === null || fy === null) return { x: 0.5, y: 0.35 };
  const x = crop ? (fx - crop.x0) / crop.w : fx;
  return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, fy)) };
}

// Fator de zoom no tempo t: 1 + amount nos momentos, com rampa de entrada e saída em curva suave
// (smoothstep: começa e termina devagar, como as chaves suavizadas do Jota no Premiere; a rampa reta
// arrancava e parava de uma vez).
function zoomExpr(zooms, amount, rampSeconds) {
  if (!zooms.length) return "1";
  const r = String(rampSeconds);
  const ease = (x) => "clip(" + x + "\\,0\\,1)*clip(" + x + "\\,0\\,1)*(3-2*clip(" + x + "\\,0\\,1))";
  const term = (a, b) => {
    const A = a.toFixed(3), B = b.toFixed(3);
    return "between(t\\," + A + "\\," + B + ")*" + ease("(t-" + A + ")/" + r) + "*" + ease("(" + B + "-t)/" + r);
  };
  return "(1+" + amount + "*(" + zooms.map((z) => term(z.inSeconds, z.outSeconds)).join("+") + "))";
}

/**
 * Grafo da passada final. Entradas do ffmpeg: 0 = bruto (ou cortado), 1 = legenda RGBA (só a
 * faixa band), 2 = estalo, 3 = batida, 4 = música (opcional). Saídas [v] e [a].
 * music: true (em loop, abaixa com a fala) ou, com a batida no momento certo, o plano da música do Jota
 *   { start, gainDb, dur, abafar } (musicaJota de src/motion-jota/trilha-jota.js; gainDb leva a música a MUSIC_LUFS)
 * o: { W, H, band:{y,h}, cut:{video,audio}|null, reframe:"crop=..."|"", zoom, fx:[{at, input, vol}], music,
 *      frameInput, maskInput, fps, src, edge } (frameInput: número da entrada com a moldura PNG, ou nada;
 *      edge: o filtro de borda do recortador, aplicado na máscara crua já esticada, como no painel)
 * W e H são do vídeo de saída (já em pé, se houve reframe).
 */
function finalGraph(o) {
  const STEREO = "aformat=sample_rates=48000:channel_layouts=stereo";
  const pre = o.cut ? o.cut.video + "," : "";
  // cor do bruto (toneFilter): depois do recorte/escala do reframe (o 4K em pé vira 1080 antes: no 4K inteiro a
  // passada final caía de 16 para 8 q/s) e antes do zoom; a máscara usa só o pre
  const tone = o.tone ? o.tone + "," : "";
  const zoom = "scale=w='" + o.W + "*" + o.zoom + "':h='" + o.H + "*" + o.zoom + "':eval=frame," +
    // o ponto de foco fica parado na tela enquanto o vídeo cresce em volta dele
    "crop=" + o.W + ":" + o.H + ":(in_w-" + o.W + ")*" + (o.focus ? o.focus.x.toFixed(3) : "0.5") + ":(in_h-" + o.H + ")*" + (o.focus ? o.focus.y.toFixed(3) : "0.35");
  // O zoom (destaques e punch-in) já escala para W*z x H*z: a escala do reframe (4K em pé -> 1080, ou o pedaço
  // 9:16 do deitado -> 1080x1920) sai e o zoom parte do bruto, então o punch-in do 4K não perde nitidez. A cor vai
  // no fim, já no tamanho do Reel.
  const reframe = (o.reframe || "").replace(/(^|,)scale=\d+:\d+,setsar=1$/, "");
  const motion = (reframe ? reframe + "," : "") + zoom + (o.reframe ? ",setsar=1" : "") + (o.tone ? "," + o.tone : "");
  // recorte simples do reframe: crop=cw:ch:x:y,<resto>
  const rc = o.maskInput && /^crop=(\d+):(\d+):('[^']*'|[^:,]+):([^:,]+),(.+)$/.exec(o.reframe || "");
  let g;
  if (rc) {
    // Mais rápido (medido pelo fx-3: 11,3 s -> ~6 s em 401 quadros): o vídeo é cortado antes de ganhar
    // alfa (yuva420p, não rgba em 1920x1080) e a máscara é cortada no tamanho dela (in_w/in_h da
    // máscara, proporcionais ao bruto) e esticada direto ao pedaço, já com a borda.
    const num = (e) => e.replace(/^'|'$/g, "").replace(/in_w/g, o.src.w).replace(/in_h/g, o.src.h);
    g = "[" + o.maskInput + ":v]fps=" + o.fps + "," + pre + "crop=w='in_w*" + rc[1] + "/" + o.src.w + "':h='in_h*" + rc[2] + "/" + o.src.h +
      "':x='(" + num(rc[3]) + ")*in_w/" + o.src.w + "':y='(" + num(rc[4]) + ")*in_h/" + o.src.h + "',scale=" + rc[1] + ":" + rc[2] +
      ":flags=bicubic," + (o.edge ? o.edge + "," : "") + "format=gray[mk];" +
      "[0:v]" + pre + "crop=" + rc[1] + ":" + rc[2] + ":" + rc[3] + ":" + rc[4] + "," + tone + "format=yuva420p[sa];[sa][mk]alphamerge," + rc[5] + "," + zoom + ",split[z][pa];";
  } else if (o.maskInput) {
    // Legenda atrás da pessoa: a máscara do recortador (cinza, pequena, no tempo do bruto, na mesma taxa
    // de quadros) passa pelo mesmo corte, vira o alfa do bruto, e o vídeo com alfa passa pelo mesmo
    // recorte e zoom. A pessoa (com alfa) entra por cima da legenda.
    g = "[" + o.maskInput + ":v]fps=" + o.fps + "," + pre + "scale=" + o.src.w + ":" + o.src.h + ":flags=bicubic," + (o.edge ? o.edge + "," : "") + "format=gray[mk];" +
      "[0:v]" + pre + tone + "format=rgba[sa];[sa][mk]alphamerge," + (o.reframe ? o.reframe + "," : "") + zoom + ",split[z][pa];"; // as duas saídas do split têm o mesmo formato: um format=yuv420p aqui tirava o alfa da pessoa
  } else {
    g = "[0:v]" + pre + motion + "[z];";
  }
  // legenda por cima do vídeo; com a máscara, a pessoa por cima da legenda; a moldura da marca por cima de tudo
  g += "[z][1:v]overlay=0:" + o.band.y + ":eof_action=pass:format=auto" + (o.maskInput ? "[c0];[c0][pa]overlay=0:0:format=auto" : "") +
    (o.frameInput ? "[cap];[cap][" + o.frameInput + ":v]overlay=0:0:format=auto:shortest=1,format=yuv420p[v]" : ",format=yuv420p[v]");
  const labels = ["[voz]"];
  const jota = !!o.music && typeof o.music === "object";
  // a voz vai para a mistura e, com música em loop, também comanda o compressor que abaixa a música
  g += ";[0:a]" + (o.cut ? o.cut.audio + "," : "") + STEREO + (o.music && !jota ? ",asplit=2[voz][vsc]" : "[voz]");
  [2, 3].forEach((n) => {
    const list = o.fx.filter((f) => f.input === n);
    if (!list.length) return;
    g += ";[" + n + ":a]" + STEREO + ",asplit=" + list.length + list.map((_, k) => "[s" + n + "_" + k + "]").join("");
    list.forEach((f, k) => {
      const ms = Math.round(f.at * 1000);
      g += ";[s" + n + "_" + k + "]adelay=" + ms + "|" + ms + ",volume=" + f.vol + "[d" + n + "_" + k + "]";
      labels.push("[d" + n + "_" + k + "]");
    });
  });
  if (jota) {
    g += ";[4:a]" + require("../../src/motion-jota/trilha-jota.js").musicaJota(o.music) + "[md]";
  } else if (o.music) {
    g += ";[4:a]" + STEREO + ",volume=0.3[mus];[mus][vsc]sidechaincompress=threshold=0.02:ratio=10:attack=15:release=350[md]";
    labels.push("[md]");
  }
  // tudo nivelado em -14 LUFS (o volume dos Reels); a música do Jota entra depois, já em MUSIC_LUFS (20 dB abaixo da
  // voz por construção; antes do loudnorm ele mexeria nas duas juntas), e o limitador segura o pico que ela soma
  g += ";" + labels.join("") + "amix=inputs=" + labels.length + ":normalize=0:duration=first,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000" +
    (jota ? "[vm];[vm][md]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.84:level=0:latency=1[a]" : "[a]");
  return g;
}

// Música do Jota sob a voz: 20 dB abaixo dos -14 LUFS (docs/padrao-reel.md: piso de -37 dBFS sob a voz de -14)
const MUSIC_LUFS = -34;

// Onde o drop da música cai (Som do Jota): na 1ª palavra-chave do gancho (a 1ª frase, até 12 palavras) a partir de 1 s
// (antes disso a música não tem tempo de crescer) ou, sem ela, no fim do gancho (com 8 palavras, como a capa, caía no
// meio da frase: "até o fim | desse vídeo.", 2.MOV). segments: as legendas (palavras com inSeconds, outSeconds e key).
// -> { at, text } ou null (sem legenda)
function hookMoment(segments) {
  const hook = [];
  for (const w of [].concat(...segments.map((s) => s.words))) {
    hook.push(w);
    if (/[.!?…]["”')]?$/.test(w.text) || hook.length >= 12) break;
  }
  if (!hook.length) return null;
  const key = hook.find((w) => w.key && w.inSeconds >= 1);
  const last = hook[hook.length - 1];
  return key ? { at: key.inSeconds, text: key.text } : { at: last.outSeconds, text: "fim de \"" + last.text + "\"" };
}

// Altura do rosto (mediana dos quadros olhados), em fração da altura: para a legenda desviar dele
// (core/captions/faceaware.js). boxes: [{ y, height }] em pixels de um quadro de altura h. -> { top, bottom } ou null
function faceSpan(boxes, h) {
  if (!boxes.length || !(h > 0)) return null;
  const mid = (list) => list.slice().sort((a, b) => a - b)[list.length >> 1];
  return { top: mid(boxes.map((b) => b.y)) / h, bottom: mid(boxes.map((b) => b.y + b.height)) / h };
}

// Dois quadros RGBA iguais? De 4 em 4 bytes (Uint32), para a legenda parada não ser desenhada de novo.
function samePixels(a, b) {
  if (a.length !== b.length) return false;
  const x = new Uint32Array(a.buffer, a.byteOffset, a.length >> 2);
  const y = new Uint32Array(b.buffer, b.byteOffset, b.length >> 2);
  for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return false;
  return true;
}

// Palavras guardadas por vídeo (pasta temporária): a segunda rodada do mesmo bruto não ouve de novo, e
// o plano de quem fala e a máscara guardada ficam iguais (a GPU e a CPU ouvem um pouco diferente).
// Chave: arquivo, tamanho, data, modelo e os segundos de teste. -> caminho do .json
function wordsFile(dir, input, stat, model, seconds) {
  // palavras9: o ensaio da 2ª escuta só sai quando a frase seguinte (ou o bloco refeito) o repete
  // (d5ed9eb, 7b3c677); o que foi guardado antes seguiu a regra antiga
  const key = require("crypto").createHash("sha1").update(["palavras9", input, stat.size, stat.mtimeMs, model, seconds || 0].join("|")).digest("hex").slice(0, 16);
  return require("path").join(dir, key + ".json");
}

// -> [{ text, startMs, endMs }] ou null (sem arquivo, quebrado ou vazio)
function savedWords(file) {
  try {
    const list = JSON.parse(require("fs").readFileSync(file, "utf8"));
    const ok = Array.isArray(list) && list.length && list.every((w) => w && typeof w.text === "string" && isFinite(w.startMs) && isFinite(w.endMs));
    return ok ? list : null;
  } catch (e) {
    return null;
  }
}

// Vazio não guarda (sem fala, ou transcrição que falhou: na próxima, ouve de novo). Grava inteiro
// ou nada: outra rodada lendo ao mesmo tempo não pega o arquivo pela metade.
function saveWords(file, words) {
  if (!words || !words.length) return;
  const fs = require("fs");
  fs.mkdirSync(require("path").dirname(file), { recursive: true });
  const part = file + "." + process.pid + ".part";
  fs.writeFileSync(part, JSON.stringify(words));
  fs.renameSync(part, file);
}

module.exports = { MUSIC_LUFS, hookMoment, toneFilter, readUntil, snapKeep, punchExpr, hugWords, holdShots, holdCaptions, SPLICE_FADE, keepQuietSpeech, dropStrayNoise, sentenceCase, oddQuotes, wordsFile, savedWords, saveWords, FORMATS, samePixels, faceSpan, timeMap, keptFrameCount, cutFilters, videoSize, reframe, faceCenter, zoomFocus, zoomExpr, finalGraph };
