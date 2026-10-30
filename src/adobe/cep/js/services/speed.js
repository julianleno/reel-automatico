/**
 * Acelerar a fala (pedido do Jota, 19/10/2026): faz uma cópia do vídeo ou do áudio mais rápida,
 * com a voz no mesmo tom, como o "mudar velocidade" do mp3cut. O Premiere não deixa script mudar a
 * velocidade de um clipe (não há API para isso), então a cópia sai do ffmpeg do app:
 * atempo no áudio (muda o andamento, mantém o tom) e setpts + fps no vídeo (quadros constantes, que
 * o Premiere prefere).
 *
 * Este ffmpeg não tem x264: o vídeo vai pela NVIDIA, depois pelo encoder do Windows (Media
 * Foundation, que usa a placa por baixo), AMF/QSV direto e, por último, o OpenH264. Quem não existe
 * falha logo e passa para o próximo. Medido em 19/10/2026 (RX 580, 8 s de iPhone HEVC 10 bits):
 * Media Foundation 2,0 s, OpenH264 3,6 s, AMF direto 11 a 22 s (a AMF recebendo quadros da CPU é
 * lenta); a qualidade dos três é a mesma (SSIM 0,987 a 0,989).
 *
 * Global no painel: AppLegendasSpeed. No Node (testes): module.exports.
 */
