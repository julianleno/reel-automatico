/**
 * Onde a batida da música "entra" (o drop), para a música cair no lugar certo do vídeo. Receita do Jota
 * (@jota.videos, skill "Máquina de Reels", scripts/musica.js), aqui sem Web Audio: só as amostras.
 *
 * analyzeMusic(samples, sampleRate) -> { dur, bpm, beats:[s], drops:[{ t, exato, contraste, forca }], partes:[{ a, b, nivel, grave }] }
 *   samples: mono (Float32Array), de -1 a 1.
 *   - grave: passa-baixa em 120 Hz (o kick); bpm e batidas pelo findBeats (beats.js) no envelope do grave;
 *   - candidato a drop: em cada batida, o grave dos 4 s seguintes contra o dos 4 s anteriores (contraste)
 *     e forte depois (forca: fração do "grave forte", o das 5% janelas mais fortes); até 6, a mais de 20 s um do outro;
 *   - drop exato: o 1º kick forte (grave > 60% do grave forte) de 0,1 s antes do candidato em diante, e nele a 1ª
 *     amostra que passa de 25% do golpe (o "início do ataque" do Jota). Erro medido: +4 ms em kicks sintéticos.
 * placeDrop(music, { at, seconds }) -> { start, drop } | null
 *   start: o segundo da música que toca no 0 do vídeo para o drop cair em `at` (negativo: a música entra
 *   depois do 0). null: sem drop claro, ou a música acaba antes do vídeo.
 *
 * Global no painel: AppLegendasCore.analyzeMusic e placeDrop (carregar depois do beats.js). No Node: module.exports.
 */
