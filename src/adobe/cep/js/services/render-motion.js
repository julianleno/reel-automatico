/** Exporta um clipe com alpha (ProRes 4444 ou Animation, QuickTime RLE): legendas e o Criar Motion. */
(function (root) {
  var nodeRequire = (root.cep_node && root.cep_node.require) || (typeof require === "function" ? require : null);

  // Animation guarda só as linhas que mudam de um quadro para o outro: numa legenda que assenta, 4x menor
  // que o ProRes (1,75 contra 7 MB em 3 s de 1080x1920, 20/10; antes do qscale 9 do ProRes era 5,7x menor
  // e 4,5x mais rápido). ProRes é o padrão até o Animation ser conferido no Premiere real.
  var CODECS = {
    // qscale 9: uma cena de 6 s do Criar Motion cai de 190 para 29 MB (PSNR 58 dB, borda das letras igual a
    // olho nu); o recorte da pessoa, de 370 para 103 MB a cada 10 s (20/10)
    prores: ["-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuva444p10le", "-alpha_bits", "16", "-qscale:v", "9"],
    qtrle: ["-c:v", "qtrle", "-pix_fmt", "argb"],
  };

  function activeAt(segment, seconds) {
    var words = segment.words || [];
    if (!words.length) return { index: -1, ageSeconds: 0 };
    var absolute = segment.inSeconds + seconds;
    var index = absolute < words[0].inSeconds ? -1 : 0;
    for (var i = 1; i < words.length; i += 1) {
      if (absolute >= words[i].inSeconds) index = i;
      else break;
    }
    return { index: index, ageSeconds: index < 0 ? 0 : Math.max(0, absolute - words[index].inSeconds) };
  }

  function fpsOf(value) {
    return Math.max(24, Math.min(60, Math.round(Number(value) || 30)));
  }

  /**
   * Desenha count quadros no canvas (options.draw(i, fps)) e manda cada um ao ffmpeg.
   * options: { ffmpegPath, canvas, count, fps, codec, path, cancel, draw, onFrame, args }. Erro apaga o arquivo.
   * draw pode ser assíncrona e devolver os pixels RGBA do quadro (cena da IA); sem eles, lê o canvas.
   * args troca a linha do ffmpeg inteira (o app sem Premiere põe a legenda por cima do vídeo); ela
   * precisa ler os quadros RGBA de pipe:0 e gravar em options.path.
   */
  async function renderFrames(options) {
    var canvas = options.canvas, count = options.count;
    var fps = fpsOf(options.fps);
    var args = options.args || [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", canvas.width + "x" + canvas.height,
      "-framerate", String(fps), "-i", "pipe:0",
      "-an",
    ].concat(CODECS[options.codec] || CODECS.prores, ["-frames:v", String(count), options.path]);
    var child = nodeRequire("child_process").spawn(options.ffmpegPath, args, { windowsHide: true });
    var stderr = "", failed = null, finished = false;
    child.stderr.on("data", function (chunk) { stderr += String(chunk).slice(-2000); });
    child.on("error", function (err) { failed = err; });
    child.stdin.on("error", function (err) { failed = err; });
    var closed = new Promise(function (resolve) {
      child.on("close", function (code) { finished = true; resolve(code); });
    });
    try {
      for (var i = 0; i < count; i += 1) {
        if (options.cancel && options.cancel()) throw new Error("Renderização cancelada.");
        if (failed || finished) throw failed || new Error(stderr || "ffmpeg encerrou antes do fim do clipe.");
        var drawn = await options.draw(i, fps);
        var pixels = drawn && drawn.length ? drawn : canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
        var buffer = nodeRequire("buffer").Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
        if (!child.stdin.write(buffer)) {
          await new Promise(function (resolve, reject) {
            function cleanup() { child.stdin.removeListener("drain", drained); child.removeListener("close", stopped); }
            function drained() { cleanup(); resolve(); }
            function stopped() { cleanup(); reject(failed || new Error(stderr || "ffmpeg encerrou antes do fim do clipe.")); }
            child.stdin.once("drain", drained);
            child.once("close", stopped);
          });
        }
        if (options.onFrame) options.onFrame(i + 1, count);
        if (i % 5 === 4) await new Promise(function (resolve) { setTimeout(resolve, 0); });
      }
      child.stdin.end();
      var code = await closed;
      if (failed || code !== 0) throw failed || new Error(stderr || "ffmpeg saiu com código " + code);
    } catch (err) {
      if (!finished) child.kill();
      await closed;
      try { nodeRequire("fs").unlinkSync(options.path); } catch (ignored) {}
      throw err;
    }
    return { frames: count, fps: fps };
  }

  function renderSegment(options) {
    var segment = options.segment, canvas = options.canvas, style = options.style;
    var fps = fpsOf(options.fps);
    var words = segment.words.map(function (w) { return w.text; });
    var keys = segment.words.map(function (w) { return !!w.key; });
    var starts = segment.words.map(function (w) { return w.inSeconds - segment.inSeconds; });
    return renderFrames({
      ffmpegPath: options.ffmpegPath, canvas: canvas, fps: fps, codec: options.codec, path: options.path, cancel: options.cancel,
      // A folga ignora o erro de ponto flutuante: um trecho de 23 frames não pode virar 24.
      count: Math.max(1, Math.ceil((segment.outSeconds - segment.inSeconds) * fps - 1e-6)),
      draw: function (i) {
        var active = activeAt(segment, i / fps);
        root.AppLegendasRender.drawFrame(canvas, { words: words, active: active.index, keys: keys, emoji: segment.emoji || "", starts: starts }, style, { ageSeconds: active.ageSeconds, elapsed: i / fps });
      },
    });
  }

  root.AppLegendasMotion = { renderSegment: renderSegment, renderFrames: renderFrames, activeAt: activeAt, CODECS: CODECS };
})(typeof self !== "undefined" ? self : this);
