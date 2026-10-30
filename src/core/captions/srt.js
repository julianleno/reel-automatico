/**
 * Parser de SRT independente de Adobe.
 * Funciona no painel CEP (global `AppLegendasCore.parseSrt`) e no Node (module.exports).
 *
 * Saída: { items: CaptionItem[], errors: {block, message}[] }
 * CaptionItem = { index, startMs, endMs, text }
 */
(function (root, factory) {
  // No painel CEP o Node também define `module`; lá o destino é o global do painel.
  if (typeof window === "undefined" && typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.AppLegendasCore = root.AppLegendasCore || {};
    root.AppLegendasCore.parseSrt = factory().parseSrt;
    root.AppLegendasCore.formatTimecode = factory().formatTimecode;
    root.AppLegendasCore.formatSrt = factory().formatSrt;
  }
})(typeof self !== "undefined" ? self : this, function () {
  // Aceita "00:01:02,345", "00:01:02.345" e também "01:02,345" (sem horas).
  var TIMECODE = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
  var TIMELINE = new RegExp(
    "^\\s*" + TIMECODE.source + "\\s*-->\\s*" + TIMECODE.source + "(?:\\s.*)?$",
  );

  function toMs(hh, mm, ss, frac) {
    var ms = Number((frac + "000").slice(0, 3));
    return (Number(hh || 0) * 3600 + Number(mm) * 60 + Number(ss)) * 1000 + ms;
  }

  function normalize(content) {
    return String(content || "")
      .replace(/^﻿/, "")
      .replace(/\r\n?/g, "\n")
      .replace(/ /g, " ");
  }

  function parseSrt(content) {
    var text = normalize(content);
    var items = [];
    var errors = [];

    if (!text.trim()) {
      return { items: items, errors: [{ block: 0, message: "Arquivo vazio." }] };
    }

    var blocks = text.split(/\n[ \t]*\n+/);
    var blockNumber = 0;

    for (var b = 0; b < blocks.length; b += 1) {
      var lines = blocks[b].split("\n");
      // remove linhas vazias nas bordas
      while (lines.length && !lines[0].trim()) lines.shift();
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      if (!lines.length) continue;

      blockNumber += 1;

      var timeLineIndex = -1;
      var match = null;
      for (var i = 0; i < lines.length && i < 3; i += 1) {
        match = lines[i].match(TIMELINE);
        if (match) {
          timeLineIndex = i;
          break;
        }
      }

      if (timeLineIndex < 0) {
        errors.push({ block: blockNumber, message: "Bloco sem linha de tempo (--> ) reconhecível." });
        continue;
      }

      var startMs = toMs(match[1], match[2], match[3], match[4]);
      var endMs = toMs(match[5], match[6], match[7], match[8]);

      if (endMs <= startMs) {
        errors.push({
          block: blockNumber,
          message: "Tempo final deve ser maior que o inicial (" + lines[timeLineIndex].trim() + ").",
        });
        continue;
      }

      var body = lines
        .slice(timeLineIndex + 1)
        .map(function (l) {
          return l.replace(/\s+$/, "");
        })
        .join("\n")
        .trim();

      if (!body) {
        errors.push({ block: blockNumber, message: "Bloco sem texto." });
        continue;
      }

      items.push({ index: blockNumber, startMs: startMs, endMs: endMs, text: body });
    }

    // Garante ordem cronológica (alguns SRTs vêm fora de ordem).
    items.sort(function (a, b) {
      return a.startMs - b.startMs || a.endMs - b.endMs;
    });

    return { items: items, errors: errors };
  }

  function pad(n, w) {
    var s = String(n);
    while (s.length < w) s = "0" + s;
    return s;
  }

  function formatTimecode(ms) {
    ms = Math.max(0, Math.round(ms));
    var h = Math.floor(ms / 3600000);
    var m = Math.floor((ms % 3600000) / 60000);
    var s = Math.floor((ms % 60000) / 1000);
    var f = ms % 1000;
    return pad(h, 2) + ":" + pad(m, 2) + ":" + pad(s, 2) + "," + pad(f, 3);
  }

  /**
   * formatSrt(lines) -> texto .srt (CRLF, como os editores esperam), uma legenda por linha.
   * lines: segmentos ({ inSeconds, outSeconds, text }) ou CaptionItem ({ startMs, endMs, text });
   * linha sem texto ou sem duração fica de fora, e a numeração segue sem buracos.
   */
  function formatSrt(lines) {
    var out = [];
    (lines || []).forEach(function (l) {
      var start = l.startMs !== undefined ? Number(l.startMs) : Number(l.inSeconds) * 1000;
      var end = l.endMs !== undefined ? Number(l.endMs) : Number(l.outSeconds) * 1000;
      var text = String(l.text || "").replace(/\r?\n/g, "\n").trim();
      if (!text || !(end > start)) return;
      out.push(out.length + 1 + "\r\n" + formatTimecode(start) + " --> " + formatTimecode(end) + "\r\n" + text.replace(/\n/g, "\r\n") + "\r\n");
    });
    return out.join("\r\n");
  }

  return { parseSrt: parseSrt, formatTimecode: formatTimecode, formatSrt: formatSrt };
});
