/**
 * A pessoa recortada do vídeo (efeito "atrás da pessoa" do Criar Motion): o painel lê os quadros do trecho
 * no arquivo da filmagem, recorta a pessoa em cada um com o MediaPipe (selfie segmenter, Apache 2.0, roda em
 * WebAssembly no próprio painel) e grava um MOV com transparência só com ela. Esse MOV entra acima da cena,
 * então o título da cena fica atrás da pessoa. Ver docs/motion-ia-estudo.md §9.
 *
 * O MediaPipe (uns 12 MB) é baixado na primeira vez, com o hash conferido, para a pasta de dados do app.
 *
 * Global no painel: AppLegendasPersonMatte. No Node (testes): module.exports.
 */
(function (root, factory) {
  if (typeof window === "undefined" && typeof module === "object" && module.exports) module.exports = factory(root);
  else root.AppLegendasPersonMatte = factory(root);
})(typeof self !== "undefined" ? self : this, function (root) {
  var nodeRequire = root && ((root.cep_node && root.cep_node.require) || (typeof require === "function" ? require : null));

  var CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/";
  var MODEL = "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite";
  var FILES = [
    { name: "vision_bundle.mjs", url: CDN + "vision_bundle.mjs", size: 155439, sha256: "d885630c297c0b20b1fe86096cb06291c4c8080876f27852e724f24ac603713f" },
    { name: "vision_wasm_internal.js", url: CDN + "wasm/vision_wasm_internal.js", size: 323377, sha256: "e170ee67dd4e16c1a6fcd8840a206687e5a59b22c20e4a902bc445b095454d73" },
    { name: "vision_wasm_internal.wasm", url: CDN + "wasm/vision_wasm_internal.wasm", size: 11756954, sha256: "8da277a733926eacd0474b8704b36742d6ec3231c57a860c5b889dff8f1df886" },
    { name: "selfie_segmenter.tflite", url: MODEL, size: 249537, sha256: "191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b" },
  ];

  var SEG_WIDTH = 256; // a entrada do selfie segmenter é 256x256: mais que isso só gasta tempo

  function sha256File(path) {
    return nodeRequire("crypto").createHash("sha256").update(nodeRequire("fs").readFileSync(path)).digest("hex");
  }

  /** Baixa o que falta (ou veio corrompido) para dir. downloadFile(url, dest, onProgress) é o do painel. */
  async function ensureFiles(dir, downloadFile, onStatus) {
    var fs = nodeRequire("fs");
    fs.mkdirSync(dir, { recursive: true });
    for (var i = 0; i < FILES.length; i += 1) {
      var f = FILES[i], dest = dir + "/" + f.name;
      if (fs.existsSync(dest) && fs.statSync(dest).size === f.size && sha256File(dest) === f.sha256) continue;
      var part = dest + ".part";
      if (onStatus) onStatus("Baixando o recortador (só na primeira vez): " + f.name);
      await downloadFile(f.url, part, function (p) { if (onStatus) onStatus("Baixando o recortador: " + f.name + " " + Math.round(p * 100) + "%"); });
      if (sha256File(part) !== f.sha256) {
        try { fs.unlinkSync(part); } catch (e) {}
        throw new Error("o arquivo " + f.name + " veio diferente do esperado; tente de novo");
      }
      fs.renameSync(part, dest);
    }
    return dir;
  }

  // O recortador dentro de um worker: abre o MediaPipe (import do bundle por blob; o carregador do wasm usa o
  // importScripts do worker) e responde cada quadro com a confiança de ser a pessoa.
  var WORKER_SOURCE = [
    "var seg;",
    "self.onmessage = async function (e) {",
    "  var d = e.data;",
    "  try {",
    "    if (d.init) {",
    "      var vision = await import(d.bundle);",
    "      seg = await vision.ImageSegmenter.createFromOptions({ wasmLoaderPath: d.loader, wasmBinaryPath: d.wasm },",
    "        { baseOptions: { modelAssetBuffer: d.model, delegate: 'CPU' }, runningMode: 'IMAGE', outputConfidenceMasks: true, outputCategoryMask: false });",
    "      self.postMessage({ ready: true });",
    "      return;",
    "    }",
    "    var res = seg.segment(d.image), m = res.confidenceMasks[0];",
    "    var data = Float32Array.from(m.getAsFloat32Array());",
    "    res.confidenceMasks.forEach(function (k) { k.close(); });",
    "    self.postMessage({ id: d.id, width: m.width, height: m.height, data: data }, [data.buffer]);",
    "  } catch (err) { self.postMessage({ id: d.id, error: String((err && err.message) || err) }); }",
    "};",
  ].join("\n");

  /**
   * O recortador em n workers, em paralelo. Neste PC (12 núcleos), 3 workers fazem um quadro a cada 6,7 ms contra
   * 17 a 26 ms no fio do painel; conferido também no Chromium 99 do Premiere 2026 (20/10).
   * -> { maskAsync(imageData) -> Promise<{ width, height, data }>, size, close }
   */
  async function openPool(dir, n) {
    var fs = nodeRequire("fs");
    var blob = function (name, type) { return URL.createObjectURL(new Blob([fs.readFileSync(dir + "/" + name)], { type: type })); };
    var init = { init: true, bundle: blob("vision_bundle.mjs", "text/javascript"), loader: blob("vision_wasm_internal.js", "text/javascript"), wasm: blob("vision_wasm_internal.wasm", "application/wasm") };
    var model = fs.readFileSync(dir + "/selfie_segmenter.tflite");
    var url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
    var workers = [], pending = {}, next = 0;
    var close = function () { workers.forEach(function (w) { w.terminate(); }); };
    try {
      for (var i = 0; i < n; i += 1) {
        workers.push(await new Promise(function (resolve, reject) {
          var w = new Worker(url);
          // um worker que não responde não pode travar o recorte: o painel recorta sozinho
          var timer = setTimeout(function () { w.terminate(); reject(new Error("o recortador não abriu no worker")); }, 30000);
          w.onmessage = function (e) {
            clearTimeout(timer);
            if (!e.data.ready) return reject(new Error(e.data.error || "o recortador não abriu no worker"));
            w.onmessage = function (m) {
              var p = pending[m.data.id];
              delete pending[m.data.id];
              if (p) m.data.error ? p.reject(new Error(m.data.error)) : p.resolve(m.data);
            };
            // worker que cai no meio do recorte: os quadros que esperavam por ele falham, em vez de travar
            w.onerror = function (ev) {
              Object.keys(pending).forEach(function (id) {
                var q = pending[id];
                delete pending[id];
                q.reject(new Error((ev && ev.message) || "o worker do recortador parou"));
              });
            };
            resolve(w);
          };
          w.onerror = function (e) { clearTimeout(timer); reject(new Error(e.message || "erro no worker do recortador")); };
          w.postMessage(Object.assign({ model: new Uint8Array(model) }, init));
        }));
      }
    } catch (e) {
      close();
      throw e;
    }
    return {
      size: n,
      maskAsync: function (image) {
        var id = next++;
        return new Promise(function (resolve, reject) {
          pending[id] = { resolve: resolve, reject: reject };
          workers[id % n].postMessage({ id: id, image: image });
        });
      },
      close: close,
    };
  }

  /**
   * Abre o recortador com os arquivos de dir, por blob (no CEP o wasm não carrega por file://). Com mais de 2 núcleos,
   * em workers (openPool, até 3); sem worker ou se ele não abrir, no fio do painel. opts.workers força o número.
   */
  async function openSegmenter(dir, opts) {
    var cores = (root.navigator && root.navigator.hardwareConcurrency) || 2;
    var n = opts && opts.workers !== undefined ? Number(opts.workers) : Math.min(3, cores - 2);
    if (n > 1 && typeof Worker === "function") {
      try {
        return await openPool(dir, n);
      } catch (e) { /* segue no fio do painel */ }
    }
    var fs = nodeRequire("fs");
    var blob = function (name, type) { return URL.createObjectURL(new Blob([fs.readFileSync(dir + "/" + name)], { type: type })); };
    var vision = await import(blob("vision_bundle.mjs", "text/javascript"));
    var segmenter = await vision.ImageSegmenter.createFromOptions(
      { wasmLoaderPath: blob("vision_wasm_internal.js", "text/javascript"), wasmBinaryPath: blob("vision_wasm_internal.wasm", "application/wasm") },
      { baseOptions: { modelAssetBuffer: new Uint8Array(fs.readFileSync(dir + "/selfie_segmenter.tflite")), delegate: "CPU" }, runningMode: "IMAGE", outputConfidenceMasks: true, outputCategoryMask: false });
    return {
      // ImageData ou ImageBitmap -> { width, height, data: Float32Array } (confiança de 0 a 1 de ser a pessoa)
      mask: function (image) {
        var res = segmenter.segment(image);
        var m = res.confidenceMasks[0];
        var out = { width: m.width, height: m.height, data: Float32Array.from(m.getAsFloat32Array()) };
        res.confidenceMasks.forEach(function (k) { k.close(); });
        return out;
      },
      close: function () { try { segmenter.close(); } catch (e) {} },
    };
  }

  /** Média com o quadro anterior: a borda não treme de um quadro para o outro. keep = peso do anterior. */
  function smoothMask(prev, next, keep) {
    if (!prev || prev.data.length !== next.data.length) return next;
    var k = keep === undefined ? 0.5 : keep;
    for (var i = 0; i < next.data.length; i += 1) next.data[i] = prev.data[i] * k + next.data[i] * (1 - k);
    return next;
  }

  var lutCache = {};
  function alphaTable(a, b) {
    var key = a + ":" + b;
    if (lutCache[key]) return lutCache[key];
    var lut = new Uint8Array(1024);
    for (var i = 0; i < 1024; i += 1) {
      var t = Math.max(0, Math.min(1, (i / 1023 - a) / (b - a)));
      lut[i] = Math.round(255 * t * t * (3 - 2 * t));
    }
    lutCache[key] = lut;
    return lut;
  }

  /**
   * A máscara em tons de cinza (1 byte por pixel, no tamanho dela), com a borda macia: abaixo de lo é fundo,
   * acima de hi é pessoa. Quem estica até o tamanho do vídeo e põe no alfa é o ffmpeg (alphamerge).
   */
  function maskBytes(mask, lo, hi) {
    // a borda macia (smoothstep) em tabela: 1024 degraus bastam para 256 níveis de alfa
    var lut = alphaTable(lo === undefined ? 0.35 : lo, hi === undefined ? 0.65 : hi);
    var md = mask.data, out = new Uint8Array(md.length);
    for (var i = 0; i < md.length; i += 1) { var v = md[i]; out[i] = lut[v <= 0 ? 0 : v >= 1 ? 1023 : (v * 1023 + 0.5) | 0]; }
    return out;
  }

  /** A confiança crua em bytes (0 a 255), sem a borda: o renderCutout aplica a borda (EDGE) depois de esticar. */
  function rawBytes(mask) {
    var md = mask.data, out = new Uint8Array(md.length);
    for (var i = 0; i < md.length; i += 1) { var v = md[i]; out[i] = v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0; }
    return out;
  }

  // A borda macia do maskBytes (smoothstep de 0,35 a 0,65) como filtro do ffmpeg. Aplicada depois de esticar
  // a máscara ao tamanho do vídeo, a borda sai lisa; aplicada nos 256 px e esticada depois, saía em degraus
  // de uns 4 px na manga (conferido em 20/10).
  var EDGE = "lut=y='255*pow(clip((val/255-0.35)/0.3,0,1),2)*(3-2*clip((val/255-0.35)/0.3,0,1))'";

  /** Tamanho de exibição do vídeo pela saída do ffmpeg -i (com a rotação dos celulares). */
  function videoSize(ffmpegText) {
    var m = /Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/.exec(String(ffmpegText || ""));
    if (!m) return null;
    var w = Number(m[1]), h = Number(m[2]);
    var rot = /rotation of (-?\d+(?:\.\d+)?)|rotate\s*:\s*(-?\d+)/.exec(String(ffmpegText));
    var deg = rot ? Math.abs(Math.round(Number(rot[1] || rot[2]))) % 180 : 0;
    return deg === 90 ? { width: h, height: w } : { width: w, height: h };
  }

  /**
   * Lê quadros RGBA de tamanho fixo de um stream (a saída do ffmpeg). next() -> Buffer ou null no fim. Com uns
   * quadros guardados, pausa o stream (o ffmpeg espera): sem isso, um clipe de 30 s ia inteiro para a memória.
   */
  function frameReader(stream, frameBytes) {
    var chunks = [], have = 0, ended = false, failed = null, waiting = null, limit = frameBytes * 4;
    function wake() { if (waiting) { var w = waiting; waiting = null; w(); } }
    stream.on("data", function (c) {
      chunks.push(c);
      have += c.length;
      if (have > limit && stream.pause) stream.pause();
      wake();
    });
    stream.on("end", function () { ended = true; wake(); });
    stream.on("error", function (e) { failed = e; wake(); });
    // copia só os pedaços de um quadro (juntar tudo o que chegou a cada quadro era quadrático)
    function take() {
      var out = Buffer.allocUnsafe(frameBytes), off = 0;
      while (off < frameBytes) {
        var c = chunks[0], need = frameBytes - off;
        if (c.length <= need) {
          c.copy(out, off);
          off += c.length;
          chunks.shift();
        } else {
          c.copy(out, off, 0, need);
          chunks[0] = c.subarray(need);
          off += need;
        }
      }
      have -= frameBytes;
      if (have <= limit && stream.isPaused && stream.isPaused()) stream.resume();
      return out;
    }
    return {
      next: async function () {
        for (;;) {
          if (failed) throw failed;
          if (have >= frameBytes) return take();
          if (ended) return null;
          await new Promise(function (resolve) { waiting = resolve; });
        }
      },
    };
  }

  /**
   * O pedaço da mídia que aparece na sequência, pelo Movimento do clipe (o inverso do toSequence do face-box): o
   * recortador olha só ali e a pessoa ganha pixels. Bruto deitado numa sequência em pé: a pessoa ocupava 80 px dos
   * 256 do recortador e o fundo vazava (PSNR 11 dB contra 39 recortando, 20/10). anchors: as âncoras do trecho (o
   * seguir quem fala anima a âncora), vale a união; scale: a menor do trecho (com zoom, o quadro aberto).
   * size { width, height } da mídia; view { scale, position, anchors:[[x, y]], seqWidth, seqHeight }
   * -> { x, y, w, h } em px pares da mídia, ou null quando aparece quase tudo (nada a ganhar)
   */
  function visibleCrop(size, view) {
    if (!size || !view || !(view.seqWidth > 0) || !(view.seqHeight > 0)) return null;
    var FB = root.AppLegendasFaceBox;
    var k = FB && FB.effectiveScale ? FB.effectiveScale(size.width, size.height, view.seqWidth, view.seqHeight, view.scale) : (Number(view.scale) || 100) / 100;
    var rx = (size.width / view.seqWidth) * k, ry = (size.height / view.seqHeight) * k;
    var p = view.position || [0.5, 0.5], anchors = view.anchors && view.anchors.length ? view.anchors : [[0.5, 0.5]];
    var x0 = 1, x1 = 0, y0 = 1, y1 = 0;
    for (var i = 0; i < anchors.length; i += 1) {
      var ax = Number(anchors[i][0]), ay = Number(anchors[i][1]);
      x0 = Math.min(x0, ax - Number(p[0]) / rx);
      x1 = Math.max(x1, ax + (1 - Number(p[0])) / rx);
      y0 = Math.min(y0, ay - Number(p[1]) / ry);
      y1 = Math.max(y1, ay + (1 - Number(p[1])) / ry);
    }
    // 4% de folga: a borda da pessoa que entra no quadro continua inteira
    x0 = Math.max(0, x0 - 0.04); x1 = Math.min(1, x1 + 0.04); y0 = Math.max(0, y0 - 0.04); y1 = Math.min(1, y1 + 0.04);
    if (!(x1 > x0 && y1 > y0) || (x1 - x0) * (y1 - y0) > 0.8) return null;
    var even = function (v) { return Math.floor(v / 2) * 2; };
    var x = even(x0 * size.width), y = even(y0 * size.height);
    return { x: x, y: y, w: Math.min(size.width - x, even((x1 - x0) * size.width + 1)), h: Math.min(size.height - y, even((y1 - y0) * size.height + 1)) };
  }

  /**
   * O view do visibleCrop a partir do que o host diz do clipe (AL_clipMotion / AL_footageAt) e do tamanho da
   * sequência. Posição animada (o vídeo que anda pela tela): null, o recortador olha o quadro inteiro.
   */
  function viewOf(clip, seqWidth, seqHeight) {
    if (!clip || clip.positionAnimated || !(seqWidth > 0)) return null;
    var keys = clip.anchorKeyed && clip.anchorKeys ? clip.anchorKeys : [];
    return {
      scale: clip.scaleMin || clip.scale, position: clip.position, seqWidth: seqWidth, seqHeight: seqHeight,
      anchors: keys.length ? keys.map(function (k) { return k.value; }) : [clip.anchor],
      // seguir quem fala: cada chave da âncora vale do tempo dela em diante (chaves em "manter")
      spans: keys.length > 1 ? keys.map(function (k, i) { return { from: i ? k.seconds : -Infinity, anchor: k.value }; }) : null,
    };
  }

  /**
   * O pedaço que o recortador olha em cada quadro. Com view.spans ([{ from (segundo da mídia), anchor }], o seguir
   * quem fala), o pedaço acompanha quem está na tela: a união das duas pessoas de um podcast cobria quase o quadro
   * inteiro e a cabeça ficava com uns 20 px no recortador, que perdia o topo dela (20/10, podcast30). O tamanho é o
   * mesmo em todos os trechos (o maior); só a posição muda. o: { fps, sourceSeconds, speed }
   * -> null (quadro inteiro) ou { w, h, steps:[{ n (primeiro quadro), x, y }] }
   */
  function cropPlan(size, view, o) {
    if (!view) return null;
    var spans = view.spans && view.spans.length > 1 ? view.spans : null;
    if (!spans) {
      var c = visibleCrop(size, view);
      return c ? { w: c.w, h: c.h, steps: [{ n: 0, x: c.x, y: c.y }] } : null;
    }
    var crops = spans.map(function (s) {
      var one = {};
      for (var key in view) one[key] = view[key];
      one.anchors = [s.anchor];
      return visibleCrop(size, one);
    });
    if (crops.some(function (c) { return !c; })) return null; // algum trecho mostra quase tudo
    var w = Math.max.apply(null, crops.map(function (c) { return c.w; })), h = Math.max.apply(null, crops.map(function (c) { return c.h; }));
    var even = function (v) { return Math.round(v / 2) * 2; };
    var steps = [];
    spans.forEach(function (s, i) {
      var c = crops[i];
      var n = Math.max(0, Math.ceil(((Number(s.from) - Number(o.sourceSeconds || 0)) / (o.speed || 1)) * o.fps - 1e-6));
      var st = { n: isFinite(n) ? n : 0, x: Math.max(0, Math.min(size.width - w, even(c.x + c.w / 2 - w / 2))), y: Math.max(0, Math.min(size.height - h, even(c.y + c.h / 2 - h / 2))) };
      // trechos que já tinham começado antes do recorte: vale o último deles
      while (steps.length && steps[steps.length - 1].n >= st.n) steps.pop();
      if (!steps.length || steps[steps.length - 1].x !== st.x || steps[steps.length - 1].y !== st.y) steps.push(st);
    });
    steps[0].n = 0;
    return { w: w, h: h, steps: steps };
  }

  // A expressão do ffmpeg que escolhe a posição do pedaço pelo número do quadro (n), para o filtro crop.
  function stepExpr(steps, key) {
    var e = String(steps[steps.length - 1][key]);
    for (var i = steps.length - 2; i >= 0; i -= 1) e = "if(lt(n," + steps[i + 1].n + ")," + steps[i][key] + "," + e + ")";
    return e;
  }

  /**
   * O comum do renderCutout e do renderMask: o tamanho do vídeo, o trecho e a máscara de cada quadro. O recortador
   * trabalha em 256 px: o ffmpeg já entrega o quadro pequeno, e o painel só mexe na máscara.
   * -> { size, fps, count, seek, mw, mh, draw (a máscara do próximo quadro, em bytes de cinza), stop }
   */
  async function maskJob(o, crude) {
    var cp = nodeRequire("child_process");
    var probe = await new Promise(function (resolve) {
      cp.execFile(o.ffmpegPath, ["-hide_banner", "-i", o.mediaPath], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, function (err, out, errText) { resolve(String(errText || "")); });
    });
    var size = videoSize(probe);
    if (!size) throw new Error("não deu para ler o tamanho do vídeo");
    var fps = Math.max(24, Math.min(60, Math.round(Number(o.fps) || 30)));
    // clipe com a velocidade mudada: lê duration x speed da mídia e o setpts põe no tempo da sequência
    var speed = Number(o.speed) > 0 ? Number(o.speed) : 1;
    var seek = ["-ss", String(Math.max(0, o.sourceSeconds)), "-t", String((Number(o.duration) + 1 / fps) * speed), "-i", o.mediaPath];
    var retime = Math.abs(speed - 1) > 1e-3 ? "setpts=(PTS-STARTPTS)/" + speed + "," : "";
    // com o view do clipe, só o pedaço que aparece na sequência (cropPlan; com o seguir quem fala, o de quem está na
    // tela em cada trecho). A máscara de cada quadro volta ao lugar dela no quadro inteiro, na escala da máscara
    var plan = cropPlan(size, o.view, { fps: fps, sourceSeconds: o.sourceSeconds, speed: speed });
    var area = plan || { w: size.width, h: size.height, steps: [{ n: 0, x: 0, y: 0 }] };
    var mw = SEG_WIDTH, mh = Math.round((SEG_WIDTH * area.h) / area.w), r = mw / area.w;
    var fw = plan ? Math.max(mw, Math.round(size.width * r)) : mw, fh = plan ? Math.max(mh, Math.round(size.height * r)) : mh;
    var cropVf = plan ? ",crop=" + plan.w + ":" + plan.h + ":x='" + stepExpr(plan.steps, "x") + "':y='" + stepExpr(plan.steps, "y") + "'" : "";
    // 2 threads: o quadro pequeno é pouco trabalho, e com todas as threads ele disputa a CPU com o ffmpeg que grava o
    // MOV e com os workers (10 s de Reel: ~12 s -> ~9 s; com 1 thread o HEVC de 10 bits do iPhone fica para trás)
    var decoder = cp.spawn(o.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-threads", "2"].concat(seek,
      ["-vf", retime + "fps=" + fps + cropVf + ",scale=" + mw + ":" + mh,
        "-an", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]), { windowsHide: true });
    var reader = frameReader(decoder.stdout, mw * mh * 4);
    var prev = null, last = null, queue = [], ended = false, frame = 0, step = -1;
    // a máscara do pedaço no quadro inteiro (fundo 0); sem pedaço, ela já é o quadro inteiro
    var place = function (bytes) {
      if (!plan) return bytes;
      var s = area.steps[step];
      var ox = Math.min(fw - mw, Math.round(s.x * r)), oy = Math.min(fh - mh, Math.round(s.y * r)), out = new Uint8Array(fw * fh);
      for (var y = 0; y < mh; y += 1) out.set(bytes.subarray(y * mw, (y + 1) * mw), (oy + y) * fw + ox);
      return out;
    };
    return {
      // count para cima: um quadro a menos deixa a legenda aparecer na pessoa no fim do clipe (o host apara o que sobra)
      size: size, crop: plan, fps: fps, retime: retime, count: Math.max(1, Math.ceil(Number(o.duration) * fps - 1e-6)), seek: seek, mw: mw, mh: mh, fw: fw, fh: fh,
      draw: async function () {
        // o trecho deste quadro: quando troca de pessoa, a média com o quadro anterior recomeça (era outro pedaço)
        var at = step;
        while (at + 1 < area.steps.length && area.steps[at + 1].n <= frame) at += 1;
        if (at !== step) { step = at; prev = null; }
        frame += 1;
        var raw;
        if (o.segmenter.maskAsync) {
          // workers: a fila mantém todos ocupados (2 quadros por worker); a média com o anterior continua em ordem
          while (!ended && queue.length < o.segmenter.size * 2) {
            var b = await reader.next();
            if (!b) { ended = true; break; }
            var p = o.segmenter.maskAsync(new ImageData(new Uint8ClampedArray(b.buffer, b.byteOffset, b.byteLength), mw, mh));
            p.catch(function () { /* quem espera por ela recebe o erro */ });
            queue.push(p);
          }
          raw = queue.length ? await queue.shift() : null;
        } else {
          var buf = await reader.next();
          raw = buf ? o.segmenter.mask(new ImageData(new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.byteLength), mw, mh)) : null;
        }
        if (!raw) {
          // o vídeo acabou antes: repete a última máscara
          if (!last) throw new Error("o vídeo não tem quadros nesse trecho");
          return last;
        }
        var mask = smoothMask(prev, raw, 0.5);
        prev = mask;
        last = place(crude ? rawBytes(mask) : maskBytes(mask));
        return last;
      },
      stop: function () { try { decoder.kill(); } catch (e) {} },
    };
  }

  /**
   * Grava o MOV com a pessoa recortada do trecho.
   * o: { ffmpegPath, mediaPath, sourceSeconds, duration, fps, path, segmenter, onFrame, cancel, view, speed }
   *   speed (opcional): a velocidade do clipe (2 = o dobro); duration é na sequência
   *   view (opcional): o Movimento do clipe na sequência, para o recortador olhar só o que aparece (visibleCrop)
   * -> { frames, width, height }
   */
  async function renderCutout(o) {
    var job = await maskJob(o, true), size = job.size, fps = job.fps;
    // a máscara (cinza, do pipe) é esticada e vira o alfa do vídeo inteiro no próprio ffmpeg: no painel, 2 milhões
    // de pixels por quadro custavam uns 135 ms (1080x1920)
    var args = ["-hide_banner", "-loglevel", "error", "-y",
      "-f", "rawvideo", "-pixel_format", "gray", "-video_size", job.fw + "x" + job.fh, "-framerate", String(fps), "-i", "pipe:0"].concat(job.seek, [
      "-filter_complex", "[1:v]" + job.retime + "fps=" + fps + ",scale=" + size.width + ":" + size.height + ",format=rgba,tpad=stop_mode=clone:stop_duration=2[v];" +
        "[0:v]scale=" + size.width + ":" + size.height + ":flags=bicubic," + EDGE + "[a];[v][a]alphamerge[o]",
      // sempre ProRes (com o qscale 9 do CODECS): é a filmagem inteira; 10 s em 1080x1920 ficam com 103 MB
      // (PSNR 53 dB, igual a olho nu); o Animation dava 750 MB
      "-map", "[o]", "-an"]).concat(root.AppLegendasMotion.CODECS.prores, ["-frames:v", String(job.count), o.path]);
    try {
      var done = await root.AppLegendasMotion.renderFrames({
        ffmpegPath: o.ffmpegPath, path: o.path, cancel: o.cancel, onFrame: o.onFrame, fps: fps,
        canvas: { width: job.fw, height: job.fh }, count: job.count, args: args, draw: job.draw,
      });
      return { frames: done.frames, width: size.width, height: size.height };
    } finally {
      job.stop();
    }
  }

  /**
   * Grava só a máscara da pessoa (cinza, 256 px de largura, ffv1 sem perda; uns 3 MB a cada 10 s), para quem
   * monta o vídeo no próprio ffmpeg (o app sem Premiere): esticar até o tamanho da mídia e usar no alphamerge.
   * o: os mesmos do renderCutout, path de preferência .mkv -> { frames, width, height (da mídia), maskWidth, maskHeight, crop }
   * o.matte: em vez da máscara cinza, um MOV branco com o alfa invertido (o fosco do Track Matte Key), path .mov
   * o.raw: a confiança crua, sem a borda; quem usa estica ao tamanho do vídeo e aplica EDGE depois (borda lisa,
   *   em vez de degraus de uns 4 px)
   */
  async function renderMask(o) {
    var job = await maskJob(o, !!o.raw || !!o.matte);
    // com o pedaço (cropPlan), a máscara já vem cobrindo o quadro inteiro (preto fora), na escala dela
    var full = { w: job.fw, h: job.fh };
    var args = ["-hide_banner", "-loglevel", "error", "-y",
      "-f", "rawvideo", "-pixel_format", "gray", "-video_size", full.w + "x" + full.h, "-framerate", String(job.fps), "-i", "pipe:0"].concat(o.matte
      // matte: o fosco para o Track Matte Key do Premiere (docs/ideias-futuras.md): branco, com o alfa invertido
      // (opaco onde NÃO é a pessoa). No modo padrão do efeito (Matte Alpha) a legenda some onde está a pessoa,
      // sem mexer no Composite Using nem no Reverse. Animation (qtrle): sem perda e pequeno numa cor só
      // o fosco sai com o dobro do tamanho da máscara, esticado e com a borda (EDGE) aplicada depois: o Premiere
      // ainda estica mais, e a borda aplicada nos 256 px viraria degraus
      ? ["-filter_complex", "[0:v]scale=" + full.w * 2 + ":" + full.h * 2 + ":flags=bicubic," + EDGE + ",negate[a];color=c=white:s=" +
        full.w * 2 + "x" + full.h * 2 + ":r=" + job.fps + "[c];[c][a]alphamerge,format=argb[o]", "-map", "[o]", "-c:v", "qtrle"]
      : ["-c:v", "ffv1"], ["-frames:v", String(job.count), o.path]);
    try {
      var done = await root.AppLegendasMotion.renderFrames({
        ffmpegPath: o.ffmpegPath, path: o.path, cancel: o.cancel, onFrame: o.onFrame, fps: job.fps,
        canvas: { width: full.w, height: full.h }, count: job.count, args: args, draw: job.draw,
      });
      var k = o.matte ? 2 : 1;
      return { frames: done.frames, width: job.size.width, height: job.size.height, maskWidth: full.w * k, maskHeight: full.h * k, crop: job.crop };
    } finally {
      job.stop();
    }
  }

  /**
   * A linha do ffmpeg do contorno em volta da pessoa, tirado do alfa do recorte, sem IA. O alfa vai a 1/4 do
   * tamanho, é borrado e cortado (engorda uns 30 px), volta ao tamanho e amacia a borda; a pessoa fica por
   * cima, no mesmo MOV. o: { input, output, width, height, fps, color ("#rrggbb"), codec, style }
   * style: "kit" (padrão, adesivo na cor do kit), "papel" (branco com uma sombra macia para baixo e para a
   * direita) ou "rabisco" (uma linha na cor do kit afastada do corpo que treme a cada 3 quadros, doodle boil).
   */
  function outlineArgs(o) {
    var style = o.style === "papel" || o.style === "rabisco" ? o.style : "kit";
    var kit = /^#[0-9a-f]{6}$/i.test(String(o.color || "")) ? "0x" + String(o.color).slice(1).toLowerCase() : "0xffc828";
    var color = style === "papel" ? "0xffffff" : kit;
    var fps = Math.max(24, Math.min(60, Math.round(Number(o.fps) || 30)));
    var w = Math.round(o.width), h = Math.round(o.height);
    var size = ":s=" + w + "x" + h + ":r=" + fps;
    var small = "[m]alphaextract,scale=" + Math.round(w / 4) + ":" + Math.round(h / 4);
    var codec = o.codec === "qtrle" ? ["-c:v", "qtrle", "-pix_fmt", "argb"] : ["-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuva444p10le", "-alpha_bits", "16", "-qscale:v", "9"];
    var filter;
    if (style === "rabisco") {
      // o anel entre duas engordadas do alfa (longe e perto do corpo) é a linha; ela pula uns px a cada 3 quadros
      var j = Math.max(2, Math.round(w / 180));
      filter = "[0]format=rgba,split[p][m];" + small + ",boxblur=10:2,split[b1][b2];" +
        "[b1]lut=y='if(gt(val,6),255,0)'[big];[b2]lut=y='if(gt(val,40),255,0)'[near];" +
        "[big][near]blend=all_mode=difference,scale=" + w + ":" + h + ":flags=bicubic,boxblur=2:1[ring];" +
        "color=c=" + kit + size + "[c];[c][ring]alphamerge[o];color=c=black@0" + size + ",format=rgba[base];" +
        "[base][o]overlay=x='" + j + "*sin(floor(n/3)*2.3)':y='" + j + "*cos(floor(n/3)*1.7)':eval=frame:format=auto:shortest=1[o2];" +
        "[o2][p]overlay=format=auto:shortest=1";
      return ["-hide_banner", "-loglevel", "error", "-y", "-i", o.input, "-filter_complex", filter, "-an"].concat(codec, [o.output]);
    }
    // só o anel de fora: a silhueta engordada menos ela mesma encolhida de volta (um "fechamento": os furos
    // de dentro continuam corpo). Onde o recorte tem furo ou fica meio transparente (a cadeira, o cabelo),
    // aparece o vídeo de baixo e não a cor do contorno vazando
    filter = "[0]format=rgba,split[p][m];" +
      small + ",boxblur=8:2,lut=y='if(gt(val,16),255,0)',split[fat][shut];[shut]boxblur=8:2,lut=y='if(gt(val,239),255,0)'[closed];" +
      "[fat][closed]blend=all_mode=difference,scale=" + w + ":" + h + ":flags=bicubic,boxblur=4:2" + (style === "papel" ? ",split[d][s];" : "[d];") +
      "color=c=" + color + size + "[c];[c][d]alphamerge[o];";
    if (style === "papel") {
      // a sombra: o mesmo contorno em preto, borrado, a 60% e deslocado 18 px para a direita e 24 para baixo (em 1080)
      var dx = Math.round(w / 60), dy = Math.round(w / 45);
      filter += "color=c=black" + size + "[k];[k][s]alphamerge,boxblur=12:1,colorchannelmixer=aa=0.6," +
        "crop=" + (w - dx) + ":" + (h - dy) + ":0:0,pad=" + w + ":" + h + ":" + dx + ":" + dy + ":color=black@0[sh];[sh][o]overlay=format=auto:shortest=1[o2];[o2][p]overlay=format=auto:shortest=1";
    } else {
      filter += "[o][p]overlay=format=auto:shortest=1";
    }
    return ["-hide_banner", "-loglevel", "error", "-y", "-i", o.input, "-filter_complex", filter, "-an"].concat(codec, [o.output]);
  }

  /** Grava o recorte com o contorno (outlineArgs). o: { ffmpegPath, ...outlineArgs } */
  function outlineCutout(o) {
    return new Promise(function (resolve, reject) {
      nodeRequire("child_process").execFile(o.ffmpegPath, outlineArgs(o), { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, function (err, out, errText) {
        if (err) return reject(new Error("o contorno não saiu: " + String(errText || err.message).trim().split("\n").slice(-2).join(" ")));
        resolve(o.output);
      });
    });
  }

  return { FILES: FILES, ensureFiles: ensureFiles, openSegmenter: openSegmenter, smoothMask: smoothMask, maskBytes: maskBytes, rawBytes: rawBytes, EDGE: EDGE, videoSize: videoSize, frameReader: frameReader, renderCutout: renderCutout, renderMask: renderMask, visibleCrop: visibleCrop, cropPlan: cropPlan, viewOf: viewOf, outlineArgs: outlineArgs, outlineCutout: outlineCutout };
});
