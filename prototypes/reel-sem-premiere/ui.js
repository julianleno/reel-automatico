/* global AppLegendasRender */
/**
 * A tela única do estudo (fase 2): solta o vídeo, escolhe o estilo e o que fazer, clica,
 * acompanha as etapas e assiste o Reel pronto. Quem faz o trabalho é o runReel do pipeline.js.
 * A coluna da direita mostra uma vista por vez (#side data-view): opts, run, error, done.
 */
(function () {
  "use strict";
  const { ipcRenderer, shell, webUtils } = require("electron");
  const os = require("os");
  const path = require("path");
  const fs = require("fs");
  const { pathToFileURL } = require("url");
  const $ = (id) => document.getElementById(id);

  // etapas na ordem do pipeline (o nome que o step() manda ao terminar cada uma), o texto da tela e
  // o peso no tempo total: ouvir a fala e gerar o vídeo são quase tudo (README, "Medido")
  const STEPS = [
    ["juntar", "Juntando os vídeos", 6],
    ["leitura", "Abrindo o vídeo", 2],
    ["áudio", "Separando a voz", 5],
    ["transcrição", "Ouvindo a fala", 35],
    ["melhores momentos", "Escolhendo os melhores momentos", 2],
    ["silêncios", "Achando pausas e repetições", 1],
    ["corte", "Planejando os cortes", 3],
    ["legendas", "Montando as legendas", 6],
    ["pessoa recortada", "Recortando a pessoa", 15],
    ["legenda + vídeo final", "Gerando o vídeo", 45],
  ];
  // REEL_OUT: outra pasta (o teste de tela grava na pasta temporária)
  const OUT = process.env.REEL_OUT || path.join(os.homedir(), "Videos", "Reel automático");
  // onde salvou, do jeito que o Explorer mostra; fora de Vídeos, só o nome da pasta (o caminho inteiro não cabe)
  const WHERE = (() => {
    const rel = path.relative(path.join(os.homedir(), "Videos"), OUT);
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? "em Vídeos › " + rel.split(path.sep).join(" › ") : "na pasta “" + path.basename(OUT) + "”";
  })();
  const VIDEO = /\.(mp4|mov|m4v|mkv|avi|webm|3gp|3g2|mts|m2ts|ts|wmv|flv|mpg|mpeg|mxf)$/i;
  let input = "";
  let music = "";
  let result = "";
  let heard = null; // palavras da última transcrição deste vídeo (o "Refazer" não ouve de novo)
  let cancelled = false;
  let coverFile = "";
  let framed = false; // o controle de enquadramento foi mexido
  let busy = false;
  let run = null; // a rodada em andamento: etapas, quantas terminaram e a fração da atual
  let closeWanted = false;
  document.addEventListener("input", (e) => { if (e.target.id === "framex") framed = true; });

  const fileUrl = (p) => pathToFileURL(p).href; // "#" e "%" no nome quebravam o file:///
  const view = () => $("side").dataset.view;
  function setView(v) {
    $("side").dataset.view = v;
  }
  function status(text, kind) {
    $("status").textContent = text || "";
    $("status").className = "status" + (kind ? " " + kind : "");
  }
  function goLabel() {
    $("go-text").textContent = heard ? "Fazer de novo" : "Fazer meu Reel";
    $("go").disabled = busy || !input;
    if (!input) status("Escolha um vídeo para começar.");
  }

  // estilos: os ★ Destaques e as Básicas primeiro, o resto depois
  const presets = AppLegendasRender.PRESETS;
  const order = Object.keys(presets).sort((a, b) => rank(presets[a]) - rank(presets[b]));
  function rank(p) {
    return p.group === "featured" ? 0 : p.group === "basic" ? 1 : 2;
  }
  order.forEach((id) => {
    const o = document.createElement("option");
    o.value = id;
    o.textContent = (presets[id].group === "featured" ? "★ " : "") + (presets[id].label || id);
    $("style").appendChild(o);
  });
  // padrão: o estilo do Jota (Poppins branca parada a 66%; docs/padrao-reel.md); a diagonal borrava a palavra entrando
  $("style").value = presets.professor ? "professor" : order[0];

  // Prévia do estilo escolhido, como os cartões da galeria do painel: a legenda de perto (todos
  // como se fossem tamanho 150) e as palavras entrando no tempo, 1,5 s cada. Para enquanto faz
  // o Reel: o desenho do vídeo usa a mesma linha da página.
  const SAMPLE = ["sua", "legenda", "aqui"];
  // t: segundos da amostra (4,4 = as três palavras já paradas)
  function drawSample(canvas, id, t) {
    const p = Object.assign({ preset: id }, presets[id]);
    const size = Number(p.fontSize) || 86;
    const look = Object.assign({}, p, { fontSize: size * Math.min(2.4, Math.max(1, 150 / size)), positionY: 50 },
      $("o-brandcolor").checked ? { activeColor: $("brand-color").value } : {});
    const active = Math.min(SAMPLE.length - 1, Math.floor(t / 1.5));
    try {
      AppLegendasRender.drawFrame(canvas, { words: SAMPLE, active: active, starts: SAMPLE.map((w, k) => k * 1.5) }, look,
        { ageSeconds: t - active * 1.5, elapsed: t });
    } catch (e) { /* estilo que ainda não carregou a fonte: o próximo quadro tenta de novo */ }
  }
  let hovered = null; // a miniatura da galeria que anima (mouse ou foco)
  function paintLook() {
    requestAnimationFrame(paintLook);
    const t = (Date.now() % 4500) / 1000;
    if (hovered) drawSample(hovered.firstChild, hovered.dataset.id, t);
    if (busy || view() !== "opts") return;
    drawSample($("look"), $("style").value, t);
  }

  // Galeria: todos os estilos em miniatura (os Destaques primeiro); clicar escolhe
  function openGallery() {
    const fonts = [];
    // e a 900 (o 3D e o marca-texto das Letras do Jota)
    order.forEach((id) => [presets[id].fontFamily, presets[id].font2].filter(Boolean).forEach((f) => [presets[id].fontWeight || "700", "900"]
      .forEach((w) => fonts.push(document.fonts.load(w + " 40px \"" + f + "\"").catch(() => {})))));
    if (!$("gal-top").children.length) {
      order.forEach((id) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "tile";
        b.dataset.id = id;
        const c = document.createElement("canvas");
        c.width = 360;
        c.height = 200;
        const name = document.createElement("span");
        name.textContent = presets[id].label || id;
        b.append(c, name);
        b.addEventListener("click", () => {
          $("style").value = id;
          $("style").dispatchEvent(new Event("change"));
          gallery(false);
        });
        b.addEventListener("mouseenter", () => (hovered = b));
        b.addEventListener("focus", () => (hovered = b));
        b.addEventListener("mouseleave", () => still(b));
        b.addEventListener("blur", () => still(b));
        $(presets[id].group === "featured" ? "gal-top" : "gal-rest").appendChild(b);
      });
    }
    const tiles = [...document.querySelectorAll(".tile")];
    tiles.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.id === $("style").value)));
    Promise.all(fonts).then(() => tiles.forEach(still));
    gallery(true);
  }
  function still(b) {
    if (hovered === b) hovered = null;
    drawSample(b.firstChild, b.dataset.id, 4.4);
  }
  function gallery(open) {
    $("gallery").classList.toggle("hidden", !open);
    if (open) (document.querySelector(".tile[aria-pressed='true']") || document.querySelector(".tile")).focus();
    else {
      hovered = null;
      $("look-btn").focus();
    }
  }
  $("look-btn").addEventListener("click", openGallery);
  $("gallery-close").addEventListener("click", () => gallery(false));
  $("gallery").addEventListener("click", (e) => { if (e.target === $("gallery")) gallery(false); });
  // o canvas não baixa a fonte sozinho: pede a do estilo (e a segunda, nos de duas fontes)
  function loadFont() {
    const p = presets[$("style").value] || {};
    [p.fontFamily, p.font2].filter(Boolean).forEach((f) => [p.fontWeight || "700", "900"].forEach((w) => document.fonts.load(w + " 40px \"" + f + "\"").catch(() => {})));
  }
  $("style").addEventListener("change", loadFont);
  loadFont();
  requestAnimationFrame(paintLook);

  function pathOf(file) {
    try {
      return webUtils && webUtils.getPathForFile ? webUtils.getPathForFile(file) : file.path;
    } catch (e) {
      return file.path || "";
    }
  }
  function clock(secs) {
    if (!(secs > 0) || !isFinite(secs)) return "";
    const s = Math.floor(secs); // como o player conta
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  // aviso no pé do palco (arquivo que não é vídeo, prévia que não abre); some sozinho
  let noteTimer = 0;
  function note(text) {
    $("stagenote-text").textContent = text;
    $("stagenote").classList.toggle("hidden", !text);
    clearTimeout(noteTimer);
    if (text) noteTimer = setTimeout(() => $("stagenote").classList.add("hidden"), 8000);
  }

  let showing = ""; // "input" (o bruto) ou "result" (o Reel), para o nome no palco
  function play(file, what) {
    showing = what;
    $("player").src = fileUrl(file);
    $("filename").textContent = what === "result" ? "Seu Reel" : path.basename(file);
    $("filelen").textContent = "";
  }
  let rawSecs = 0; // duração do bruto, para o pronto dizer "o vídeo tinha"
  $("player").addEventListener("loadedmetadata", () => {
    const d = $("player").duration;
    $("filelen").textContent = clock(d) ? "· " + clock(d) : "";
    if (showing === "input") rawSecs = d;
    // pronto: quanto ficou o Reel e de quanto veio (com vídeos juntados, só o Reel)
    if (showing === "result" && clock(d)) {
      $("reel-len").textContent = "Reel de " + clock(d) + (rawSecs > d + 1 && !joined ? ", do vídeo de " + clock(rawSecs) : "") + ". ";
    }
  });
  $("player").addEventListener("error", () => {
    if (showing === "input" && input) note("Não dá para mostrar este vídeo aqui, mas o Reel sai normal.");
  });

  function choose(file) {
    if (!file) return;
    if (file !== input) {
      heard = null;
      framed = false;
      $("fixes").value = "";
    }
    if (joined && !joined.includes(file)) joined = null; // outro vídeo: a junção de antes não vale mais
    input = file;
    note("");
    play(input, "input");
    $("playerwrap").classList.remove("hidden");
    $("stagetop").classList.remove("hidden");
    $("drop").classList.add("hidden");
    $("stage").classList.add("has");
    setView("opts");
    status("");
    goLabel();
  }

  // Vários vídeos de uma vez (fila, como o Open Clip): o primeiro aparece, os outros esperam e são
  // feitos em seguida com as mesmas escolhas. Soltar enquanto faz põe na fila.
  // Com "Juntar num Reel só", os vídeos escolhidos viram um Reel: joined guarda a lista, e o
  // "Refazer" e a prévia usam a mesma (as palavras ouvidas são das tomadas juntas).
  let queue = [];
  let joined = null;
  function renderQueue() {
    $("queue").textContent = joined ? joined.length + " vídeos num Reel só" : queue.length ? "+" + queue.length + " na fila" : "";
    $("queue").title = (joined || queue).map((q) => path.basename(q)).join("\n");
    $("queue").classList.toggle("hidden", !queue.length && !joined);
    $("joinbox").classList.toggle("hidden", !queue.length);
  }
  function chooseMany(paths) {
    const all = paths.filter(Boolean);
    const list = all.filter((p) => VIDEO.test(p));
    const out = all.filter((p) => !VIDEO.test(p)).map((p) => path.basename(p));
    const warn = !out.length ? "" : list.length
      ? (out.length === 1 ? "“" + out[0] + "” ficou de fora: não é um vídeo." : out.length + " arquivos ficaram de fora: não são vídeos.")
      : (out.length === 1 ? "“" + out[0] + "” não é um vídeo. " : "Esses arquivos não são vídeos. ") + "Escolha um vídeo gravado no celular ou na câmera.";
    if (list.length && busy) queue = queue.concat(list);
    else if (list.length) {
      if (joined) {
        joined = null;
        heard = null; // as palavras eram das tomadas juntas
      }
      choose(list[0]);
      queue = list.slice(1);
    }
    renderQueue();
    if (warn) note(warn); // depois do choose(), que limpa o aviso
  }

  // soltar o vídeo em qualquer lugar da janela (o contador evita piscar ao passar sobre os filhos)
  let depth = 0;
  document.addEventListener("dragenter", (e) => {
    e.preventDefault();
    depth += 1;
    const n = e.dataTransfer && e.dataTransfer.items ? e.dataTransfer.items.length : 1;
    $("over-text").textContent = busy ? "Pode soltar: entra na fila" : n > 1 ? "Pode soltar: " + n + " vídeos, um depois do outro" : "Pode soltar";
    $("stage").classList.add("over");
  });
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("dragleave", (e) => {
    e.preventDefault();
    depth = Math.max(0, depth - 1);
    if (!depth) $("stage").classList.remove("over");
  });
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    depth = 0;
    $("stage").classList.remove("over");
    chooseMany([...e.dataTransfer.files].map(pathOf));
  });

  // escolher pelo seletor de arquivos (input escondido)
  function picker(accept, cb, many) {
    const el = document.createElement("input");
    el.type = "file";
    el.accept = accept;
    el.multiple = !!many;
    el.onchange = () => el.files[0] && (many ? cb([...el.files].map(pathOf)) : cb(pathOf(el.files[0])));
    el.click();
  }
  const pickVideo = () => picker("video/*,.mov,.mp4,.m4v,.mkv,.avi,.webm,.3gp,.mts", chooseMany, true);
  ["pick", "swap", "another", "err-other"].forEach((id) => $(id).addEventListener("click", pickVideo));
  $("music").addEventListener("click", () => picker("audio/*,.mp3,.wav,.m4a,.aac,.ogg", (p) => {
    music = p;
    $("music-name").textContent = path.basename(p);
    $("music-off").classList.remove("hidden");
    $("dropbox").classList.remove("hidden");
  }));
  $("music-off").addEventListener("click", () => {
    music = "";
    $("music-name").textContent = "Pôr música de fundo";
    $("music-off").classList.add("hidden");
    $("dropbox").classList.add("hidden");
  });

  // ---- progresso: barra pelo peso das etapas, a etapa da vez e o tempo que falta ao gerar o vídeo
  function pc(f) {
    return Math.round(Math.max(0, Math.min(1, f)) * 100) + "%";
  }
  function left(secs) {
    if (secs < 10) return "quase pronto";
    if (secs < 55) return "falta cerca de " + Math.max(10, Math.round(secs / 5) * 5) + " s";
    if (secs < 90) return "falta cerca de 1 min";
    return "faltam cerca de " + Math.round(secs / 60) + " min";
  }
  function paint() {
    const list = run.list;
    const total = list.reduce((s, x) => s + x.w, 0) || 1;
    const doneW = list.slice(0, run.done).reduce((s, x) => s + x.w, 0);
    const cur = list[run.done];
    run.shown = Math.max(run.shown, Math.min(1, (doneW + (cur ? cur.w * run.sub : 0)) / total));
    $("bar").style.width = $("minibar").style.width = (run.shown * 100).toFixed(1) + "%";
    $("pct").textContent = pc(run.shown);
    $("now").textContent = cur ? cur.label : "Terminando";
    $("steps").innerHTML = "";
    list.forEach((s, i) => {
      const li = document.createElement("li");
      li.textContent = s.label;
      li.dataset.key = s.key;
      li.className = i < run.done ? "ok" : i === run.done ? (run.failed ? "fail" : "now") : "";
      $("steps").appendChild(li);
    });
    if (run.quick) status("Refazendo a prévia… " + pc(run.shown));
  }

  // quick: a prévia que se refaz sozinha quando uma chave muda (as opções continuam à vista)
  // only: um formato só (o "Os três formatos" chama uma vez para cada)
  async function go(reuse, quick, only) {
    busy = true;
    cancelled = false;
    $("go").disabled = true;
    $("redo").disabled = true;
    const o = {
      input, inputs: joined, out: OUT, style: $("style").value, model: "small-q8",
      noPauses: !$("o-pauses").checked, retakes: $("o-retakes").checked,
      target: Number($("target").value) || 0, aiCode: $("ai-code").value.trim(),
      noZoom: !$("o-zoom").checked, noSfx: !$("o-sfx").checked, music, noDrop: !$("o-drop").checked,
      onePass: true,
      format: only || ($("format").value === "todos" ? "reels" : $("format").value),
      layout: $("layout").value,
      speed: Number($("speed").value) || 1,
      shortStyle: $("o-short").checked ? "impact" : "",
      preview: quick === true || $("o-preview").checked,
      behind: $("o-behind").checked,
      brandColor: $("o-brandcolor").checked ? $("brand-color").value : "",
      brandTop: $("brand-top").value,
      brandBottom: $("brand-bottom").value,
      words: reuse === true ? heard : null,
      fixes: $("fixes").value,
      manualX: reuse === true && framed ? Number($("framex").value) / 100 : undefined,
    };
    run = {
      quick: !!quick, done: 0, sub: 0, shown: 0, at: Date.now(), failed: false,
      list: STEPS.filter(([k]) => (k !== "melhores momentos" || o.target > 0) && (k !== "pessoa recortada" || o.behind) && (k !== "juntar" || (joined && joined.length > 1)))
        .map(([key, label, w]) => ({ key, label, w: key === "transcrição" && o.words ? 1 : w })),
    };
    $("msg").textContent = "";
    $("eta").textContent = "";
    $("mini").classList.toggle("hidden", !quick);
    if (!quick) {
      setView("run");
      $("progress").focus(); // o botão clicado sumiu: o foco do teclado vai para o progresso
    }
    paint();
    const started = Date.now();
    let warning = "";
    const detail = (text, f) => {
      $("msg").textContent = text;
      if (f !== undefined) run.sub = f;
      paint();
    };
    try {
      const r = await window.runReel(o, {
        log: (text) => console.log(text),
        warn: (text) => (warning = warning ? warning + " " + text : text), // a IA e a trava podem avisar na mesma rodada
        cancelled: () => cancelled,
        matting: (f) => detail("Recortando a pessoa… " + pc(f), f),
        downloading: (f) => detail("Primeira vez: baixando o reconhecimento de voz (só uma vez)… " + pc(f), f),
        waiting: () => detail("Esperando o computador terminar de ouvir outro vídeo…"),
        listening: (f) => detail("", f),
        step: (name) => {
          const i = run.list.findIndex((s) => s.key === name);
          if (i >= 0) {
            run.done = i + 1;
            run.sub = 0;
            run.at = Date.now();
          }
          $("eta").textContent = "";
          detail("");
        },
        progress: (f) => {
          const secs = (Date.now() - run.at) / 1000;
          $("eta").textContent = f > 0.04 && secs > 2 ? left((secs * (1 - f)) / f) : "";
          detail("", f);
        },
      });
      result = r.out;
      heard = r.words;
      coverFile = r.cover || "";
      // as 3 opções de capa; a clicada vira a "capa.jpg"
      $("covers").innerHTML = "";
      (r.covers || []).forEach((file, i) => {
        const b = document.createElement("button");
        b.type = "button";
        b.setAttribute("aria-pressed", String(!i));
        b.setAttribute("aria-label", "Capa " + (i + 1));
        const im = document.createElement("img");
        im.src = fileUrl(file) + "?" + Date.now();
        im.alt = "";
        b.appendChild(im);
        b.addEventListener("click", () => {
          try {
            fs.copyFileSync(file, coverFile);
            [...$("covers").children].forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
          } catch (e) { note("Não deu para trocar a capa: feche a imagem se ela estiver aberta."); }
        });
        $("covers").appendChild(b);
      });
      $("coverbox").classList.toggle("hidden", !(r.covers || []).length);
      $("lines").innerHTML = "";
      r.lines.forEach((text) => {
        const li = document.createElement("li");
        li.textContent = text;
        $("lines").appendChild(li);
      });
      // texto do post da IA (com o código): à vista e com um clique para copiar
      let post = "";
      try { post = r.post ? fs.readFileSync(r.post, "utf8").trim() : ""; } catch (e) { /* sem o arquivo: some o cartão */ }
      if (!quick || post) {
        $("post-text").textContent = post;
        $("post-copy-text").textContent = "Copiar título, legenda e hashtags";
        $("postbox").classList.toggle("hidden", !post);
      }
      // vídeo deitado: o controle de enquadramento começa onde o app pôs o recorte
      $("framebox").classList.toggle("hidden", !r.landscape);
      if (r.landscape && !framed) $("framex").value = String(Math.round((r.faceX === null || r.faceX === undefined ? 0.5 : r.faceX) * 100));
      $("redo").textContent = r.landscape ? "Refazer com as correções e o enquadramento" : "Refazer com as correções";
      const secs = Math.round((Date.now() - started) / 1000);
      $("done-title").textContent = o.preview ? "Prévia pronta" : "Seu Reel está pronto";
      $("reel-len").textContent = "";
      $("where-text").textContent = "Salvo " + WHERE + ".";
      $("where").title = "Feito em " + (secs < 60 ? secs + " s" : Math.floor(secs / 60) + " min " + (secs % 60) + " s") + ", em " + OUT;
      $("donemsg").textContent = warning;
      $("donemsg").className = "done-msg" + (warning ? " warn" : "");
      if (quick) status(warning ? "Prévia pronta. " + warning : "Prévia pronta. Assista ao lado.", warning ? "warn" : "ok");
      else {
        setView("done");
        $("show").focus();
      }
      play(result, "result");
      $("player").play().catch(() => {});
      return true;
    } catch (e) {
      if (cancelled) {
        setView("opts");
        status("Cancelado. O vídeo original não mudou.");
      } else {
        const h = humanError(e);
        run.failed = true;
        paint();
        $("err-title").textContent = h.title;
        $("err-what").textContent = h.what;
        $("err-tech").textContent = h.raw;
        setView("error");
        $("retry").focus();
      }
      return false;
    } finally {
      busy = false;
      $("mini").classList.add("hidden");
      $("redo").disabled = !heard;
      goLabel();
      if (closeWanted) window.close();
    }
  }

  // O erro em palavras de quem não é técnico, com o que fazer; o texto técnico fica nos detalhes.
  function humanError(e) {
    const raw = String(e && e.message ? e.message : e || "");
    const say = (title, what) => ({ title, what, raw });
    if (/não achei o arquivo/i.test(raw)) return say("Não achei o vídeo", "Ele foi movido, apagado ou estava num pendrive que saiu. Escolha o vídeo de novo.");
    if (/estragado/i.test(raw)) return say("Não consegui ler esse vídeo", "O arquivo pode estar incompleto. Copie o vídeo do celular de novo ou tente outro arquivo.");
    if (/não é um vídeo/i.test(raw)) return say("Esse arquivo não é um vídeo", "Parece uma foto ou um áudio. Escolha o vídeo gravado.");
    if (/não tem som/i.test(raw)) return say("Esse vídeo não tem som", "O app corta e legenda pela fala. Grave com o microfone ligado e tente de novo.");
    if (/baixar o modelo|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|getaddrinfo|socket hang up|HTTP \d/i.test(raw)) {
      return say("Sem internet", "Na primeira vez, o app baixa o reconhecimento de voz (só uma vez). Conecte a internet e clique em Tentar de novo.");
    }
    if (/ENOSPC/.test(raw)) return say("O disco está cheio", "Libere espaço no computador e clique em Tentar de novo.");
    if (/spawn .*ENOENT/i.test(raw)) return say("Falta uma parte do app", "Instale o app de novo e tente outra vez.");
    if (/EBUSY|EPERM|EACCES/.test(raw)) return say("Um arquivo está em uso", "Feche o Reel anterior se ele estiver aberto em outro programa e clique em Tentar de novo.");
    if (/ENOENT/.test(raw)) return say("Não achei o vídeo", "Ele foi movido, apagado ou estava num pendrive que saiu. Escolha o vídeo de novo.");
    if (/ffmpeg|Invalid data|moov atom|Error opening|extrair o áudio/i.test(raw)) {
      return say("Não consegui ler esse vídeo", "Ele pode estar incompleto ou num formato diferente. Copie o vídeo do celular de novo ou tente outro arquivo.");
    }
    return say("Não deu certo", "Clique em Tentar de novo. Se continuar, reinicie o computador e tente outra vez.");
  }

  $("back").addEventListener("click", () => {
    setView("opts");
    status(heard ? "Mude o que quiser: a prévia se refaz sozinha." : "");
  });
  $("err-back").addEventListener("click", () => {
    setView("opts");
    status("");
  });

  // lembra estilo e chaves da última vez (só neste computador)
  const SAVED = "reel-sem-premiere.opcoes";
  const KEYS = ["style", "format", "layout", "target", "ai-code", "speed", "brand-top", "brand-bottom", "o-pauses", "o-retakes", "o-zoom", "o-sfx", "o-drop", "o-short", "o-brandcolor", "brand-color", "o-preview", "o-behind"];
  try {
    const saved = JSON.parse(localStorage.getItem(SAVED) || "{}");
    KEYS.forEach((id) => {
      if (saved[id] === undefined) return;
      if ($(id).type === "checkbox") $(id).checked = !!saved[id];
      else if (id === "brand-color") $(id).value = /^#[0-9a-f]{6}$/i.test(saved[id]) ? saved[id] : "#ffd23f";
      else if (/^brand-/.test(id)) $(id).value = String(saved[id]).slice(0, 60);
      else if (id === "speed") $(id).value = ["1", "1.1", "1.2", "1.25", "1.5"].includes(saved[id]) ? saved[id] : "1";
      else if (id === "target") $(id).value = ["0", "30", "60", "90"].includes(saved[id]) ? saved[id] : "0"; // padrão: tudo o que é bom (Julian, 22/10)
      else if (id === "ai-code") $(id).value = String(saved[id]).slice(0, 200);
      else if (id === "format" ? ["reels", "feed", "quadrado", "todos"].includes(saved[id]) : id === "layout" ? ["", "duas"].includes(saved[id]) : presets[saved[id]]) $(id).value = saved[id];
    });
    $("more").open = !!saved.more;
    loadFont();
  } catch (e) { /* sem armazenamento: começa com o padrão */ }
  function save() {
    try {
      const now = { more: $("more").open };
      KEYS.forEach((k) => (now[k] = $(k).type === "checkbox" ? $(k).checked : $(k).value));
      localStorage.setItem(SAVED, JSON.stringify(now));
    } catch (e) { /* sem armazenamento */ }
  }
  $("more").addEventListener("toggle", save);
  // escolher a cor já liga a cor da marca
  $("brand-color").addEventListener("input", () => {
    if ($("o-brandcolor").checked) return;
    $("o-brandcolor").checked = true;
    $("o-brandcolor").dispatchEvent(new Event("change"));
  });
  // MVP do estudo: mudar uma chave depois do primeiro Reel refaz só a prévia (rápida, sem ouvir de novo)
  let again = 0;
  KEYS.forEach((id) => $(id).addEventListener("change", () => {
    save();
    if (!heard || busy || view() !== "opts") return;
    clearTimeout(again);
    again = setTimeout(() => !busy && view() === "opts" && go(true, true), 1200);
  }));

  function stop() {
    cancelled = true;
    $("msg").textContent = "Cancelando…";
    if (window.cancelReel) window.cancelReel();
  }
  $("stop").addEventListener("click", stop);

  // o vídeo da vez e, em seguida, os da fila; um erro num vídeo não para os outros
  async function goAll() {
    const made = [];
    const failed = [];
    if ($("o-join").checked && queue.length) {
      joined = [input].concat(queue);
      queue = [];
      heard = null;
      renderQueue();
    }
    const total = queue.length + 1;
    for (let n = 1; ; n += 1) {
      // com fila, o título diz em qual vídeo está
      const title = total > 1 ? "Vídeo " + n + " de " + total : "Fazendo seu Reel";
      $("doing").textContent = title;
      // o mesmo vídeo de novo: não ouve outra vez (a transcrição fica até trocar de vídeo)
      if (await go(n === 1 && !!heard)) {
        made.push(result);
        // os outros formatos do mesmo vídeo, com a transcrição que acabou de sair
        if ($("format").value === "todos") {
          for (const [f, label] of [["feed", "feed 4:5"], ["quadrado", "quadrado 1:1"]]) {
            $("doing").textContent = title + " · " + label;
            if (await go(true, false, f)) made.push(result);
            else if (cancelled) break;
          }
        }
      } else if (!cancelled) failed.push(path.basename(input));
      if (cancelled || !queue.length) break;
      choose(queue.shift());
      renderQueue();
    }
    if (made.length + failed.length > 1 && made.length) {
      $("done-title").textContent = made.length + " Reels prontos";
      $("donemsg").textContent = failed.length ? failed.length + " com erro: " + failed.join(", ") + "." : "";
      $("donemsg").className = "done-msg" + (failed.length ? " warn" : "");
      setView("done");
    }
  }
  $("go").addEventListener("click", goAll);
  $("retry").addEventListener("click", goAll);
  $("redo").addEventListener("click", () => go(true));
  $("show").addEventListener("click", () => result && shell.showItemInFolder(result));
  $("post-copy").addEventListener("click", () => {
    require("electron").clipboard.writeText($("post-text").textContent);
    $("post-copy-text").textContent = "Copiado! É só colar no Instagram";
  });
  $("cover").addEventListener("click", () => coverFile && shell.openPath(coverFile));

  // Fechar no meio: pergunta antes, e "Parar e fechar" cancela (o whisper e o ffmpeg morrem junto,
  // sem ficar rodando sozinhos nem segurar a vez da transcrição) e só então fecha.
  function ask(open) {
    $("closeask").classList.toggle("hidden", !open);
    if (open) $("keep").focus();
  }
  window.addEventListener("beforeunload", (e) => {
    if (!busy || closeWanted) return;
    e.preventDefault();
    e.returnValue = false; // no Electron isso segura a janela aberta, sem a caixa do sistema
    ask(true);
  });
  $("keep").addEventListener("click", () => ask(false));
  $("quit").addEventListener("click", () => {
    closeWanted = true;
    ask(false);
    stop();
    setTimeout(() => window.close(), 5000); // o cancelamento não respondeu: fecha mesmo assim
  });

  // atalhos: Ctrl+O escolhe o vídeo, Esc cancela (ou fecha a pergunta)
  document.addEventListener("keydown", (e) => {
    if (!$("closeask").classList.contains("hidden")) {
      if (e.key === "Escape") ask(false);
      if (e.key === "Tab") {
        e.preventDefault();
        (document.activeElement === $("keep") ? $("quit") : $("keep")).focus();
      }
      return;
    }
    if (!$("gallery").classList.contains("hidden")) {
      if (e.key === "Escape") gallery(false);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
      e.preventDefault();
      pickVideo();
    } else if (e.key === "Escape" && busy && view() === "run") {
      stop();
    }
  });

  goLabel();
  window.chooseVideo = choose; // o teste de tela usa (o soltar de verdade vem do Explorer)
  window.chooseVideos = chooseMany;
  ipcRenderer.send("ui-ready");
})();