(function (root, factory) {
  if (typeof window === "undefined" && typeof module === "object" && module.exports) {
    module.exports = factory(require);
  } else {
    var nodeRequire = (root.cep_node && root.cep_node.require) || (typeof require === "function" ? require : null);
    root.AppLegendasSpeed = factory(nodeRequire);
  }
})(typeof self !== "undefined" ? self : this, function (nodeRequire) {
  var SPEEDS = [1.1, 1.2, 1.25, 1.3, 1.5, 2];
  var ENCODERS = ["h264_nvenc", "h264_mf", "h264_amf", "h264_qsv", "libopenh264"];
  var AUDIO_EXT = /\.(wav|mp3|m4a|aac|ogg|opus|flac|aif|aiff|wma)$/i;

  var current = null;
  var cancelled = false;

  function node(name) {
    if (!nodeRequire) throw new Error("Node indisponível no painel.");
    return nodeRequire(name);
  }

  // 1,25 -> "1.25x"; 2 -> "2x"
  function label(speed) {
    return String(Math.round(speed * 100) / 100) + "x";
  }

  function isAudioFile(file) {
    return AUDIO_EXT.test(String(file));
  }

  // "D:/brutos/fala.MOV", 1.25 -> "fala 1.25x.mp4" (áudio sai em .wav, sem perder nada);
  // suffix separa trechos do mesmo arquivo: "fala 1.25x (2).mp4"
  function outputName(input, speed, suffix) {
    var base = String(input).replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
    return base + " " + label(speed) + (suffix || "") + (isAudioFile(input) ? ".wav" : ".mp4");
  }

  // "x.mp4" já existe -> "x 2.mp4", "x 3.mp4"...
  function freeName(fs, file) {
    if (!fs.existsSync(file)) return file;
    var dot = file.lastIndexOf(".");
    for (var n = 2; n < 1000; n += 1) {
      var next = file.slice(0, dot) + " " + n + file.slice(dot);
      if (!fs.existsSync(next)) return next;
    }
    return file;
  }

  // O atempo antigo só aceita 0,5 a 2 por filtro; acima disso, em cadeia (2 × 1,25 = 2,5).
  function atempoChain(speed) {
    var parts = [];
    var left = speed;
    while (left > 2 + 1e-9) {
      parts.push("atempo=2");
      left /= 2;
    }
    parts.push("atempo=" + Number(left.toFixed(6)));
    return parts.join(",");
  }

  // O que o "ffmpeg -i arquivo" escreve no stderr: duração, quadros/s, bitrate, se tem vídeo/áudio.
  function parseProbe(text) {
    var out = { duration: 0, fps: 0, videoKbps: 0, totalKbps: 0, hasVideo: false, hasAudio: false };
    var d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
    if (d) out.duration = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);
    var total = /Duration:[^\n]*bitrate:\s*(\d+)\s*kb\/s/.exec(text);
    if (total) out.totalKbps = Number(total[1]);
    var lines = String(text).split(/\r?\n/);
    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i];
      if (!/Stream #/.test(line)) continue;
      if (/Video:/.test(line) && !/attached pic|mjpeg|png/i.test(line) && !out.hasVideo) {
        out.hasVideo = true;
        var f = /([\d.]+)\s*fps/.exec(line) || /([\d.]+)\s*tbr/.exec(line);
        if (f) out.fps = Number(f[1]);
        var b = /(\d+)\s*kb\/s/.exec(line);
        if (b) out.videoKbps = Number(b[1]);
      }
      if (/Audio:/.test(line)) out.hasAudio = true;
    }
    return out;
  }

  // Bitrate do vídeo de saída: o do original (a densidade de imagem por segundo é a mesma), sem
  // cair abaixo de 4 Mb/s, que fica feio em 1080p com encoder de placa.
  function videoKbps(probe) {
    var src = probe.videoKbps || (probe.totalKbps ? probe.totalKbps - 256 : 0);
    // piso de 4 Mb/s: o de 8 deixava o Reel exportado (4,4 Mb/s) maior acelerado (fx-3, 19/10)
    return Math.max(4000, Math.min(60000, Math.round(src || 16000)));
  }

  function buildArgs(options) {
    var speed = Number(options.speed);
    var probe = options.probe || {};
    var args = ["-hide_banner", "-y", "-nostdin"];
    // só o trecho que o clipe usa na timeline (In/Out do clipe), lido direto do arquivo
    if (options.start > 0) args.push("-ss", String(Number(options.start).toFixed(3)));
    if (options.duration > 0) args.push("-t", String(Number(options.duration).toFixed(3)));
    args.push("-i", options.input);
    if (probe.hasVideo && !isAudioFile(options.input)) {
      var fps = probe.fps > 0 && probe.fps <= 120 ? probe.fps : 30;
      var kbps = videoKbps(probe);
      args.push("-map", "0:v:0", "-filter:v", "setpts=PTS/" + speed + ",fps=" + fps);
      args.push("-c:v", options.encoder || ENCODERS[0], "-b:v", kbps + "k", "-maxrate", Math.round(kbps * 1.5) + "k",
        "-bufsize", kbps * 2 + "k", "-pix_fmt", "yuv420p");
      if (probe.hasAudio) args.push("-map", "0:a:0?", "-filter:a", atempoChain(speed), "-c:a", "aac", "-b:a", "256k", "-ar", "48000");
      args.push("-movflags", "+faststart");
    } else {
      args.push("-map", "0:a:0", "-filter:a", atempoChain(speed), "-c:a", "pcm_s16le", "-ar", "48000");
    }
    args.push("-progress", "pipe:1", "-nostats", options.output);
    return args;
  }

  function run(command, args, onStdout) {
    return new Promise(function (resolve, reject) {
      var child;
      try {
        child = node("child_process").spawn(command, args, { windowsHide: true });
      } catch (e) {
        reject(e);
        return;
      }
      current = child;
      var err = "";
      child.stdout.on("data", function (chunk) {
        if (onStdout) onStdout(chunk.toString("utf8"));
      });
      // o probe precisa do texto inteiro: vídeo de iPhone escreve kB de metadados antes da duração
      child.stderr.on("data", function (chunk) {
        err = (err + chunk.toString("utf8")).slice(-65536);
      });
      child.on("error", function (e) {
        current = null;
        reject(e);
      });
      child.on("close", function (code) {
        current = null;
        resolve({ code: code, stderr: err });
      });
    });
  }

  async function probe(ffmpegPath, input) {
    var r = await run(ffmpegPath, ["-hide_banner", "-nostdin", "-i", input]);
    var p = parseProbe(r.stderr);
    if (!p.hasVideo && !p.hasAudio) throw new Error("O ffmpeg não leu o arquivo: " + input);
    return p;
  }

  // a última linha que explica o erro do ffmpeg
  function lastError(stderr) {
    var lines = String(stderr).split(/\r?\n/).filter(function (l) { return l.trim(); });
    return lines.length ? lines[lines.length - 1].trim() : "";
  }

  /**
   * options: { ffmpegPath, input, outDir, speed, onProgress(fraction), start, duration, suffix }
   * start/duration: só esse trecho do arquivo (segundos). -> { path, encoder, seconds }
   * (seconds = duração da cópia)
   */
  async function speedUp(options) {
    var speed = Number(options.speed);
    if (!(speed > 1 && speed <= 4)) throw new Error("Velocidade fora do intervalo (1,1× a 4×).");
    cancelled = false;
    var path = node("path");
    var fs = node("fs");
    fs.mkdirSync(options.outDir, { recursive: true });
    // Nome livre: rodar de novo não pode sobrescrever (nem travar em) uma cópia que outra sequência
    // usa e o Premiere deixa aberta ("Permission denied" no 2º clique; fx-3, 19/10).
    var output = freeName(fs, path.join(options.outDir, outputName(options.input, speed, options.suffix)));
    var info = await probe(options.ffmpegPath, options.input);
    var avail = Math.max(0, info.duration - (options.start || 0)); // do início pedido até o fim do arquivo
    var source = options.duration > 0 ? (avail ? Math.min(options.duration, avail) : options.duration) : avail;
    var target = source > 0 ? source / speed : 0;
    var onOut = function (text) {
      var m = /out_time_(?:us|ms)=(\d+)/g;
      var last = null;
      var hit;
      while ((hit = m.exec(text))) last = hit;
      if (last && target && options.onProgress) options.onProgress(Math.min(1, Number(last[1]) / 1e6 / target));
    };
    var video = info.hasVideo && !isAudioFile(options.input);
    var tries = video ? ENCODERS : [null];
    var failures = [];
    for (var i = 0; i < tries.length; i += 1) {
      var r = await run(options.ffmpegPath, buildArgs({ input: options.input, output: output, speed: speed, probe: info, encoder: tries[i], start: options.start, duration: options.duration }), onOut);
      if (cancelled) {
        try { fs.unlinkSync(output); } catch (e) { /* nada a apagar */ }
        throw new Error("Cancelado.");
      }
      if (r.code === 0) return { path: output, encoder: tries[i] || "pcm", seconds: target };
      failures.push((tries[i] || "áudio") + ": " + lastError(r.stderr));
    }
    try { fs.unlinkSync(output); } catch (e2) { /* nada a apagar */ }
    throw new Error("O ffmpeg não conseguiu acelerar. " + failures.join(" | "));
  }

  function cancel() {
    cancelled = true;
    if (current) {
      try { current.kill(); } catch (e) { /* já terminou */ }
    }
  }

  return {
    SPEEDS: SPEEDS,
    ENCODERS: ENCODERS,
    label: label,
    isAudioFile: isAudioFile,
    outputName: outputName,
    atempoChain: atempoChain,
    parseProbe: parseProbe,
    buildArgs: buildArgs,
    speedUp: speedUp,
    cancel: cancel,
  };
});
