/** Renderiza legendas transparentes no painel, sem depender de MOGRT. */
(function (root) {
  var core = root.AppLegendasCore;
  var nodeRequire = (root.cep_node && root.cep_node.require) || (typeof require === "function" ? require : null);
  var PRESETS = {
    // ★ Destaque: recriações das predefinições de texto do Jota, primeiro usuário do app; abrem a
    // galeria. Na tela não aparece o nome dele (o app é vendido), só o selo de destaque.
    glide: { label: "Deslize suave", group: "featured", featured: true, fontFamily: "Montserrat", fontSize: 156, color: "#ffffff", activeColor: "#ffffff", strokeColor: "#000000", strokeWidth: 0, shadow: true, positionY: 62, highlight: false, motion: "slideblur" },
    lift: { label: "Subida suave", group: "featured", featured: true, fontFamily: "Montserrat", fontSize: 156, color: "#ffffff", activeColor: "#ffd23f", strokeColor: "#000000", strokeWidth: 0, shadow: true, positionY: 62, highlight: true, motion: "riseblur" },
    // Recriação exata do projeto do Jota (.prproj + quadros exportados): ver COMPOSE_LAYOUTS.
    compose: { label: "Composição", group: "featured", featured: true, fontFamily: "Poppins", font2: "", fontSize: 147, color: "#ffffff", activeColor: "#f4f27d", strokeColor: "#000000", strokeWidth: 0, shadow: true, positionY: 64, highlight: true, motion: "riseblur" },
    // Mostruário de legendas do Jota (.prproj "JOTA VIDEOS TUTORIAIS", 18/10/2026): palavra por
    // palavra no meio da tela, fonte e tracking do Premiere dele; tamanho ~1,3x o nominal (50 e 86,5),
    // que é a largura que as frases ocupam com as palavras soltas que ele posicionou. Jost entra no lugar da
    // Ibrand (paga). Cada palavra aparece quando é falada (destaque na mesma cor = só revelação).
    diagonal: { label: "Chega na diagonal", group: "featured", featured: true, fontFamily: "Poppins", fontWeight: "600", fontSize: 68, tracking: -60, wordSpace: 0.28, color: "#ffffff", activeColor: "#ffffff", strokeColor: "#000000", strokeWidth: 0, shadow: true, positionY: 50, highlight: true, reveal: true, motion: "diagonal" },
    settle: { label: "Sobe e assenta", group: "featured", featured: true, fontFamily: "Poppins", fontWeight: "600", fontSize: 68, tracking: -60, wordSpace: 0.28, color: "#ffffff", activeColor: "#ffffff", strokeColor: "#000000", strokeWidth: 0, shadow: true, positionY: 50, highlight: true, reveal: true, motion: "settle" },
    riseBold: { label: "Sobe com foco", group: "featured", featured: true, fontFamily: "Poppins", fontWeight: "700", fontSize: 100, tracking: -88, wordSpace: 0.28, color: "#ffffff", activeColor: "#ffffff", strokeColor: "#000000", strokeWidth: 0, shadow: true, positionY: 52, highlight: true, reveal: true, motion: "riseblur" },
    groteskSlide: { label: "Desliza e foca", group: "featured", featured: true, fontFamily: "Space Grotesk", fontWeight: "700", fontSize: 100, tracking: -89, wordSpace: 0.28, color: "#ffffff", activeColor: "#ffffff", strokeColor: "#000000", strokeWidth: 0, shadow: true, positionY: 47, highlight: true, reveal: true, motion: "slideblur" },
    groteskLeft: { label: "Entra pela esquerda", group: "featured", featured: true, fontFamily: "Space Grotesk", fontWeight: "500", fontSize: 100, tracking: -89, wordSpace: 0.28, color: "#ffffff", activeColor: "#ffffff", strokeColor: "#000000", strokeWidth: 0, shadow: true, positionY: 47, highlight: true, reveal: true, motion: "slideblurleft" },
    groteskDry: { label: "Palavra a palavra", group: "featured", featured: true, fontFamily: "Space Grotesk", fontWeight: "700", fontSize: 100, tracking: -89, wordSpace: 0.28, color: "#ffffff", activeColor: "#ffffff", strokeColor: "#000000", strokeWidth: 0, shadow: true, positionY: 47, highlight: true, reveal: true, motion: "none" },
    roundFocus: { label: "Redonda que foca", group: "featured", featured: true, fontFamily: "Jost", fontWeight: "600", fontSize: 100, tracking: 5, wordSpace: 0.28, color: "#ffffff", activeColor: "#ffffff", strokeColor: "#000000", strokeWidth: 0, shadow: true, positionY: 47, highlight: true, reveal: true, motion: "blurin" },
    // Dos reels que o Jota edita (out/2026): cliente 2, branco simples de 2-3 palavras sem
    // destaque; cliente 1, a palavra forte grande em cursiva dourada embaixo da frase.
    professor: { label: "Professor", group: "clean", featured: true, fontFamily: "Poppins", fontWeight: "600", fontSize: 74, wordSpace: 0.26, color: "#ffffff", activeColor: "#ffffff", strokeColor: "#000000", strokeWidth: 0, shadow: true, positionY: 66, highlight: false, motion: "none" },
    golden: { label: "Dourado elegante", group: "editorial", featured: true, fontFamily: "Poppins", font2: "Pinyon Script", fontSize: 72, color: "#ffffff", activeColor: "#f2df78", strokeColor: "#000000", strokeWidth: 0, shadow: true, positionY: 64, highlight: true, motion: "riseblur" },
    // Letras do Jota (skill "Máquina de Reels" dele, 22/10/2026): a palavra de destaque grande num dos 5 estilos de
    // letra do motion dele (drawLetter); o resto da frase em Poppins limpa como o Professor, com o halo. letters = o
    // nome do estilo no tema.js dele. Roxo #7C5CFA = a cor principal dele (#A68BFF, a versão para fundo escuro).
    jotaSticker: { label: "3D adesivo", group: "jota", letters: "adesivo", fontFamily: "Poppins", font2: "", fontWeight: "600", fontSize: 74, color: "#ffffff", activeColor: "#7c5cfa", strokeColor: "#000000", strokeWidth: 0, shadow: true, positionY: 64, highlight: true, motion: "settle" },
    jotaSculpt: { label: "3D escultura", group: "jota", letters: "escultura", fontFamily: "Poppins", font2: "", fontWeight: "600", fontSize: 74, color: "#ffffff", activeColor: "#ffffff", strokeColor: "#000000", strokeWidth: 0, shadow: true, positionY: 64, highlight: true, motion: "settle" },
    jotaMarker: { label: "Faixa marca-texto", group: "jota", letters: "marcaTexto", fontFamily: "Poppins", font2: "", fontWeight: "600", fontSize: 74, color: "#ffffff", activeColor: "#7c5cfa", strokeColor: "#000000", strokeWidth: 0, shadow: true, positionY: 64, highlight: true, motion: "settle" },
    jotaSerif: { label: "Serifa editorial", group: "jota", letters: "serifa", fontFamily: "Poppins", font2: "Bodoni Moda", fontWeight: "600", fontSize: 74, color: "#ffffff", activeColor: "#a68bff", strokeColor: "#000000", strokeWidth: 0, shadow: true, positionY: 64, highlight: true, motion: "settle" },
    jotaSerifColor: { label: "Serifa colorida", group: "jota", letters: "contraste", fontFamily: "Poppins", font2: "Playfair Display", fontWeight: "600", fontSize: 74, color: "#ffffff", activeColor: "#a68bff", strokeColor: "#000000", strokeWidth: 0, shadow: true, positionY: 64, highlight: true, motion: "settle" },
    // Básicas: o padrão de legenda, sem animação (a animação, se quiser, escolhe-se no Visual).
    basicWhite: { label: "Branca", group: "basic", fontFamily: "Montserrat", fontSize: 150, color: "#ffffff", activeColor: "#ffffff", strokeColor: "#000000", strokeWidth: 0, shadow: true, positionY: 75, highlight: false, motion: "none" },
    basicOutline: { label: "Branca com contorno", group: "basic", fontFamily: "Montserrat", fontSize: 150, color: "#ffffff", activeColor: "#ffffff", strokeColor: "#000000", strokeWidth: 8, shadow: false, positionY: 75, highlight: false, motion: "none" },
    basicYellow: { label: "Amarela com contorno", group: "basic", fontFamily: "Montserrat", fontSize: 150, color: "#ffe600", activeColor: "#ffe600", strokeColor: "#000000", strokeWidth: 8, shadow: false, positionY: 75, highlight: false, motion: "none" },
    // Pedido do Jota: cada palavra entra com o pulinho quando é falada, não a frase inteira parada.
    clean: { label: "Branco essencial", group: "clean", fontFamily: "Montserrat", fontSize: 158, color: "#ffffff", activeColor: "#ffffff", strokeColor: "#000000", strokeWidth: 0, shadow: true, positionY: 55, highlight: true, motion: "rise", reveal: true },
    impact: { label: "Palavra forte", group: "impact", fontFamily: "Montserrat", fontSize: 170, color: "#ffffff", activeColor: "#ff4036", strokeColor: "#000000", strokeWidth: 0, shadow: true, positionY: 52, highlight: true, motion: "pop" },
    editorial: { label: "Editorial vermelho", group: "editorial", fontFamily: "Montserrat", fontSize: 164, color: "#ffffff", activeColor: "#ec3533", strokeColor: "#000000", strokeWidth: 0, shadow: true, positionY: 52, highlight: true, motion: "rise" },
    neon: { label: "Selo neon", group: "creative", fontFamily: "Montserrat", fontSize: 145, color: "#fff32d", activeColor: "#fff32d", strokeColor: "#000000", strokeWidth: 0, shadow: false, positionY: 72, highlight: true, motion: "pop" },
    classic: { label: "Contorno clássico", group: "clean", fontFamily: "Montserrat", fontSize: 158, color: "#ffffff", activeColor: "#ffe600", strokeColor: "#000000", strokeWidth: 8, shadow: true, positionY: 75, highlight: true, motion: "none" },
    marker: { label: "Marca-texto", group: "impact", fontFamily: "Montserrat", fontSize: 156, color: "#ffffff", activeColor: "#171717", strokeColor: "#000000", strokeWidth: 0, shadow: true, positionY: 63, highlight: true, motion: "pop" },
    ribbon: { label: "Faixa editorial", group: "editorial", fontFamily: "Montserrat", fontSize: 150, color: "#ffffff", activeColor: "#ffffff", strokeColor: "#000000", strokeWidth: 0, shadow: false, positionY: 69, highlight: true, motion: "slide" },
    boxed: { label: "Caixa elegante", group: "clean", fontFamily: "Montserrat", fontSize: 146, color: "#ffffff", activeColor: "#f9ca4c", strokeColor: "#000000", strokeWidth: 0, shadow: false, positionY: 72, highlight: true, motion: "rise" },
    capsule: { label: "Cápsulas", group: "creative", fontFamily: "Montserrat", fontSize: 140, color: "#ffffff", activeColor: "#171717", strokeColor: "#000000", strokeWidth: 0, shadow: false, positionY: 70, highlight: true, motion: "bounce" },
    underline: { label: "Linha de destaque", group: "editorial", fontFamily: "Montserrat", fontSize: 160, color: "#ffffff", activeColor: "#ffffff", strokeColor: "#000000", strokeWidth: 0, shadow: true, positionY: 55, highlight: true, motion: "slide" },
    glow: { label: "Luz azul", group: "creative", fontFamily: "Montserrat", fontSize: 156, color: "#ffffff", activeColor: "#47dfff", strokeColor: "#000000", strokeWidth: 0, shadow: true, positionY: 57, highlight: true, motion: "pop" },
    sticker: { label: "Selo vermelho", group: "impact", fontFamily: "Montserrat", fontSize: 165, color: "#ffffff", activeColor: "#ffffff", strokeColor: "#000000", strokeWidth: 0, shadow: true, positionY: 55, highlight: true, motion: "bounce" },
    typewriter: { label: "Texto revelado", group: "clean", fontFamily: "Montserrat", fontSize: 148, color: "#ffffff", activeColor: "#ffcd5c", strokeColor: "#000000", strokeWidth: 0, shadow: true, positionY: 65, highlight: true, motion: "type" },
    split: { label: "Duas camadas", group: "impact", fontFamily: "Montserrat", fontSize: 168, color: "#ffffff", activeColor: "#f8df4e", strokeColor: "#000000", strokeWidth: 0, shadow: true, positionY: 54, highlight: true, motion: "slide" },
    punch: { label: "Pancada amarela", group: "impact", fontFamily: "Montserrat", fontSize: 178, color: "#ffffff", activeColor: "#f5d849", strokeColor: "#191919", strokeWidth: 5, shadow: true, positionY: 56, highlight: true, motion: "drop" },
    wave: { label: "Pulso violeta", group: "creative", fontFamily: "Montserrat", fontSize: 152, color: "#ffffff", activeColor: "#cbb8ff", strokeColor: "#15151c", strokeWidth: 3, shadow: true, positionY: 60, highlight: true, motion: "wiggle" },
  };
  // Revelação: a palavra só aparece quando é falada. Padrão dos estilos que já nasceram assim.
  function revealsWords(style) {
    if (style.reveal !== undefined) return !!style.reveal;
    return !!style.highlight && (style.motion === "type" || style.motion === "riseblur");
  }
  Object.keys(PRESETS).forEach(function (id) {
    var p = PRESETS[id];
    p.reveal = revealsWords(p);
    // Tipografia como no painel Texto do Premiere: peso, tracking (milésimos do tamanho, -20 =
    // letras mais juntas) e entrelinha (% a mais ou a menos que a normal).
    p.fontWeight = p.fontWeight || "800";
    p.tracking = p.tracking || 0;
    p.leading = p.leading || 0;
    p.align = p.align || "center";
    p.italic = !!p.italic;
    p.underline = !!p.underline;
  });
  var DEFAULT_STYLE = Object.assign({ preset: "clean" }, PRESETS.clean);
  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
  function fontOf(style, px, active) {
    var family = active && style.preset === "editorial" ? "Georgia" : style.fontFamily || "Montserrat";
    family = String(family).replace(/["\\]/g, "");
    var weight = /^[1-9]00$/.test(String(style.fontWeight)) ? style.fontWeight : "800";
    return (active && style.preset === "editorial" ? "bold italic " : (style.italic ? "italic " : "") + weight + " ") + Math.round(px) + 'px "' + family + '", "Arial Black", Arial, sans-serif';
  }
  // Espaço entre letras em px (ctx.letterSpacing existe no Chromium do CEP 12, Premiere 2025+).
  function setTracking(ctx, style, px, extra) {
    if ("letterSpacing" in ctx) ctx.letterSpacing = (((Number(style.tracking) || 0) / 1000 + (extra || 0)) * px).toFixed(1) + "px";
  }
  function roundedRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
  // Texto da palavra durante a entrada: letra por letra; embaralhar (letras sorteadas que assentam
  // da esquerda para a direita, iguais no mesmo quadro); contador (o número sobe de zero até o
  // valor, "R$ 1.500" e "3,5" mantêm o formato). Fora da entrada, o texto como é.
  var SCRAMBLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&@";
  function animatedText(style, text, age) {
    text = String(text || "");
    if (!isFinite(age) || age < 0) return text;
    if (style.motion === "type") return text.slice(0, Math.max(1, Math.ceil(text.length * clamp(age / 0.27, 0, 1))));
    if (style.motion === "scramble") {
      var settled = Math.floor(text.length * clamp(age / 0.35, 0, 1));
      var tick = Math.floor(age * 30);
      return text.split("").map(function (ch, i) {
        if (i < settled || !/[A-Za-zÀ-ÿ0-9]/.test(ch)) return ch;
        var r = SCRAMBLE.charAt((ch.charCodeAt(0) * 31 + tick * 17 + i * 7) % SCRAMBLE.length);
        return ch === ch.toLowerCase() ? r.toLowerCase() : r;
      }).join("");
    }
    if (style.motion === "counter") {
      var m = text.match(/\d+(?:\.\d{3})*(?:,\d+)?/);
      if (!m) return text;
      var decimals = (m[0].split(",")[1] || "").length;
      var target = Number(m[0].replace(/\./g, "").replace(",", "."));
      var value = target * (1 - Math.pow(1 - clamp(age / 0.6, 0, 1), 3));
      var shown = decimals ? value.toFixed(decimals).replace(".", ",") : String(Math.round(value));
      if (!decimals && m[0].indexOf(".") >= 0) shown = shown.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
      return text.replace(m[0], shown);
    }
    return text;
  }

  function motionState(style, age, unit) {
    var out = { scale: 1, dx: 0, dy: 0, opacity: 1, rotate: 0, blur: 0 };
    if (!isFinite(age) || age < 0 || style.motion === "none") return out;
    var p = clamp(age / 0.22, 0, 1);
    if (style.motion === "spring") {
      // Mola: cresce, passa do tamanho e assenta balançando (amortecida em ~0,5 s).
      out.scale = 1 - 0.7 * Math.exp(-7 * age) * Math.cos(18 * age);
      out.opacity = clamp(age / 0.08, 0, 1);
      return out;
    }
    if (style.motion === "blurin") {
      // Foca do desfoque: no lugar, sai do borrado e aperta um pouco.
      var focus = 1 - clamp(age / 0.35, 0, 1);
      out.blur = focus * focus * 22 * unit;
      out.scale = 1 + 0.05 * focus;
      out.opacity = clamp(age / 0.2, 0, 1);
      return out;
    }
    if (style.motion === "scramble" || style.motion === "counter") {
      // o movimento está no texto (animatedText); a palavra só aparece
      out.opacity = clamp(age / 0.06, 0, 1);
      if (style.motion === "counter") out.scale = 1 + 0.08 * Math.sin(Math.PI * clamp(age / 0.6, 0, 1));
      return out;
    }
    // Os três abaixo vêm do mostruário de legendas do Jota (.prproj de 18/10/2026): Transformar
    // com posição, Desfoque gaussiano 50 -> 0 e opacidade 0 -> 100, medidos nas chaves dele.
    if (style.motion === "diagonal") {
      // Chega do canto de baixo à direita (+270, +326 px) e assenta devagar (2,2 s no dele; aqui
      // 1,6 s para assentar dentro de uma legenda curta).
      var arrive = Math.pow(1 - clamp(age / 1.6, 0, 1), 5);
      var clear = 1 - clamp(age / 0.65, 0, 1);
      out.dx = arrive * 270 * unit; out.dy = arrive * 326 * unit;
      out.blur = clear * clear * 24 * unit;
      out.opacity = clamp(age / 0.32, 0, 1);
      return out;
    }
    if (style.motion === "settle") {
      // Sobe 62 px, passa um tiquinho e assenta em 0,42 s; o desfoque some em 0,125 s.
      var t = clamp(age / 0.42, 0, 1) - 1;
      out.dy = -(2 * t * t * t + t * t) * 62 * unit;
      var sharp = 1 - clamp(age / 0.125, 0, 1);
      out.blur = sharp * sharp * 24 * unit;
      out.opacity = clamp(age / 0.12, 0, 1);
      return out;
    }
    if (style.motion === "slideblur" || style.motion === "slideblurleft" || style.motion === "riseblur") {
      // Entrada com desfoque: desliza rápido e assenta devagar enquanto o desfoque some.
      var settle = 1 - Math.pow(1 - clamp(age / 0.5, 0, 1), 4);
      var sharpen = 1 - clamp(age / 0.3, 0, 1);
      if (style.motion === "slideblur") out.dx = (1 - settle) * 108 * unit;
      else if (style.motion === "slideblurleft") out.dx = -(1 - settle) * 108 * unit;
      else out.dy = (1 - settle) * 120 * unit;
      out.blur = sharpen * sharpen * 24 * unit;
      out.opacity = clamp(age / 0.18, 0, 1);
      return out;
    }
    if (style.motion === "pop") {
      out.scale = p < 0.55 ? 0.78 + 0.28 * p / 0.55 : 1.06 - 0.06 * (p - 0.55) / 0.45;
      out.opacity = clamp(p * 4, 0, 1);
    } else if (style.motion === "rise") {
      out.dy = Math.pow(1 - p, 3) * 28 * unit;
      out.opacity = clamp(p * 3, 0, 1);
    } else if (style.motion === "slide") {
      out.dx = -Math.pow(1 - p, 3) * 58 * unit;
      out.opacity = clamp(p * 3, 0, 1);
    } else if (style.motion === "bounce") {
      out.scale = p < 0.46 ? 0.6 + 0.48 * p / 0.46 : 1 + 0.08 * Math.exp(-9 * (p - 0.46)) * Math.cos(23 * (p - 0.46));
      out.rotate = (1 - p) * -0.075;
      out.opacity = clamp(p * 5, 0, 1);
    } else if (style.motion === "drop") {
      out.dy = -Math.pow(1 - p, 3) * 74 * unit;
      out.scale = 1 + 0.1 * Math.sin(Math.PI * p) * (1 - p);
      out.opacity = clamp(p * 5, 0, 1);
    } else if (style.motion === "wiggle") {
      out.dx = Math.sin(28 * p) * (1 - p) * 15 * unit;
      out.rotate = Math.sin(20 * p) * (1 - p) * 0.12;
      out.opacity = clamp(p * 5, 0, 1);
    } else if (style.motion === "rotate") {
      out.rotate = (1 - p) * -0.22;
      out.scale = 0.8 + 0.2 * p;
      out.opacity = clamp(p * 5, 0, 1);
    } else if (style.motion === "zoom") {
      out.scale = 1.45 - 0.45 * (1 - Math.pow(1 - p, 3));
      out.opacity = clamp(p * 5, 0, 1);
    }
    return out;
  }
  function drawImpact(ctx, canvas, frame, style, animation, unit) {
    var words = frame.words || [], index = frame.active;
    if (!words.length || index < 0) return false;
    var W = canvas.width, H = canvas.height;
    var centerY = H * clamp(Number(style.positionY) || 52, 5, 95) / 100;
    var focus = words[index], lead = words.slice(0, index).join(" ");
    var big = clamp(Number(style.fontSize) || 104, 10, 300) * unit * 1.35;
    var small = big * 0.38;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.font = fontOf(style, big, false); setTracking(ctx, style, big);
    big *= Math.min(1, W * 0.86 / Math.max(1, ctx.measureText(focus).width));
    ctx.font = fontOf(style, small, false); setTracking(ctx, style, small);
    small *= Math.min(1, W * 0.72 / Math.max(1, ctx.measureText(lead).width));
    ctx.save();
    if (style.shadow) {
      ctx.shadowColor = "rgba(0, 0, 0, 0.82)";
      ctx.shadowBlur = 15 * unit; ctx.shadowOffsetY = 5 * unit;
    }
    if (lead) {
      ctx.font = fontOf(style, small, false); setTracking(ctx, style, small);
      ctx.fillStyle = style.color;
      ctx.fillText(lead, W / 2, centerY - big * 0.62);
    }
    var movement = motionState(style, animation && Number(animation.ageSeconds), unit);
    ctx.translate(W / 2 + movement.dx, centerY + big * 0.16 + movement.dy);
    ctx.rotate(movement.rotate); ctx.scale(movement.scale, movement.scale);
    ctx.globalAlpha = movement.opacity;
    if (movement.blur > 0.3) ctx.filter = "blur(" + movement.blur.toFixed(1) + "px)";
    if (style.preset === "split") {
      var backW = Math.min(W * 0.88, big * Math.max(2.2, focus.length * 0.72));
      ctx.fillStyle = "rgba(15, 16, 19, 0.92)";
      roundedRect(ctx, -backW / 2, -big * 0.56, backW, big * 1.12, big * 0.08);
      ctx.fill();
    }
    ctx.font = fontOf(style, big, false); setTracking(ctx, style, big);
    ctx.fillStyle = style.activeColor;
    var focusText = animation ? animatedText(style, focus, Number(animation.ageSeconds)) : focus;
    ctx.fillText(focusText, 0, 0);
    ctx.restore();
    return true;
  }
  function drawEmoji(ctx, W, frame, style, px, top, age) {
    if (!style.emojis || !frame.emoji) return;
    // Acima do bloco, entrando junto com a legenda (cresce rápido nos primeiros quadros).
    var grow = frame.active > 0 || !isFinite(age) ? 1 : clamp(age / 0.18, 0, 1);
    var size = px * 1.5 * (0.6 + 0.4 * grow);
    ctx.save();
    ctx.globalAlpha = grow;
    ctx.font = size + 'px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
    ctx.textAlign = "center";
    ctx.fillText(frame.emoji, W / 2, Math.max(size * 0.6, top - px * 0.95));
    ctx.restore();
  }
  // Entrada de cada palavra medida no projeto do Jota (keyframes do .prproj): opacidade em
  // 0,1 s, desfoque some em ~0,15 s e o deslocamento assenta devagar. Linha que desliza vem da
  // direita (10% da largura); as outras sobem 7% da altura.
  function composeMotion(age, slide, blur, W, H, unit) {
    if (!isFinite(age)) return { dx: 0, dy: 0, opacity: 1, blur: 0 };
    if (age < 0) return null;
    var settle = 1 - Math.pow(1 - clamp(age / 0.8, 0, 1), 4);
    var sharpen = 1 - clamp(age / 0.15, 0, 1);
    return {
      dx: slide ? (1 - settle) * 0.104 * W : 0,
      dy: slide ? 0 : (1 - settle) * 0.072 * H,
      opacity: clamp(age / 0.1, 0, 1),
      blur: blur ? sharpen * sharpen * 24 * unit : 0,
    };
  }
  // As 4 disposições do projeto do Jota, medidas nos quadros exportados (1080x1920, px):
  // peso, tamanho, recuo (dx) e linha de base (dy) em relação à linha principal (dy = 0), altura
  // dessa linha na tela (y), centro do bloco (x) e opacidade da sombra (deslocada 10 px,
  // desfoque 8 px).
  var COMPOSE_LAYOUTS = {
    "lead,main,accent": { x: 0.498, y: 0.677, shadow: 0.5, slide: true, lines: [
      { weight: 400, size: 65.1, dx: 13, dy: -111 }, { weight: 500, size: 147.3, dx: 0, dy: 0 }, { weight: 700, size: 84.6, dx: 132, dy: 77 }] },
    "main,accent": { x: 0.516, y: 0.576, shadow: 0.35, slide: true, lines: [
      { weight: 500, size: 134.2, dx: 0, dy: 0, script: true }, { weight: 700, size: 116.3, dx: 143, dy: 81, still: true }] },
    "lead,accent": { x: 0.513, y: 0.673, shadow: 0, lines: [
      { weight: 500, size: 86.8, dx: -25, dy: -76 }, { weight: 700, size: 109.4, dx: 0, dy: 0, caps: true }] },
    "lead,main": { x: 0.485, y: 0.663, shadow: 0.55, lines: [
      { weight: 500, size: 71.6, dx: -97, dy: -95 }, { weight: 700, size: 118.5, dx: 0, dy: 0 }] },
    main: { x: 0.5, y: 0.663, shadow: 0.55, lines: [{ weight: 700, size: 118.5, dx: 0, dy: 0 }] },
  };
  var COMPOSE_BASE = 147.3; // tamanho da palavra grande do modelo; o controle Tamanho escala tudo
  // Dourado elegante, medido no reel da cliente 1 (1080x1920): frase em Poppins Bold 72 px,
  // destaque na cursiva 165 px com a frase 100 px acima; sem destaque, a frase sozinha um pouco
  // mais baixa. Linhas centradas. GOLDEN_BASE = tamanho da frase (o controle Tamanho).
  var GOLDEN_BASE = 72;
  var GOLDEN_SMALL = { weight: 700, size: 72, dx: 0, dy: 0 };
  var GOLDEN_KEY = { weight: 400, size: 195, dx: 0, dy: 0, script: true, key: true };
  function goldenLine(spec, dy) { return Object.assign({}, spec, { dy: dy }); }
  var GOLDEN_LAYOUTS = {
    lead: { x: 0.5, y: 0.67, shadow: 0.45, center: true, lines: [GOLDEN_SMALL] },
    main: { x: 0.5, y: 0.645, shadow: 0.35, center: true, lines: [GOLDEN_KEY] },
    "lead,main": { x: 0.5, y: 0.645, shadow: 0.5, center: true, lines: [goldenLine(GOLDEN_SMALL, -75), GOLDEN_KEY] },
    "main,tail": { x: 0.5, y: 0.645, shadow: 0.5, center: true, lines: [GOLDEN_KEY, goldenLine(GOLDEN_SMALL, 110)] },
    "lead,main,tail": { x: 0.5, y: 0.645, shadow: 0.5, center: true, lines: [goldenLine(GOLDEN_SMALL, -75), GOLDEN_KEY, goldenLine(GOLDEN_SMALL, 110)] },
  };
  // Dourado: a cor de destaque em cima, puxando para um ouro mais quente embaixo, como no reel.
  function warmGradient(ctx, hex, y, px) {
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex));
    if (!m) return hex;
    var c = [parseInt(m[1], 16) * 0.92, parseInt(m[2], 16) * 0.78, parseInt(m[3], 16) * 0.55].map(Math.round);
    var g = ctx.createLinearGradient(0, y - px * 0.55, 0, y + px * 0.1);
    g.addColorStop(0, hex);
    g.addColorStop(1, "rgb(" + c.join(",") + ")");
    return g;
  }
  // ------------------------------------------------------------------ Letras do Jota
  // Os 5 estilos de palavra de destaque da skill "Máquina de Reels" do Jota (@jota.videos; scripts/core.js: letreiro,
  // marcaTexto, serifaGrande e serifaCor), portados para a legenda com o crédito dele. Tamanhos em px do quadro
  // (o Jota desenha em 1080x1920; unit escala), t e t0 em segundos. Mudanças para legenda sobre vídeo: o 3D não
  // balança nem flutua (fica parado e vira uma imagem guardada), o halo escuro curto segura a letra clara em fundo
  // claro, e a escultura sobe com o ease do Premiere em vez do pulinho.
  var WHITE = [255, 255, 255], BLACK = [0, 0, 0];
  function span(t, a, b) { return clamp((t - a) / (b - a), 0, 1); }
  function out3(p) { return 1 - Math.pow(1 - p, 3); }
  function out5(p) { return 1 - Math.pow(1 - p, 5); }
  function smoother(p) { return p * p * p * (p * (p * 6 - 15) + 10); } // ease estilo Premiere (o E.ioSine dele)
  function rgbOf(hex) {
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex));
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [124, 92, 250];
  }
  function mix(a, b, k) { return a.map(function (v, i) { return Math.round(v + (b[i] - v) * k); }); }
  function css(c) { return "rgb(" + c.join(",") + ")"; }
  // Halo escuro curto (5 px, duas vezes; medido no 2.MOV, ver paint): marca a borda da letra clara em fundo claro.
  function haloText(ctx, text, x, y, fill, unit) {
    ctx.shadowColor = "rgba(0, 0, 0, 0.85)";
    ctx.shadowBlur = 5 * unit;
    ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
    ctx.fillText(text, x, y);
  }
  // Põe a fonte e o tracking (fração do tamanho) e devolve o tamanho em que o texto cabe em maxW (o caber() dele).
  function fitFont(ctx, s, font, size, maxW, track) {
    function set(z) {
      ctx.font = font(z);
      if ("letterSpacing" in ctx) ctx.letterSpacing = (track * z).toFixed(1) + "px";
    }
    set(size);
    var w = ctx.measureText(s).width;
    if (w > maxW) { size *= maxW / w; set(size); }
    return size;
  }
  function heavy(family) { return function (z) { return "900 " + z.toFixed(1) + 'px "' + family + '", "Arial Black", sans-serif'; }; }
  function serif(family) { return function (z) { return "700 " + z.toFixed(1) + 'px "' + family + '", "Bodoni Moda", "Playfair Display", Georgia, serif'; }; }

  // 3D adesivo e 3D escultura (o letreiro dele): letra pesada um pouco estreita, extrusão funda para baixo-direita
  // escurecendo, contorno de adesivo (linha + respiro) ou sombra longa macia, face em degradê. Paletas tiradas da cor
  // de destaque como as dele: adesivo = a "acc" (roxo: #BBA8FF -> #7452F2, extrusão #4A2DB8 -> #1B0C55), escultura =
  // a "esc" (branco: #FFF -> #E2E2DD, extrusão #D2D2CC -> #A3A39C).
  var CX = 0.94, DEPTH = 0.24, STEPS = 16, VX = Math.cos(0.92), VY = Math.sin(0.92);
  var SAMPLES = [0, 0.34, 0.67, 1];
  // Palavra 3D parada -> imagem pronta: contorno e extrusão são ~50 desenhos por letra (o Jota mediu 143 -> 96 ms por
  // quadro com o cache dele). Poucas: uma legenda mostra um destaque por vez.
  var LET_CACHE = new Map();
  function palette3d(kind, hex) {
    var c = rgbOf(hex);
    return kind === "escultura"
      ? { a: css(c), b: css(mix(c, BLACK, 0.11)), s1: mix(c, BLACK, 0.18), s2: mix(c, BLACK, 0.36) }
      : { a: css(mix(c, WHITE, 0.45)), b: css(mix(c, BLACK, 0.07)), s1: mix(c, BLACK, 0.4), s2: mix(c, BLACK, 0.78) };
  }
  function letreiro(ctx, s, x, y, t, t0, o) {
    var size = o.size, font = heavy(o.family), sculpt = o.kind === "escultura";
    ctx.save();
    ctx.font = font(size);
    if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
    var chars = Array.from(s), adv = chars.map(function (c) { return ctx.measureText(c).width * CX * 0.97; });
    var tot = adv.reduce(function (a, b) { return a + b; }, 0);
    if (tot > o.maxW) {
      size *= o.maxW / tot;
      adv = adv.map(function (a) { return a * o.maxW / tot; });
      tot = o.maxW;
    }
    var pal = palette3d(o.kind, o.color), steps = [];
    for (var k = 0; k <= STEPS; k += 1) steps.push(css(mix(pal.s1, pal.s2, k / STEPS)));
    var left = -tot / 2, settled = true;
    var list = chars.map(function (c, i) {
      var p = span(t, t0 + i * o.stag, t0 + i * o.stag + o.dur), e = out5(p);
      var l = { c: c, x: left + adv[i] / 2, y: 0, rot: 0, al: out5(clamp(p * 2.5, 0, 1)), bl: 0, ex: e };
      left += adv[i];
      if (p < 1) settled = false;
      if (sculpt) l.y = (1 - smoother(p)) * size * 1.4; // sobe de baixo
      else { l.x += (1 - e) * 620 * o.unit; l.rot = (1 - e) * 0.25; l.bl = (1 - e) * 10 * o.unit; } // da direita, girando
      return l;
    });
    function draw(g, l, dx, dy, fill, stroke, lw) {
      g.save();
      g.translate(l.x + dx, l.y + dy); g.rotate(l.rot); g.scale(CX, 1);
      g.font = font(size); g.textAlign = "center"; g.textBaseline = "middle"; g.lineJoin = "round";
      if (l.bl > 0.4) g.filter = "blur(" + l.bl.toFixed(1) + "px)";
      if (lw) { g.lineWidth = lw / CX; g.strokeStyle = stroke; g.strokeText(l.c, 0, 0); }
      if (fill) { g.fillStyle = fill; g.fillText(l.c, 0, 0); }
      g.restore();
    }
    function each(fn) { list.forEach(function (l) { if (l.al > 0.003) fn(l); }); } // letra que ainda não apareceu: nada
    function word(g) { // a palavra em (0, 0)
      if (sculpt) {
        // sombra longa e macia no chão
        g.save();
        g.filter = "blur(" + (size * 0.07).toFixed(1) + "px)";
        each(function (l) { g.globalAlpha = l.al * 0.24 * clamp(l.ex * 1.5, 0, 1); draw(g, l, size * 0.26, size * 0.4, "#000", null, 0); });
        g.restore();
        if (o.halo) { // a letra branca não some em fundo claro: halo em volta da face e da extrusão (duas vezes, como o paint)
          g.save();
          g.shadowColor = "rgba(0, 0, 0, 0.85)"; g.shadowBlur = 5 * o.unit;
          // com o mesmo traço da extrusão: sem ele, o traço cobria a parte escura do halo, colada na letra
          SAMPLES.concat(SAMPLES).forEach(function (sp) { each(function (l) { var dd = size * DEPTH * l.ex * sp; g.globalAlpha = l.al; draw(g, l, VX * dd, VY * dd, steps[STEPS], steps[STEPS], size * 0.03); }); });
          // e a sombra do Professor por cima (camisa branca atrás da letra branca: 77% das letras com 3:1 sem ela, juiz)
          g.shadowColor = "rgba(0, 0, 0, 0.78)"; g.shadowBlur = 14 * o.unit; g.shadowOffsetY = 4 * o.unit;
          SAMPLES.forEach(function (sp) { each(function (l) { var dd = size * DEPTH * l.ex * sp; g.globalAlpha = l.al; draw(g, l, VX * dd, VY * dd, steps[STEPS], steps[STEPS], size * 0.03); }); });
          g.restore();
        }
      } else {
        // contorno de adesivo: linha + respiro, unindo face e extrusão de todas as letras
        [[o.line, 0.17], [o.gap, 0.11]].forEach(function (cw) {
          SAMPLES.forEach(function (sp) {
            each(function (l) { var dd = size * DEPTH * l.ex * sp; g.globalAlpha = l.al * clamp(l.ex * 1.5, 0, 1); draw(g, l, VX * dd, VY * dd, cw[0], cw[0], size * cw[1] * l.ex); });
          });
        });
      }
      // extrusão funda, da camada de trás para a da frente
      for (var n = STEPS; n >= 1; n -= 1) {
        each(function (l) { var dd = size * DEPTH * l.ex * n / STEPS; if (dd < 0.5) return; g.globalAlpha = l.al; draw(g, l, VX * dd, VY * dd, steps[n], steps[n], size * 0.03); });
      }
      // face com degradê vertical
      var face = g.createLinearGradient(0, -size * 0.45, 0, size * 0.45);
      face.addColorStop(0, pal.a); face.addColorStop(1, pal.b);
      each(function (l) { g.globalAlpha = l.al; draw(g, l, 0, 0, face, pal.b, size * 0.025); });
    }
    if (settled && o.make) {
      // a imagem fica no pixel inteiro (desenhar no meio do pixel borraria a palavra quando ela para)
      var x0 = Math.floor(x - tot / 2 - size * 1.2), y0 = Math.floor(y - size * 1.2);
      var key = [s, size.toFixed(2), o.family, o.kind, o.color, o.line, o.gap, o.halo, o.unit.toFixed(3), (x - x0).toFixed(2), (y - y0).toFixed(2)].join("|");
      var sprite = LET_CACHE.get(key);
      if (!sprite) {
        sprite = o.make(Math.ceil(tot + size * 2.8), Math.ceil(size * 2.8));
        var g = sprite.getContext("2d");
        g.translate(x - x0, y - y0);
        word(g);
        LET_CACHE.set(key, sprite);
        if (LET_CACHE.size > 8) LET_CACHE.delete(LET_CACHE.keys().next().value);
      }
      ctx.drawImage(sprite, x0, y0);
    } else {
      ctx.translate(x, y);
      word(ctx);
    }
    ctx.restore();
  }
  // Marca-texto: grotesca pesada com a faixa da cor de destaque atrás, abrindo da esquerda; a letra sobe para o lugar.
  // A letra é escura em faixa clara e off-white em faixa escura (a dele: grafite no tema claro, off-white no escuro).
  function marcaTexto(ctx, s, x, y, t, t0, o) {
    var p = out5(span(t, t0, t0 + 0.45)), q = out3(span(t, t0 + 0.12, t0 + 0.55));
    if (p <= 0) return;
    ctx.save();
    var size = fitFont(ctx, s, heavy(o.family), o.size, o.maxW, -0.045);
    var tw = ctx.measureText(s).width, pad = size * 0.12, bh = size * 0.78;
    if (o.halo) { ctx.shadowColor = "rgba(0, 0, 0, 0.85)"; ctx.shadowBlur = 5 * o.unit; }
    ctx.fillStyle = o.color;
    for (var i = o.halo ? 2 : 1; i > 0; i -= 1) ctx.fillRect(x - tw / 2 - pad, y - bh * 0.45, (tw + pad * 2) * p, bh);
    ctx.shadowColor = "transparent";
    if (o.halo) { // a faixa colorida em fundo do mesmo tom: borda escura fina (o halo sozinho não dava 3:1, juiz)
      ctx.lineWidth = 4 * o.unit; ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
      ctx.strokeRect(x - tw / 2 - pad, y - bh * 0.45, (tw + pad * 2) * p, bh);
    }
    var c = rgbOf(o.color);
    ctx.globalAlpha = clamp(q * 1.4, 0, 1);
    ctx.fillStyle = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] > 150 ? "#2A2A2E" : "#F3F0EA";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(s, x, y + (1 - q) * size * 0.25);
    ctx.restore();
  }
  // Serifa editorial: grande e estreita, as letras sobem de uma máscara; um traço feito à mão sublinha na cor de destaque.
  function serifaGrande(ctx, s, x, y, t, t0, o) {
    if (t < t0) return;
    var cx = 0.8;
    ctx.save();
    ctx.translate(x, y); ctx.scale(cx, 1);
    var size = fitFont(ctx, s, serif(o.family), o.size, o.maxW / cx, -0.03);
    ctx.textBaseline = "middle"; ctx.textAlign = "left";
    var tw = ctx.measureText(s).width, acc = "";
    // a máscara de onde as letras sobem (a dele começava em -0,62 e cortava o acento do "Ú")
    ctx.beginPath(); ctx.rect(-tw, -size, tw * 2, size * 1.58); ctx.clip();
    Array.from(s).forEach(function (c, i) {
      var at = -tw / 2 + ctx.measureText(acc).width;
      acc += c;
      var e = out5(span(t, t0 + i * 0.035, t0 + i * 0.035 + 0.55));
      if (e <= 0) return;
      if (o.halo) haloText(ctx, c, at, (1 - e) * size * 1.05, o.ink, o.unit);
      if (o.shadow) { ctx.shadowColor = "rgba(0, 0, 0, 0.78)"; ctx.shadowBlur = 14 * o.unit; ctx.shadowOffsetY = 4 * o.unit; }
      ctx.fillStyle = o.ink;
      ctx.fillText(c, at, (1 - e) * size * 1.05);
    });
    ctx.restore();
    var k = smoother(span(t, t0 + 0.45, t0 + 1.1));
    if (k <= 0) return;
    ctx.save();
    ctx.translate(x, y);
    var w2 = tw * cx;
    ctx.strokeStyle = o.color; ctx.lineWidth = size * 0.045; ctx.lineCap = "round";
    if (o.halo) { ctx.shadowColor = "rgba(0, 0, 0, 0.85)"; ctx.shadowBlur = 5 * o.unit; }
    ctx.beginPath();
    for (var i = 0; i <= 40 * k; i += 1) {
      var u = i / 40, px = -w2 * 0.48 + w2 * 0.96 * u, py = size * 0.52 + Math.sin(u * Math.PI * 1.2) * size * 0.06 - u * size * 0.05;
      if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
    }
    ctx.stroke();
    ctx.restore();
  }
  // Serifa colorida: grande na cor de destaque com sombra suave; cada letra chega da direita saindo do desfoque.
  function serifaCor(ctx, s, x, y, t, t0, o) {
    if (t < t0) return;
    ctx.save();
    var size = fitFont(ctx, s, serif(o.family), o.size, o.maxW, -0.02);
    ctx.textBaseline = "middle"; ctx.textAlign = "left";
    var tw = ctx.measureText(s).width, acc = "";
    Array.from(s).forEach(function (c, i) {
      var at = x - tw / 2 + ctx.measureText(acc).width;
      acc += c;
      var e = out3(span(t, t0 + i * 0.04, t0 + i * 0.04 + 0.5));
      if (e <= 0) return;
      at += (1 - e) * size * 0.2;
      ctx.globalAlpha = clamp(e * 1.4, 0, 1);
      ctx.filter = e < 1 ? "blur(" + ((1 - e) * 8 * o.unit).toFixed(1) + "px)" : "none";
      if (o.halo) { // letra colorida: o halo e uma borda escura fina (o halo sozinho não dava 3:1, juiz)
        haloText(ctx, c, at, y, o.color, o.unit);
        ctx.lineWidth = 6 * o.unit; ctx.strokeStyle = "rgba(0, 0, 0, 0.85)"; ctx.lineJoin = "round";
        ctx.strokeText(c, at, y);
      }
      // a sombra suave dele (0,28 no fundo claro do motion); sobre vídeo, mais escura
      ctx.shadowColor = o.halo ? "rgba(0, 0, 0, 0.55)" : "rgba(0, 0, 0, 0.28)"; ctx.shadowBlur = size * 0.1; ctx.shadowOffsetX = size * 0.03; ctx.shadowOffsetY = size * 0.06;
      ctx.fillStyle = o.color;
      ctx.fillText(c, at, y);
    });
    ctx.restore();
  }
  // A palavra de destaque no estilo do preset (o destaque() dele; aqui um estilo por legenda, sem alternar dois).
  var LETTER_SCALE = { adesivo: 1, escultura: 1, marcaTexto: 0.95, serifa: 1.25, contraste: 1.1 };
  // Os tempos dele são de tela de motion; a legenda dura ~1 s e o destaque costuma ser falado no fim dela: tudo
  // 35% mais rápido, para a palavra assentar antes de a legenda sair.
  var LETTER_PACE = 1.35;
  function drawLetter(ctx, kind, s, x, y, t, t0, o) {
    t = t0 + (t - t0) * LETTER_PACE;
    // escultura: o ease do Premiere só assenta no fim, então ela entra mais curta (0,45 s e 0,03 entre letras, contra
    // 0,6 e 0,04 dele): assim a palavra falada meio segundo antes do fim da legenda chega parada
    if (kind === "adesivo" || kind === "escultura") letreiro(ctx, s, x, y, t, t0, Object.assign({ kind: kind, stag: kind === "escultura" ? 0.03 : 0.035, dur: kind === "escultura" ? 0.45 : 0.6, line: "#2A2A2E", gap: "#F3F0EA" }, o));
    else if (kind === "marcaTexto") marcaTexto(ctx, s, x, y, t, t0, o);
    else if (kind === "serifa") serifaGrande(ctx, s, x, y, t, t0, o);
    else serifaCor(ctx, s, x, y, t, t0, o);
  }
  // Disposição como a do Dourado: a frase (tamanho do Professor) em cima, o destaque grande no meio, o resto embaixo.
  // dy em px do quadro 1080 para o tamanho 74; o destaque é desenhado pelo meio (a frase, pela linha de base). Em cima,
  // folga para maiúscula acentuada com o contorno do 3D ("ÚNICA" encostava no "Não perca").
  var LETTER_BASE = 74;
  function letterLayout(roles, kind) {
    var key = 150 * LETTER_SCALE[kind];
    return { x: 0.5, y: 0.64, shadow: 0, center: true, lines: roles.map(function (r) {
      if (r.role === "main") return { weight: 900, size: key, dx: 0, dy: 0, key: true };
      return { weight: 600, size: LETTER_BASE, dx: 0, dy: r.role === "tail" ? key * 0.62 + 62 : roles.length > 1 ? -(key * 0.78 + 22) : 0 };
    }) };
  }

  // Composição (core/captions/compose.js decide os papéis; COMPOSE_LAYOUTS, a disposição).
  // frame.starts + animation.elapsed dão a idade de cada palavra, para a anterior continuar
  // assentando enquanto a próxima entra.
  function drawCompose(ctx, canvas, frame, style, animation, unit) {
    var words = frame.words || [], W = canvas.width, H = canvas.height;
    var golden = style.preset === "golden";
    var letters = (PRESETS[style.preset] || {}).letters; // Letras do Jota: o destaque num estilo de letra dele
    // o painel não guarda o halo no estilo: nas letras ele vem ligado (o app desliga com --sem-halo)
    var halo = letters && style.halo !== false;
    var keys = words.map(function (w, i) { return !!(frame.keys && frame.keys[i]); });
    // Letras: legenda sem destaque (regras ou Capi) usa a palavra mais longa (empate: a última), como no motion
    // dele, em que toda tela tem a sua; só no desenho (zoom e sons seguem os destaques de verdade)
    if (letters && keys.indexOf(true) < 0 && words.length) {
      var len = function (w) { return String(w).replace(/[.,!?;:"'“”…()]/g, "").length; };
      keys[words.reduce(function (best, w, i) { return len(w) >= len(words[best]) ? i : best; }, 0)] = true;
    }
    var roles = golden || letters ? core.keyLines(keys) : core.composeLines(words);
    if (!roles.length) return;
    var layouts = golden ? GOLDEN_LAYOUTS : COMPOSE_LAYOUTS;
    var layout = letters ? letterLayout(roles, letters) : layouts[roles.map(function (r) { return r.role; }).join(",")] || (golden ? GOLDEN_LAYOUTS.lead : COMPOSE_LAYOUTS["lead,main"]);
    var base = golden ? GOLDEN_BASE : letters ? LETTER_BASE : COMPOSE_BASE;
    var k = clamp(Number(style.fontSize) || base, 10, 300) / base * unit;
    var alt = String(style.font2 || "").replace(/["\\]/g, "").trim();
    var family = String(style.fontFamily || "Poppins").replace(/["\\]/g, "");
    function font(spec, px) {
      // Fonte cursiva costuma ter só o peso normal; negrito forçado a deixa borrada.
      var script = spec.script && alt;
      return (script ? 400 : spec.weight) + " " + Math.round(px) + 'px "' + (script ? alt : family) + '", "Arial Black", Arial, sans-serif';
    }
    function track(px) {
      setTracking(ctx, style, px, -0.04);
    }
    var lines = roles.map(function (role, l) {
      var spec = layout.lines[l] || layout.lines[layout.lines.length - 1];
      var px = spec.size * k;
      ctx.font = font(spec, px); track(px);
      var space = ctx.measureText(" ").width || px * 0.28, width = 0, items = [];
      for (var i = role.from; i < role.to; i += 1) {
        var text = spec.caps ? String(words[i]).toUpperCase() : words[i];
        var w = ctx.measureText(text).width;
        items.push({ index: i, text: text, x: width ? width + space : 0, width: w });
        width = (width ? width + space : 0) + w;
      }
      // o destaque das letras cabe sozinho na largura (drawLetter): não encolhe a frase
      return { role: role.role, spec: spec, px: px, width: letters && spec.key ? 0 : width, items: items };
    });
    // Frase mais longa que o modelo: encolhe o bloco inteiro, mantendo as proporções.
    var minX = Infinity, maxX = -Infinity;
    lines.forEach(function (line) {
      minX = Math.min(minX, line.spec.dx * k);
      maxX = Math.max(maxX, line.spec.dx * k + line.width);
    });
    if (layout.center) { minX = 0; maxX = Math.max.apply(null, lines.map(function (line) { return line.width; })); }
    var fit = Math.min(1, W * 0.9 / Math.max(1, maxX - minX));
    var left = W * layout.x - (maxX - minX) * fit / 2 - minX * fit;
    // Linhas centradas: cada uma no meio, em vez do recuo fixo do modelo.
    function lineLeft(line) { return layout.center ? W * layout.x - line.width * fit / 2 : left + line.spec.dx * k * fit; }
    var top = H * (layout.y + (clamp(Number(style.positionY) || 64, 5, 95) - 64) / 100);
    var keyColor = String(style.activeColor).toLowerCase() !== String(style.color).toLowerCase() ? style.activeColor : "#ffd23f";
    var elapsed = animation && Number(animation.elapsed);
    var activeAge = animation && Number(animation.ageSeconds);
    ctx.textBaseline = "alphabetic"; ctx.textAlign = "left"; ctx.lineJoin = "round";
    lines.forEach(function (line, l) {
      var px = line.px * fit, baseline = top + line.spec.dy * k * fit;
      if (letters && line.spec.key) {
        // o destaque inteiro de uma vez, no relógio da legenda: entra quando a 1ª palavra dele é falada
        var first = line.items[0].index, t0 = frame.starts ? Number(frame.starts[first]) : NaN;
        if (style.highlight && first > frame.active) return;
        var clock = style.motion === "none" ? [9, 0] : isFinite(elapsed) && isFinite(t0) ? [elapsed, t0]
          : first === frame.active && isFinite(activeAge) ? [activeAge, 0] : [9, 0];
        var doc = canvas.ownerDocument;
        drawLetter(ctx, letters, line.items.map(function (it) { return it.text; }).join(" "), W * layout.x, baseline, clock[0], clock[1], {
          size: px, maxW: W * 0.86, unit: unit, halo: halo, shadow: style.shadow, color: style.activeColor, ink: style.color,
          family: /^(serifa|contraste)$/.test(letters) ? alt || (letters === "serifa" ? "Bodoni Moda" : "Playfair Display") : family,
          make: doc && function (w, h) { var c = doc.createElement("canvas"); c.width = w; c.height = h; return c; },
        });
        return;
      }
      line.items.forEach(function (it) {
        if (style.highlight && it.index > frame.active) return;
        var age = !style.highlight ? (frame.active === 0 ? activeAge : NaN)
          : frame.starts && isFinite(elapsed) ? elapsed - frame.starts[it.index]
          : it.index === frame.active ? activeAge : NaN;
        // letras: a frase entra como no "Sobe e assenta" do Jota (motionState); a composição, como no modelo dela
        var m = style.motion === "none" ? composeMotion(NaN) : letters ? motionState(style, age, unit) : composeMotion(age, layout.slide && l === 0, !line.spec.still, W, H, unit);
        if (!m) return;
        ctx.save();
        ctx.globalAlpha = m.opacity;
        ctx.font = font(line.spec, px); track(px);
        if (m.blur > 0.3) ctx.filter = "blur(" + m.blur.toFixed(1) + "px)";
        var x = lineLeft(line) + it.x * fit + m.dx, y = baseline + m.dy;
        if (halo) haloText(ctx, it.text, x, y, style.color, unit);
        if (letters && style.shadow) { // a sombra do Professor
          ctx.shadowColor = "rgba(0, 0, 0, 0.78)";
          ctx.shadowBlur = 14 * unit; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 4 * unit;
        } else if (style.shadow && layout.shadow) {
          ctx.shadowColor = "rgba(0, 0, 0, " + layout.shadow + ")";
          ctx.shadowBlur = 8 * unit; ctx.shadowOffsetX = 10 * unit; ctx.shadowOffsetY = 10 * unit;
        }
        var strokeWidth = Number(style.strokeWidth) || 0;
        if (strokeWidth > 0) {
          ctx.lineWidth = strokeWidth * unit * 2; ctx.strokeStyle = style.strokeColor || "#000000";
          ctx.strokeText(it.text, x, y);
        }
        var key = style.smartHighlight && frame.keys && frame.keys[it.index];
        ctx.fillStyle = line.spec.key ? warmGradient(ctx, style.activeColor, y, px) : line.role === "accent" ? style.activeColor : key ? keyColor : style.color;
        ctx.fillText(it.text, x, y);
        if (line.spec.key) {
          // a cursiva tem traço fino; um contorno da mesma cor dá o peso do modelo
          ctx.shadowColor = "transparent"; ctx.lineWidth = 1.6 * unit; ctx.strokeStyle = ctx.fillStyle;
          ctx.strokeText(it.text, x, y);
        }
        ctx.restore();
      });
    });
    drawEmoji(ctx, W, frame, style, 147 * k, top - lines[0].px * 1.4, activeAge);
  }
  // animation.ageSeconds: tempo desde o começo da palavra ativa.
  function drawFrame(canvas, frame, style, animation) {
    var ctx = canvas.getContext("2d"), W = canvas.width, H = canvas.height;
    var unit = Math.min(W, H) / 1080;
    var px = clamp(Number(style.fontSize) || 86, 10, 300) * unit;
    var maxWidth = W * 0.86, words = frame.words || [];
    if (style.soloBig && words.length === 1) px *= 1.3; // bloco de uma palavra só: a palavra de impacto, maior
    ctx.clearRect(0, 0, W, H);
    ctx.textBaseline = "middle"; ctx.textAlign = "left"; ctx.lineJoin = "round";
    if (style.preset === "compose" || style.preset === "golden" || (PRESETS[style.preset] || {}).letters) { drawCompose(ctx, canvas, frame, style, animation, unit); return; }
    if ((style.preset === "impact" || style.preset === "split") && style.highlight && drawImpact(ctx, canvas, frame, style, animation, unit)) return;
    // "Destaques maiores": a palavra-chave sai 20% maior e a linha já é medida com ela assim.
    // ponytail: só neste desenho; composição e impacto seguem com o tamanho de sempre.
    function keyScale(index) {
      return style.keyBig && frame.keys && frame.keys[index] ? 1.2 : 1;
    }
    function measure(text, index) {
      if (text === " ") return px * (Number(style.wordSpace) || 0.42); // espaço entre palavras, em fração do tamanho
      var size = px * keyScale(index);
      ctx.font = fontOf(style, size, false); setTracking(ctx, style, size);
      var width = ctx.measureText(text).width;
      if (style.preset === "editorial") {
        ctx.font = fontOf(style, size, true); setTracking(ctx, style, size);
        width = Math.max(width, ctx.measureText(text).width);
      }
      return width;
    }
    var widest = 0;
    for (var i = 0; i < words.length; i += 1) widest = Math.max(widest, measure(words[i], i));
    if (widest > maxWidth) px *= maxWidth / widest;
    var fit = { maxWidth: maxWidth, maxChars: Number(style.maxCharsPerLine) || 0, balance: true };
    var layout = core.layoutWords(words, measure, fit);
    var maxLines = Number(style.maxLines) || 0;
    // O limite de linhas manda: sem espaço, ignora os caracteres por linha e diminui a fonte.
    if (maxLines && layout.lines.length > maxLines) {
      fit.maxChars = 0;
      layout = core.layoutWords(words, measure, fit);
    }
    for (var shrink = 0; maxLines && layout.lines.length > maxLines && shrink < 15; shrink += 1) {
      px *= 0.9;
      layout = core.layoutWords(words, measure, fit);
    }
    var lineHeight = px * 1.23 * (1 + clamp(Number(style.leading) || 0, -40, 100) / 100), blockHeight = layout.lines.length * lineHeight;
    var margin = lineHeight * 0.25;
    // Alinhamento: o bloco encosta na margem lateral (a mesma folga da largura máxima).
    var align = style.align === "left" || style.align === "right" ? style.align : "center";
    var side = (W - maxWidth) / 2;
    function blockLeft(width) {
      return align === "left" ? side : align === "right" ? W - side - width : (W - width) / 2;
    }
    var top = clamp(H * clamp(Number(style.positionY) || 55, 5, 95) / 100 - blockHeight / 2, margin, Math.max(margin, H - blockHeight - margin));
    if (style.preset === "ribbon" || style.preset === "boxed") {
      var bandPadX = px * 0.34, bandPadY = px * 0.25;
      var bandW = style.preset === "ribbon" ? W : Math.min(W * 0.94, layout.width + bandPadX * 2);
      var bandX = style.preset === "ribbon" ? 0 : blockLeft(bandW - bandPadX * 2) - bandPadX;
      ctx.save(); ctx.fillStyle = style.preset === "ribbon" ? "rgba(207, 42, 40, 0.97)" : "rgba(14, 16, 19, 0.9)";
      roundedRect(ctx, bandX, top - bandPadY, bandW, blockHeight + bandPadY * 2, style.preset === "ribbon" ? 0 : px * 0.18);
      ctx.fill(); ctx.restore();
    }
    if (style.preset === "neon" && layout.lines.length) {
      var padX = px * 0.38, padY = px * 0.23;
      var boxW = layout.width + padX * 2, boxH = blockHeight + padY * 2;
      ctx.save();
      ctx.shadowColor = style.activeColor || "#fff32d"; ctx.shadowBlur = 20 * unit;
      ctx.strokeStyle = style.activeColor || "#fff32d"; ctx.lineWidth = Math.max(2, 3 * unit);
      ctx.fillStyle = "rgba(8, 9, 9, 0.88)";
      roundedRect(ctx, blockLeft(layout.width) - padX, top - padY, boxW, boxH, px * 0.18);
      ctx.fill(); ctx.stroke(); ctx.restore();
    }
    var age = animation && Number(animation.ageSeconds);
    // Palavra-chave usa a cor de destaque; em estilos de uma cor só, o amarelo do painel.
    var keyColor = String(style.activeColor).toLowerCase() !== String(style.color).toLowerCase() ? style.activeColor : "#ffd23f";
    var reveal = revealsWords(style);
    function paint(word, x, y) {
      var current = word.index === frame.active;
      var active = style.highlight && current;
      if (reveal && word.index > frame.active) return;
      // Sem destaque nem revelação, o bloco inteiro faz a entrada junto com a primeira palavra.
      var moves = active || reveal && current || !style.highlight && frame.active === 0;
      var display = word.text;
      // contador e embaralhar seguem a entrada do bloco; letra por letra, só a palavra da vez
      if (active || reveal && current || moves && style.motion !== "type") display = animatedText(style, display, age);
      var movement = moves ? motionState(style, age, unit) : motionState({ motion: "none" }, age, unit);
      // Revelação: a palavra que já entrou termina o próprio movimento em vez de pular para o lugar
      // quando a seguinte começa (a diagonal leva 1,6 s, mais que uma palavra falada).
      var since = animation && Number(animation.elapsed) - (frame.starts ? Number(frame.starts[word.index]) : NaN);
      if (reveal && !current && isFinite(since)) movement = motionState(style, since, unit);
      // A palavra da vez já estava na tela (sem revelação): o pop só cresce, não some e volta. Antes
      // ela caía para quase nada por 2 quadros a cada palavra (Selo neon, medido pelo fx-2).
      if (active && !reveal) movement.opacity = 1;
      ctx.save();
      ctx.translate(x + word.width / 2 + movement.dx, y + movement.dy);
      ctx.rotate(movement.rotate); ctx.scale(movement.scale, movement.scale);
      var size = px * keyScale(word.index);
      ctx.globalAlpha = movement.opacity; ctx.font = fontOf(style, size, active); setTracking(ctx, style, size);
      if (movement.blur > 0.3) ctx.filter = "blur(" + movement.blur.toFixed(1) + "px)";
      var textWidth = ctx.measureText(display).width;
      if (style.preset === "marker" && active || style.preset === "capsule" || style.preset === "sticker" && active) {
        var fill = style.preset === "marker" ? "#f8dc4a" : style.preset === "sticker" ? "#ed4137" : active ? "#f9d151" : "rgba(12,14,17,0.88)";
        ctx.fillStyle = fill;
        roundedRect(ctx, -word.width / 2 - px * 0.13, -px * 0.61, word.width + px * 0.26, px * 1.22, style.preset === "capsule" ? px * 0.45 : px * 0.1);
        ctx.fill();
      }
      // Contorno escuro curto (opcional, o Reel automático liga): a sombra larga some em fundo claro e cheio
      // (letra branca fina sobre camisa branca e estante, 2.MOV); este halo (5 px, duas vezes) marca a borda da letra e
      // quase não aparece em fundo escuro. A letra sai com ele e a sombra de sempre vem por cima.
      // duas vezes (haloText): uma só deixava 57% das legendas do 2.MOV com 3:1 em volta da letra (juiz); duas, a borda fecha
      if (style.halo && !(Number(style.strokeWidth) > 0)) haloText(ctx, display, -textWidth / 2, 0, active ? style.activeColor : style.color, unit);
      if (style.shadow) {
        ctx.shadowColor = "rgba(0, 0, 0, 0.78)";
        ctx.shadowBlur = (style.preset === "classic" ? 12 : 14) * unit;
        ctx.shadowOffsetY = 4 * unit;
      }
      if (style.preset === "glow" && active) {
        ctx.shadowColor = style.activeColor;
        ctx.shadowBlur = 28 * unit;
        ctx.shadowOffsetY = 0;
      }
      var strokeWidth = Number(style.strokeWidth) || 0;
      if (strokeWidth > 0) {
        ctx.lineWidth = strokeWidth * unit * 2; ctx.strokeStyle = style.strokeColor || "#000000";
        ctx.strokeText(display, -textWidth / 2, 0);
      }
      var key = style.smartHighlight && frame.keys && frame.keys[word.index];
      ctx.fillStyle = active ? style.activeColor : key ? keyColor : style.color;
      ctx.fillText(display, -textWidth / 2, 0);
      if (style.underline) {
        ctx.fillRect(-textWidth / 2, px * 0.5, textWidth, Math.max(2 * unit, px * 0.06));
      }
      if (style.preset === "underline" && active) {
        ctx.fillStyle = "#f8d942";
        ctx.fillRect(-word.width / 2, px * 0.52, word.width, Math.max(3 * unit, px * 0.075));
      }
      ctx.restore();
    }
    for (var l = 0; l < layout.lines.length; l += 1) {
      var line = layout.lines[l];
      var x0 = align === "center" ? (W - line.width) / 2 : align === "left" ? blockLeft(layout.width) : blockLeft(layout.width) + layout.width - line.width;
      var y = top + lineHeight * (l + 0.5);
      for (var w = 0; w < line.words.length; w += 1) paint(line.words[w], x0 + line.words[w].x, y);
    }
    drawEmoji(ctx, W, frame, style, px, top, age);
  }
  function ensureDir(dir) { nodeRequire("fs").mkdirSync(dir, { recursive: true }); }
  function savePng(canvas, filePath) {
    var base64 = canvas.toDataURL("image/png").split(",")[1];
    nodeRequire("fs").writeFileSync(filePath, nodeRequire("buffer").Buffer.from(base64, "base64"));
  }
  root.AppLegendasRender = { PRESETS: PRESETS, DEFAULT_STYLE: DEFAULT_STYLE, drawFrame: drawFrame, ensureDir: ensureDir, savePng: savePng, animatedText: animatedText, motionState: motionState };
})(typeof self !== "undefined" ? self : this);
