/**
 * Vários arquivos num Reel só (lacuna 9 da cobertura de 21/10): as tomadas, na ordem, viram um vídeo
 * só antes de ouvir e cortar; daí em diante o Reel segue igual. Cada uma é levada ao tamanho e aos
 * quadros por segundo da 1ª (o ffmpeg já gira o vídeo de celular ao ler) e o som vira 48 kHz estéreo;
 * tomada sem som entra com silêncio (o concat precisa de som em todas).
 * O pipeline.js usa; tests/reel-juntar.test.js roda o grafo no ffmpeg.
 */
"use strict";

// items: [{ hasAudio, duration }] na ordem; W x H (já girados) e fps da 1ª. -> filtro com saídas [v] e [a]
// ponytail: tomada em outra orientação (deitada no meio das em pé) é cortada no centro, sem procurar o
// rosto; se aparecer bruto assim, procurar o rosto por tomada antes de juntar.
function joinGraph(items, W, H, fps) {
  const parts = items.map((it, k) => {
    const v = "[" + k + ":v]scale=" + W + ":" + H + ":force_original_aspect_ratio=increase,crop=" + W + ":" + H + ",setsar=1,fps=" + fps + ",format=yuv420p[v" + k + "]";
    const a = it.hasAudio
      ? "[" + k + ":a]aformat=sample_rates=48000:channel_layouts=stereo[a" + k + "]"
      : "aevalsrc=0:c=stereo:s=48000:d=" + Math.max(0.04, it.duration).toFixed(3) + "[a" + k + "]";
    return v + ";" + a;
  });
  return parts.join(";") + ";" + items.map((_, k) => "[v" + k + "][a" + k + "]").join("") + "concat=n=" + items.length + ":v=1:a=1[v][a]";
}

// Mesmo formato (codec, tamanho, giro, quadros, cor e som), como as tomadas do mesmo celular: aí junta
// sem recodificar (concat do ffmpeg com -c copy), na hora. Recodificar 2 x 20 s de 4K levou 96 s.
function signature(probeText) {
  const v = /Video: (\w+)[^,\n]*, (\w+)[^\n]*?\b(\d{2,5}x\d{2,5})\b[^\n]*?([\d.]+) fps/.exec(probeText) || [];
  const a = /Audio: (\w+)[^\n]*?(\d+) Hz, ([^,\n]+)/.exec(probeText) || [];
  const r = /rotation of (-?[\d.]+)/.exec(probeText) || [];
  return [v.slice(1).join(" "), r[1] || "0", a.slice(1).join(" ") || "sem som"].join("|");
}

// Lista do concat (-f concat -safe 0): um arquivo por linha, com o fim em segundos quando há --seconds.
function concatList(files, seconds) {
  return files.map((f) => "file '" + f.replace(/\\/g, "/").replace(/'/g, "'\\''") + "'" + (seconds ? "\noutpoint " + seconds : "")).join("\n") + "\n";
}

// Os trechos que ficam não atravessam a emenda de duas tomadas: o que sobra de um lado sem palavra ou com
// menos de 0,1 s sai depois (pipeline). Sem isso, 2 quadros do fim de uma tomada piscavam antes da outra
// (2.MOV + Patrícia, 21/10: o trecho começava em 19,93 s e a emenda era em 20,00). points em ms, em ordem.
function splitAt(ranges, points) {
  return ranges.flatMap((r) => {
    const cuts = points.filter((p) => p > r.startMs && p < r.endMs);
    return [r.startMs].concat(cuts).map((a, k) => ({ startMs: a, endMs: k < cuts.length ? cuts[k] : r.endMs }));
  });
}

// Nome do Reel juntado: "1 + 2", ou "1 + 2 + 3 +2" com mais de 3 arquivos.
function joinName(names) {
  return names.slice(0, 3).join(" + ") + (names.length > 3 ? " +" + (names.length - 3) : "");
}

module.exports = { joinGraph, joinName, signature, concatList, splitAt };