(function (root, factory) {
  if (typeof window === "undefined" && typeof module === "object" && module.exports) {
    module.exports = factory(require("./beats.js").findBeats);
  } else {
    root.AppLegendasCore = root.AppLegendasCore || {};
    var api = factory(function (db, ms) { return root.AppLegendasCore.findBeats(db, ms); });
    root.AppLegendasCore.analyzeMusic = api.analyzeMusic;
    root.AppLegendasCore.placeDrop = api.placeDrop;
  }
})(typeof self !== "undefined" ? self : this, function (findBeats) {
  var CLEAR = 2; // drop claro: o grave depois do drop é pelo menos o dobro do de antes

  // passa-baixa de 2ª ordem (RBJ), duas vezes em série, como as duas BiquadFilter do Jota
  function lowpass(x, sr, f) {
    var w = 2 * Math.PI * f / sr, c = Math.cos(w), al = Math.sin(w) / (2 * 0.7);
    var a0 = 1 + al, b0 = (1 - c) / 2 / a0, b1 = (1 - c) / a0, a1 = -2 * c / a0, a2 = (1 - al) / a0;
    var y = new Float32Array(x.length);
    for (var pass = 0; pass < 2; pass += 1) {
      var src = pass ? y : x, x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (var i = 0; i < src.length; i += 1) {
        var v = src[i], o = b0 * v + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = v; y2 = y1; y1 = o;
        y[i] = o;
      }
    }
    return y;
  }

  // RMS por janela de H amostras
  function envelope(x, H) {
    var m = Math.floor(x.length / H), e = new Float32Array(m);
    for (var i = 0; i < m; i += 1) {
      var s = 0;
      for (var j = i * H; j < (i + 1) * H; j += 1) s += x[j] * x[j];
      e[i] = Math.sqrt(s / H);
    }
    return e;
  }

  function max(a) {
    var m = 0;
    for (var i = 0; i < a.length; i += 1) if (a[i] > m) m = a[i];
    return m;
  }

  function analyzeMusic(samples, sr) {
    var dur = samples.length / sr;
    var grave = lowpass(samples, sr, 120);
    // janelas de 10 e 50 ms em amostras inteiras, e o tempo de verdade de cada uma (22050 Hz: 10 ms = 220,5 amostras;
    // arredondar e contar 10 ms escorregava 0,2%: 120 BPM virava 120,3 e a grade saía 40 ms dos golpes em 20 s)
    var H = Math.max(1, Math.round(sr * 0.01)), h10 = H / sr, h50 = 5 * h10;
    var g10 = envelope(grave, H), g50 = envelope(grave, 5 * H), f50 = envelope(samples, 5 * H);
    // "grave forte" é o das janelas mais fortes (95%), não o pico de uma janela só: no musica.js o máximo de uma
    // janela deixava sem drop as músicas sem grave turbinado (louvor, acústico; Downloads, 22/10)
    var gMax = Array.prototype.slice.call(g50).sort(function (p, q) { return p - q; })[Math.floor(g50.length * 0.95)] || 0, fMax = max(f50);
    var db = Array.prototype.map.call(g10, function (v) { return 20 * Math.log10(v + 1e-9); });
    var found = findBeats(db, h10 * 1000);
    var beats = found.beats.map(function (ms) { return ms / 1000; });
    // média de um envelope de 50 ms entre a e b segundos (soma acumulada)
    var acc = function (e) {
      var s = new Float64Array(e.length + 1);
      for (var i = 0; i < e.length; i += 1) s[i + 1] = s[i] + e[i];
      return function (a, b) {
        a = Math.max(0, Math.floor(a / h50)); b = Math.min(e.length, Math.floor(b / h50));
        return b > a ? (s[b] - s[a]) / (b - a) : 0;
      };
    };
    var gm = acc(g50), fm = acc(f50);
    var cand = [];
    // sem batida achada (música sem kick), os candidatos vêm de meio em meio segundo
    var grid = beats.length ? beats : [];
    if (!grid.length) for (var q = 0; q < dur; q += 0.5) grid.push(q);
    grid.forEach(function (t) {
      if (t < 2 || t > dur - 4 || !gMax) return;
      var antes = gm(t - 4, t), depois = gm(t, t + 4), forca = depois / gMax;
      if (forca > 0.25) cand.push({ t: Math.round(t * 1000) / 1000, contraste: Math.round(depois / (antes + gMax * 0.02) * 100) / 100, forca: Math.round(forca * 100) / 100 });
    });
    cand.sort(function (p, q2) { return q2.contraste - p.contraste; });
    var drops = [];
    cand.forEach(function (c) {
      if (drops.length < 6 && drops.every(function (d) { return Math.abs(d.t - c.t) > 20; })) drops.push(c);
    });
    drops.sort(function (p, q2) { return p.t - q2.t; });
    drops.forEach(function (d) {
      // de 0,1 s antes da batida (o musica.js ia de 1 s antes: com a grade presa aos golpes, pegava um kick da subida)
      for (var i = Math.max(0, Math.floor((d.t - 0.1) / h50)); i < Math.min(g50.length, Math.floor((d.t + 1.5) / h50)); i += 1) {
        if (g50[i] > gMax * 0.6) { d.exato = attack(grave, sr, i * h50); break; }
      }
    });
    var partes = [], len = found.bpm ? 16 * 60 / found.bpm : 8;
    for (var a = 0; a < dur; a += len) {
      var b = Math.min(dur, a + len);
      partes.push({ a: Math.round(a * 10) / 10, b: Math.round(b * 10) / 10, nivel: fMax ? Math.round(fm(a, b) / fMax * 100) / 100 : 0, grave: gMax ? Math.round(gm(a, b) / gMax * 100) / 100 : 0 });
    }
    return { dur: Math.round(dur * 1000) / 1000, bpm: found.bpm, beats: beats, drops: drops, partes: partes };
  }

  // Começo do golpe perto de `t` (s): o pico do grave de t-50 a t+100 ms; o nível de antes (150 a 50 ms antes do pico);
  // a 1ª amostra que passa de 25% entre os dois, a partir de 50 ms antes do pico.
  function attack(grave, sr, t) {
    var at = function (s) { return Math.max(0, Math.min(grave.length - 1, Math.round(s * sr))); };
    var p = at(t - 0.05), peak = 0;
    for (var i = at(t - 0.05); i <= at(t + 0.1); i += 1) if (Math.abs(grave[i]) > peak) { peak = Math.abs(grave[i]); p = i; }
    var base = 0;
    for (i = at(p / sr - 0.15); i < at(p / sr - 0.05); i += 1) base = Math.max(base, Math.abs(grave[i]));
    var th = base + 0.25 * (peak - base);
    for (i = at(p / sr - 0.05); i < p; i += 1) if (Math.abs(grave[i]) > th) break;
    return Math.round(i / sr * 1000) / 1000;
  }

  function placeDrop(music, o) {
    var ok = music.drops.filter(function (d) {
      return d.exato != null && d.contraste >= CLEAR && music.dur - (d.exato - o.at) >= o.seconds;
    });
    if (!ok.length) return null;
    var best = ok.reduce(function (x, y) { return y.contraste > x.contraste ? y : x; });
    return { start: Math.round((best.exato - o.at) * 1000) / 1000, drop: best };
  }

  return { analyzeMusic: analyzeMusic, placeDrop: placeDrop, CLEAR: CLEAR };
});
