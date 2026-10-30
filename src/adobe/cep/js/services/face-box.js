/**
 * Onde está o rosto no quadro que vai para a IA junto com a cena "com a pessoa": o FaceDetector do
 * Chromium do Premiere (CEF 99 com --enable-experimental-web-platform-features; ~100 ms num quadro
 * de 360 px) mede a caixa e a IA recebe a área em px para deixar livre, além de ver a imagem.
 *
 * Sem o detector, ou sem rosto, devolve null e a IA fica só com a imagem (como antes).
 *
 * Global no painel: AppLegendasFaceBox. No Node (testes): module.exports.
 */
(function (root, factory) {
  if (typeof window === "undefined" && typeof module === "object" && module.exports) module.exports = factory();
  else root.AppLegendasFaceBox = factory();
})(typeof self !== "undefined" ? self : this, function () {
  var MIN_SHARE = 0.15; // caixa com menos de 15% da área da maior é engano (mão, estampa da camiseta)
  var MIN_SIDE = 0.03; // rosto com menos de 3% da largura do quadro não muda nada na cena

  function round(n) {
    return Math.round(n * 1000) / 1000;
  }

  /**
   * O rosto principal em fração do quadro: { x, y, w, h } (canto de cima à esquerda, 0 a 1), ou null.
   * faces: o que o FaceDetector devolve ({ boundingBox: { x, y, width, height } } em px da imagem).
   */
  function pick(faces, width, height) {
    if (!(width > 0 && height > 0) || !faces || !faces.length) return null;
    var boxes = [];
    for (var i = 0; i < faces.length; i += 1) {
      var b = faces[i] && faces[i].boundingBox ? faces[i].boundingBox : faces[i];
      var bx = Number(b && b.x), by = Number(b && b.y);
      // a parte da caixa que fica dentro do quadro
      var x = Math.max(0, bx), y = Math.max(0, by);
      var w = Math.min(width, bx + Number(b && b.width)) - x, h = Math.min(height, by + Number(b && b.height)) - y;
      if (isFinite(x) && isFinite(y) && w > 0 && h > 0) boxes.push({ x: x, y: y, w: w, h: h, area: w * h });
    }
    if (!boxes.length) return null;
    boxes.sort(function (a, c) { return c.area - a.area; });
    var main = boxes[0];
    if (main.w / width < MIN_SIDE) return null;
    // duas pessoas de tamanho parecido: a área livre cobre as duas
    var x0 = main.x, y0 = main.y, x1 = main.x + main.w, y1 = main.y + main.h;
    for (var k = 1; k < boxes.length; k += 1) {
      if (boxes[k].area < main.area * MIN_SHARE) break;
      x0 = Math.min(x0, boxes[k].x);
      y0 = Math.min(y0, boxes[k].y);
      x1 = Math.max(x1, boxes[k].x + boxes[k].w);
      y1 = Math.max(y1, boxes[k].y + boxes[k].h);
    }
    var out = { x: round(x0 / width), y: round(y0 / height), w: round((x1 - x0) / width), h: round((y1 - y0) / height) };
    // para enquadrar uma pessoa, o maior rosto sozinho: com duas lado a lado, o meio da área livre é o vão entre
    // elas (podcast30 em pé: a faixa preta do meio, fx-3 no Premiere real)
    if (out.w > round(main.w / width) || out.h > round(main.h / height)) out.main = { x: round(main.x / width), y: round(main.y / height), w: round(main.w / width), h: round(main.h / height) };
    return out;
  }

  var DETECT_MS = 3000; // no Chrome headless (tempo virtual) o decode() da imagem nunca responde

  // O detector num worker: no Premiere real (20/10, Reel automático) o painel inteiro parou para sempre no
  // meio dos detect() da legenda que desvia do rosto (o fio do painel esperando, 0% de CPU, nem o tempo-limite
  // rodava). No worker, um detector preso prende só o worker: o tempo-limite vale, ele é trocado e segue sem rosto.
  var WORKER_SOURCE = [
    "self.onmessage = async function (e) {",
    "  var d = e.data;",
    "  if (d.hello) return self.postMessage({ hello: typeof FaceDetector === 'function' && typeof createImageBitmap === 'function' });",
    "  try {",
    "    var bmp = await createImageBitmap(new Blob([d.bytes]));",
    "    var faces = await new FaceDetector({ fastMode: false, maxDetectedFaces: 4 }).detect(bmp);",
    "    self.postMessage({ id: d.id, width: bmp.width, height: bmp.height, faces: faces.map(function (f) { var b = f.boundingBox; return { x: b.x, y: b.y, width: b.width, height: b.height }; }) });",
    "    bmp.close();",
    "  } catch (err) { self.postMessage({ id: d.id, error: String(err) }); }",
    "};",
  ].join("\n");

  var pool = null; // Promise do worker ({ w, pending, next }) ou de null (sem detector no worker: fio do painel)
  var live = null; // o worker que o pool entregou, até cair

  function detectorWorker() {
    if (pool) return pool;
    pool = new Promise(function (resolve) {
      var w;
      try {
        w = new Worker(URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" })));
      } catch (e) {
        return resolve(null);
      }
      var timer = setTimeout(function () { w.terminate(); resolve(null); }, 5000);
      w.onerror = function () { clearTimeout(timer); w.terminate(); resolve(null); };
      w.onmessage = function (e) {
        clearTimeout(timer);
        if (!e.data || !e.data.hello) { w.terminate(); return resolve(null); }
        var me = { w: w, pending: {}, next: 0 };
        w.onmessage = function (m) {
          var done = me.pending[m.data.id];
          delete me.pending[m.data.id];
          if (done) done(m.data.error ? null : m.data);
        };
        w.onerror = function () { drop(me); };
        live = me;
        resolve(me);
      };
      w.postMessage({ hello: true });
    });
    return pool;
  }

  // worker preso ou que caiu: o que esperava por ele fica sem rosto e o próximo detect abre outro
  function drop(me) {
    me.w.terminate();
    var waiting = me.pending;
    me.pending = {};
    Object.keys(waiting).forEach(function (id) { waiting[id](null); });
    if (live === me) {
      live = null;
      pool = null;
    }
  }

  // os bytes do quadro: file:///caminho?tempo (como os chamadores montam) ou data:...;base64
  function frameBytes(url) {
    var s = String(url);
    if (/^data:[^,]*;base64,/.test(s)) {
      var bin = atob(s.slice(s.indexOf(",") + 1)), out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
      return out;
    }
    var fs = nodeReq()("fs"), file = s.replace(/^file:\/\/\//, "").replace(/\?.*$/, "");
    // o img.src que a capa passa vem codificado ("App%20Legendas"): sem decodificar, a capa nunca achava o rosto
    if (!fs.existsSync(file)) file = decodeURIComponent(file);
    return new Uint8Array(fs.readFileSync(file));
  }

  /** Mede o rosto num quadro (file:/// ou data: URL). Nunca lança nem trava: sem detector, imagem ruim, erro ou demora, null. */
  function detect(dataUrl, timeoutMs) {
    if (typeof FaceDetector !== "function" || typeof Image !== "function" || !dataUrl) return Promise.resolve(null);
    var ms = timeoutMs || DETECT_MS;
    return detectorWorker().then(function (me) {
      if (!me) return mainDetect(dataUrl, ms);
      if (me !== live) return detect(dataUrl, ms); // caiu enquanto este pedido esperava: o próximo worker
      var bytes;
      try {
        bytes = frameBytes(dataUrl);
      } catch (e) {
        return null; // o quadro não abriu
      }
      return new Promise(function (resolve) {
        var id = me.next++;
        var timer = setTimeout(function () { if (me.pending[id]) drop(me); }, ms);
        me.pending[id] = function (r) {
          clearTimeout(timer);
          resolve(r ? pick(r.faces, r.width, r.height) : null);
        };
        me.w.postMessage({ id: id, bytes: bytes }, [bytes.buffer]);
      });
    });
  }

  // sem detector no worker (Chromium mais velho): no fio do painel, como antes
  function mainDetect(dataUrl, timeoutMs) {
    var timer = null;
    var late = new Promise(function (resolve) { timer = setTimeout(function () { resolve(null); }, timeoutMs); });
    var work = (async function () {
      var img = new Image();
      img.src = dataUrl;
      await img.decode();
      var faces = await new FaceDetector({ fastMode: false, maxDetectedFaces: 4 }).detect(img);
      return pick(faces, img.naturalWidth, img.naturalHeight);
    })().catch(function () { return null; });
    return Promise.race([work, late]).then(function (r) { clearTimeout(timer); return r; });
  }

  function nodeReq() {
    return (typeof window !== "undefined" && window.cep_node && window.cep_node.require) || (typeof require === "function" ? require : null);
  }

  // quadros por chamada do ffmpeg: o ganho é não abrir um processo por quadro; cada entrada abre um
  // decodificador, então lotes menores poupam memória em 4K HEVC (e a linha de comando do Windows tem limite)
  var FRAME_BATCH = 12;
  var GRAB_LANES = 3; // ffmpegs ao mesmo tempo no grabFrames

  /**
   * A linha do ffmpeg que tira vários quadros de um vídeo de uma vez: cada instante é uma entrada com
   * busca rápida (-ss antes do -i: pula direto para o quadro-chave) e cada uma vira um JPEG. Bem mais
   * rápido que um ffmpeg por quadro e, em vídeo longo com instantes espalhados, que um filtro select
   * (que decodifica o vídeo inteiro). o: { path, seconds:[...], outputs:[...], width (px, padrão 720) }
   */
  function grabFramesArgs(o) {
    var args = ["-hide_banner", "-v", "error", "-y"];
    var w = Math.max(16, Math.round(Number(o.width) || 720));
    o.seconds.forEach(function (t) { args.push("-ss", Math.max(0, Number(t) || 0).toFixed(3), "-i", o.path); });
    o.seconds.forEach(function (t, i) { args.push("-map", i + ":v:0", "-frames:v", "1", "-vf", "scale='min(" + w + ",iw)':-2", "-q:v", "4", o.outputs[i]); });
    return args;
  }

  /**
   * Quadros de um vídeo nos instantes pedidos, em JPEGs temporários (quem chama apaga).
   * o: { ffmpegPath, path, seconds:[...], width?, dir? } -> [caminho | null] na mesma ordem.
   * Um lote que falha (um instante depois do fim, por exemplo) refaz só os que faltaram, um por vez.
   */
  async function grabFrames(o) {
    var req = nodeReq();
    if (!req || !o || !o.ffmpegPath || !o.path || !o.seconds || !o.seconds.length) return (o && o.seconds ? o.seconds : []).map(function () { return null; });
    var dir = String(o.dir || req("os").tmpdir()).replace(/\\/g, "/");
    var tag = Date.now() + "-" + Math.round(Math.random() * 1e6);
    var outs = o.seconds.map(function (t, i) { return dir + "/realfx-quadro-" + tag + "-" + i + ".jpg"; });
    var run = function (seconds, outputs) {
      return new Promise(function (resolve) {
        req("child_process").execFile(o.ffmpegPath, grabFramesArgs({ path: o.path, seconds: seconds, outputs: outputs, width: o.width }),
          { windowsHide: true, timeout: 120000 }, function (err) { resolve(!err); });
      });
    };
    var made = function (p) { try { return req("fs").statSync(p).size > 0; } catch (e) { return false; } };
    var batches = [];
    for (var b = 0; b < outs.length; b += FRAME_BATCH) {
      var idx = [];
      for (var i = b; i < Math.min(outs.length, b + FRAME_BATCH); i += 1) idx.push(i);
      batches.push(idx);
    }
    var batch = async function (idx) {
      await run(idx.map(function (k) { return o.seconds[k]; }), idx.map(function (k) { return outs[k]; }));
      for (var j = 0; j < idx.length; j += 1) {
        if (!made(outs[idx[j]])) await run([o.seconds[idx[j]]], [outs[idx[j]]]);
      }
    };
    // lotes em paralelo (cada ffmpeg passa a maior parte do tempo buscando no arquivo): 60 quadros de um vídeo
    // de 1:30 saíam em ~9 s um lote atrás do outro
    var nextBatch = 0;
    var lane = async function () { while (nextBatch < batches.length) await batch(batches[nextBatch++]); };
    var lanes = [];
    for (var l = 0; l < Math.min(GRAB_LANES, batches.length); l += 1) lanes.push(lane());
    await Promise.all(lanes);
    // o que saiu vazio (instante depois do fim) não fica no %TEMP%
    outs.forEach(function (p) { if (!made(p)) { try { req("fs").unlinkSync(p); } catch (e) { /* não existe */ } } });
    return outs.map(function (p) { return made(p) ? p : null; });
  }

  /** Apaga os JPEGs do grabFrames (os nulls são ignorados). */
  function dropFrames(paths) {
    var req = nodeReq();
    (paths || []).forEach(function (p) { if (p && req) { try { req("fs").unlinkSync(p); } catch (e) { /* já saiu */ } } });
  }

  /**
   * O rosto em vários instantes de um vídeo: um ffmpeg para os quadros (grabFrames), um para o tamanho
   * da mídia e o detect() em cada quadro. o: { ffmpegPath, path, seconds:[...], timeoutMs? (por quadro; 3 s) }
   * -> [{ x, y, w, h (fração do quadro), width, height (px da mídia) } | null] na mesma ordem. Nunca lança.
   */
  async function detectInVideoMany(o) {
    var req = nodeReq();
    var none = (o && o.seconds ? o.seconds : []).map(function () { return null; });
    if (!req || !o || !o.ffmpegPath || !o.path) return none;
    var frames = [], ahead = null;
    try {
      // o tamanho da mídia de verdade (os quadros saem reduzidos a 720 px de largura)
      var probe = await new Promise(function (resolve) {
        req("child_process").execFile(o.ffmpegPath, ["-hide_banner", "-i", o.path], { windowsHide: true, timeout: 15000 }, function (err, out, errText) { resolve(String(errText || "")); });
      });
      // o mesmo leitor do recorte (services/person-matte.js), que já conta a rotação do celular
      var size = typeof window !== "undefined" && window.AppLegendasPersonMatte ? window.AppLegendasPersonMatte.videoSize(probe) : null;
      if (!size) return none;
      // em blocos: enquanto o detector olha um bloco, o ffmpeg já tira o próximo (60 legendas de um vídeo de
      // 1:30: ~13 s com uma etapa depois da outra)
      var step = FRAME_BATCH * GRAB_LANES, out = [];
      var grab = function (from) { return grabFrames({ ffmpegPath: o.ffmpegPath, path: o.path, seconds: o.seconds.slice(from, from + step) }); };
      ahead = grab(0);
      for (var from = 0; from < o.seconds.length; from += step) {
        var chunk = await ahead;
        frames = frames.concat(chunk);
        ahead = from + step < o.seconds.length ? grab(from + step) : null;
        // 3 detecções ao mesmo tempo (o FaceDetector é assíncrono): 60 quadros em ~1,3 s em vez de ~4 s
        var faces = new Array(chunk.length), k = 0;
        var lane = async function () {
          while (k < chunk.length) {
            var at = k++;
            faces[at] = chunk[at] ? await detect("file:///" + chunk[at] + "?" + Date.now(), o.timeoutMs) : null;
          }
        };
        await Promise.all([lane(), lane(), lane()]);
        faces.forEach(function (face) {
          out.push(face ? { x: face.x, y: face.y, w: face.w, h: face.h, main: face.main, width: size.width, height: size.height } : null);
        });
      }
      return out;
    } catch (e) {
      return none;
    } finally {
      dropFrames(frames);
      if (ahead) ahead.then(dropFrames); // um bloco que ainda estava saindo quando deu erro
    }
  }

  /** O rosto num instante de um vídeo (detectInVideoMany com um instante só). o: { ffmpegPath, path, seconds } */
  async function detectInVideo(o) {
    var r = await detectInVideoMany({ ffmpegPath: o && o.ffmpegPath, path: o && o.path, seconds: [o ? o.seconds : 0] });
    return r[0] || null;
  }

  /**
   * A escala de verdade da mídia na tela (fração). Com "Ajustar ao tamanho do quadro" (ou a escala padrão de
   * mídia do projeto) o Premiere mostra a Escala em 100% com a mídia já encaixada no quadro, e o script não tem
   * como ler esse estado (Adobe: "no API to get that state"). Mídia bem maior que a sequência (4K em 1080) a
   * exatamente 100% é quase sempre isso; o zoom de propósito a 100% num 4K é raro. Aí vale o encaixe.
   */
  function effectiveScale(mediaW, mediaH, seqW, seqH, scalePct) {
    var pct = Number(scalePct) || 100;
    if (Math.abs(pct - 100) < 0.01 && mediaW >= seqW * 1.4 && mediaH >= seqH * 1.4) return Math.min(seqW / mediaW, seqH / mediaH);
    return pct / 100;
  }

  /**
   * O rosto em fração da MÍDIA para fração da SEQUÊNCIA, pelo Movimento do clipe: cada ponto f da mídia vai
   * para posição + (f - âncora) x escala x (lado da mídia / lado da sequência). Sem posição e âncora, o
   * padrão (0,5 e 0,5). Bruto deitado numa sequência em pé, por exemplo, fica numa faixa do meio; o seguir
   * quem fala mexe na âncora. A parte fora da tela é cortada; null se nada do rosto fica na tela.
   * face { x, y, w, h }; media { width, height, scale (%), position? [x, y], anchor? [x, y] }; seq { width, height }
   */
  function toSequence(face, media, seq) {
    if (!face || !media || !seq || !(media.width > 0) || !(seq.width > 0)) return null;
    var k = effectiveScale(media.width, media.height, seq.width, seq.height, media.scale);
    var rx = (media.width / seq.width) * k, ry = (media.height / seq.height) * k;
    var p = media.position || [0.5, 0.5], a = media.anchor || [0.5, 0.5];
    var px = Number(p[0]), py = Number(p[1]), ax = Number(a[0]), ay = Number(a[1]);
    var x0 = Math.max(0, px + (face.x - ax) * rx), x1 = Math.min(1, px + (face.x + face.w - ax) * rx);
    var y0 = Math.max(0, py + (face.y - ay) * ry), y1 = Math.min(1, py + (face.y + face.h - ay) * ry);
    if (!(x1 - x0 > 0.01) || !(y1 - y0 > 0.01)) return null;
    return { x: round(x0), y: round(y0), w: round(x1 - x0), h: round(y1 - y0) };
  }

  var COVER_SHARE = 0.2; // a partir de 20% do rosto coberto vale avisar
  var COVER_SAMPLES = 2; // em pelo menos 2 tempos seguidos (um quadro de passagem não conta)

  /** Os tempos da conferência: a cada 0,2 s, do começo ao fim da cena. */
  function coverTimes(duration) {
    var out = [];
    for (var t = 0; t < Number(duration) - 0.05; t += 0.2) out.push(Math.round(t * 100) / 100);
    return out;
  }

  /**
   * A cena cobre o rosto? samples: [{ t, share }] (o que scene-render devolve em cover()).
   * Devolve null, ou { share (o pior), from, to } do maior trecho seguido acima do limite.
   */
  function verdict(samples) {
    var best = null, run = [];
    function close() {
      if (run.length >= COVER_SAMPLES && (!best || run.length > best.count)) {
        best = { count: run.length, from: run[0].t, to: run[run.length - 1].t, share: Math.max.apply(null, run.map(function (s) { return s.share; })) };
      }
      run = [];
    }
    (samples || []).forEach(function (s) {
      if (Number(s.share) >= COVER_SHARE) run.push({ t: Number(s.t), share: Number(s.share) });
      else close();
    });
    close();
    return best && { share: Math.round(best.share * 100) / 100, from: best.from, to: best.to };
  }

  /** O pedido de ajuste já escrito para o editor (em px da sequência), para ele só confirmar. */
  function adjustText(face, width, height) {
    var px = function (f, size) { return Math.round(f * size); };
    return "Tire os elementos de cima do rosto (de " + px(face.x, width) + " a " + px(face.x + face.w, width) + " px na horizontal e de " +
      px(face.y, height) + " a " + px(face.y + face.h, height) + " px na vertical) e mantenha o resto da cena.";
  }

  return { pick: pick, effectiveScale: effectiveScale, detect: detect, detectInVideo: detectInVideo, detectInVideoMany: detectInVideoMany, grabFrames: grabFrames, grabFramesArgs: grabFramesArgs, dropFrames: dropFrames, FRAME_BATCH: FRAME_BATCH, toSequence: toSequence, coverTimes: coverTimes, verdict: verdict, adjustText: adjustText, MIN_SHARE: MIN_SHARE, COVER_SHARE: COVER_SHARE };
});
