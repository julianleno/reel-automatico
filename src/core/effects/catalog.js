/**
 * Biblioteca de efeitos: lê o catalog.json da pasta da biblioteca (gerado na organização dos
 * packs do FX Master) e devolve listas prontas para a galeria. JS puro, sem Adobe nem Node.
 *
 * Formato do catálogo (format "fx-library-catalog", version 1 ou 2), caminhos relativos à
 * pasta da biblioteca, com "/":
 *   presets       [{ name, order, folder, categories:[{ name, folder, kind, items:[
 *                   { name, kind:"fx"|"audio", project?, audio?, thumb, preview, direction?, sounds? } ] }] }]
 *                 sounds: v2 [{ name: nome que o .prproj pede, file }]; v1 ["caminho"] (nome = do arquivo)
 *   motionPresets [{ name, folder, items:[{ name, in?:{project, preview}, out?:{project, preview} }] }]
 *   mogrt         [{ name, folder, items:[{ name, file, thumb, preview }] }]
 *   textAnimation [{ name, folder, items:[{ name, file, preview }] }]
 *   soundEffects  [{ name, folder, items:[{ name, file }] }]
 *
 * parseCatalog(text)                    -> catálogo (lança Error com mensagem para o usuário)
 * EFFECT_SECTIONS                       -> [{ id, label }] na ordem da galeria
 * sectionTree(catalog, sectionId)       -> [{ name, categories:[{ name, count }] }]  (pacotes)
 * effectItems(catalog, sectionId, p, c) -> itens normalizados de um pacote/categoria
 * searchEffects(catalog, query, { section, limit }) -> itens de todas as categorias
 * libraryPath(root, rel, windows)       -> caminho absoluto de um arquivo da biblioteca
 *
 * Item normalizado: { key, section, kind, name, pack, category, file, thumb, preview,
 *   audio, sounds:[{ name, file }], direction, motion:{ in, out } }
 *   kind: "fx" (preset .prproj) | "audio" (som/música) | "motion" (IN/OUT no clipe) | "mogrt"
 */
(function (root, factory) {
  // No painel CEP o Node também define `module`; lá o destino é o global do painel.
  if (typeof window === "undefined" && typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    var api = factory();
    root.AppLegendasCore = root.AppLegendasCore || {};
    Object.keys(api).forEach(function (k) {
      root.AppLegendasCore[k] = api[k];
    });
  }
})(typeof self !== "undefined" ? self : this, function () {
  var EFFECT_SECTIONS = [
    { id: "presets", label: "Efeitos" },
    { id: "motionPresets", label: "Movimento" },
    { id: "textAnimation", label: "Texto animado" },
    { id: "mogrt", label: "Títulos" },
    { id: "soundEffects", label: "Sons" },
    { id: "music", label: "Músicas" },
  ];
  var SECTION_LABEL = {};
  EFFECT_SECTIONS.forEach(function (s) {
    SECTION_LABEL[s.id] = s.label;
  });

  // Categorias em português, para mostrar. O nome original (em inglês, o das pastas do pack)
  // continua valendo na busca e no title do cartão. Os termos que o editor usa em inglês (glitch,
  // zoom, swipe, whoosh, VHS, FX) ficam como estão.
  var CATEGORY_PT = {
    "16mm Frame FX In": "Moldura 16mm (entrada)",
    "16mm Frame FX Out": "Moldura 16mm (saída)",
    "2D Camera Moves Loop": "Câmera 2D em loop",
    "2D Camera Moves Normal": "Câmera 2D",
    "2D Rotation": "Rotação 2D",
    "3D Camera Moves DOF Loop": "Câmera 3D com profundidade, em loop",
    "3D Camera Moves DOF Normal": "Câmera 3D com profundidade",
    "3D Camera Moves No DOF Loop": "Câmera 3D sem profundidade, em loop",
    "3D Camera Moves No DOF Normal": "Câmera 3D sem profundidade",
    "3D Rotation": "Rotação 3D",
    "8mm Frame FX In": "Moldura 8mm (entrada)",
    "8mm Frame FX Out": "Moldura 8mm (saída)",
    "Action Loop": "Ação (loop)",
    "Advertising": "Publicidade",
    "Alerts": "Alertas",
    "Ambience Loop": "Ambiente (loop)",
    "Ambient Sound Effects": "Sons de ambiente",
    "Animations Bounce": "Animações com quique",
    "Animations Cinematic": "Animações cinematográficas",
    "Animations Fracture": "Animações de fratura",
    "Animations Glitch": "Animações glitch",
    "Animations Position": "Animações de posição",
    "Animations Rotation": "Animações de rotação",
    "Animations Scale": "Animações de escala",
    "Animations Shift": "Animações de deslocamento",
    "Audio DAT Abstract": "Abstratos (DAT)",
    "Bass Hits & Explosions": "Graves e explosões",
    "Beds": "Fundos",
    "Black & White Grade": "Cor: preto e branco",
    "Bleach Grade": "Cor: bleach",
    "Blinders FX": "Ofuscamentos",
    "Blur": "Desfoque",
    "Blur FX": "Desfoque FX",
    "Bounce Stretch Swipes": "Swipes com quique e esticada",
    "Bouncy Jumpers": "Saltos com quique",
    "Bouncy Jumpers FX": "Saltos com quique FX",
    "Cam Shake FX": "Tremida de câmera FX",
    "Camera Shakes": "Tremidas de câmera",
    "Camera Smash": "Batida de câmera",
    "Cartoons": "Desenho animado",
    "Chaos": "Caos",
    "Chaos Cuts": "Cortes caóticos",
    "Chase Loop": "Perseguição (loop)",
    "Chops": "Cortes secos",
    "Chromatic RGB FX": "RGB cromático",
    "Cinema Grade": "Cor: cinema",
    "Color & Contrast Crunch": "Cor e contraste fortes",
    "Color Pop Grade": "Cor: cores vivas",
    "Commercial Fashion Grade": "Cor: moda e comercial",
    "Corner Turns": "Viradas de canto",
    "Corporate": "Corporativo",
    "Crash Cuts": "Cortes de impacto",
    "Crashers FX": "Impactos FX",
    "Damage Cuts": "Cortes danificados",
    "Damaged Projector Slides": "Projetor danificado",
    "Datamosh": "Datamosh",
    "Decode": "Decodificação",
    "Digital": "Digital",
    "Digital Destruction (Heavy Render)": "Destruição digital (render pesado)",
    "Digital Havoc Transformations": "Caos digital",
    "Disoriented": "Desorientação",
    "Distortion Cuts FX": "Cortes com distorção",
    "Dragstrip Snap FX": "Estalo de arrancada",
    "Drama Loop": "Drama (loop)",
    "Dreamy FX": "Sonho",
    "Drones": "Drones (sons contínuos)",
    "Drops": "Quedas",
    "Duo Tone Grade": "Cor: duas tonalidades",
    "Dystopian": "Distopia",
    "Echo Shakes FX": "Tremidas com eco",
    "Edge Spin FX": "Giro pela borda",
    "Exposure Blurs": "Desfoque com exposição",
    "Fade": "Fade",
    "Fade & Position": "Fade e posição",
    "Fade & Scale & Tracking": "Fade, escala e espaçamento",
    "Fades": "Fades",
    "Fades & Blur FX": "Fades e desfoque FX",
    "Fades & Blurs": "Fades e desfoques",
    "Fast Blur Cuts": "Cortes com desfoque rápido",
    "Film": "Cinema",
    "Film Damage Overlays": "Sobreposições de filme danificado",
    "Film FX": "Película FX",
    "Film FX Builder (Part 1)": "Montador de película (parte 1)",
    "Film FX Builder (Part 2)": "Montador de película (parte 2)",
    "Film Frame Overlays": "Sobreposições de moldura de filme",
    "Film Gate": "Janela de projetor",
    "Film Grade": "Cor: película",
    "Film Reel": "Rolo de filme",
    "Flash Fade FX": "Fade com flash",
    "Flash Freeze Time Statics": "Flash com tempo congelado",
    "Flicker": "Cintilação",
    "FlyBy": "Passagem rápida",
    "Footstep SFX": "Passos",
    "Fracture": "Fratura",
    "Fracture Swipe FX": "Swipe com fratura",
    "Fragments": "Fragmentos",
    "Fragments - Broken Film (Part 1)": "Fragmentos: filme quebrado (parte 1)",
    "Fragments - Broken Film (Part 2)": "Fragmentos: filme quebrado (parte 2)",
    "Fragments - Broken Film (Part 3)": "Fragmentos: filme quebrado (parte 3)",
    "Fragments - Broken Film (Part 4)": "Fragmentos: filme quebrado (parte 4)",
    "Fragments - Broken Film (Part 5)": "Fragmentos: filme quebrado (parte 5)",
    "Fragments - Camera Shakes": "Fragmentos: tremidas de câmera",
    "Fragments - Dreamy FX": "Fragmentos: sonho",
    "Fragments - Heavy Glitches (Part 1)": "Fragmentos: glitch pesado (parte 1)",
    "Fragments - Heavy Glitches (Part 2)": "Fragmentos: glitch pesado (parte 2)",
    "Fragments - Light Glitches": "Fragmentos: glitch leve",
    "Fragments - VHS FX": "Fragmentos: VHS",
    "Framing & Letterbox": "Enquadramento e tarjas",
    "Full Credits Layout": "Créditos completos",
    "Gate Shakes": "Tremidas de projetor",
    "Glare FX": "Clarão",
    "Glare Overlays": "Sobreposições de clarão",
    "Glitch": "Glitch",
    "Glitch Cuts": "Cortes glitch",
    "Glitch FX": "Glitch FX",
    "Glitch FX Builder (Part 1)": "Montador de glitch (parte 1)",
    "Glitch FX Builder (Part 2)": "Montador de glitch (parte 2)",
    "Glitch Madness": "Glitch extremo",
    "Glitch Slides": "Deslizes glitch",
    "Glitch Sound Effects": "Sons de glitch",
    "Glitch Swipes": "Swipes glitch",
    "Glitch Warp Stretch": "Glitch com deformação",
    "Glitched Slide": "Deslize com glitch",
    "Glitches": "Glitches",
    "Glitchy Loop": "Glitch (loop)",
    "Glow FX": "Brilho",
    "Gritty Flicker Overlays": "Sobreposições de cintilação suja",
    "Grunge Cuts": "Cortes grunge",
    "Grunge FX": "Grunge",
    "HDR Grade": "Cor: HDR",
    "Handheld Camera": "Câmera na mão",
    "Handheld Camera 3D": "Câmera na mão 3D",
    "Heavy Glitch": "Glitch pesado",
    "Hits": "Batidas",
    "Holiday - Christmas": "Feriados: Natal",
    "Horror": "Terror",
    "Hyper Pro Grade": "Cor: hiper profissional",
    "Instagram Grade": "Cor: Instagram",
    "Interlace Cuts": "Cortes entrelaçados",
    "Inverts": "Inversões",
    "Kinetic": "Cinético",
    "Kinetic 2": "Cinético 2",
    "Kinetic 3": "Cinético 3",
    "Landscape": "Paisagem",
    "Laser Sweeps": "Varreduras de laser",
    "Lens Distortion": "Distorção de lente",
    "Lens Haze FX": "Névoa de lente",
    "Liftoff Slides": "Deslizes de decolagem",
    "Liftoff Slides FX": "Deslizes de decolagem FX",
    "Light Glitch": "Glitch leve",
    "Light Leak Cuts": "Cortes com vazamento de luz",
    "Light Leak FX": "Vazamento de luz",
    "Lyric": "Letra de música",
    "Marker Cuts": "Cortes de marcador",
    "Mayhem": "Bagunça",
    "Mayhem FX": "Bagunça FX",
    "Miscellaneous": "Diversos",
    "Modern": "Moderno",
    "Modern Grade": "Cor: moderna",
    "Motion Parallax FX": "Parallax",
    "Movie Reel": "Rolo de cinema",
    "Movie Reel FX": "Rolo de cinema FX",
    "Movie Trailers": "Trailers de cinema",
    "Multi-Screen Kit (1080x1920)": "Várias telas (1080x1920)",
    "Multi-Screen Kit (2160x2160)": "Várias telas (2160x2160)",
    "Multi-Screen Kit (Broadcast)": "Várias telas (TV)",
    "Music Score - Downtown Grind Master": "Trilha: Downtown Grind Master",
    "Music Score - Miami Nights": "Trilha: Miami Nights",
    "Night FX": "Noite",
    "Old Channels": "Canais antigos",
    "Organic Lush Grade": "Cor: orgânica",
    "Pads": "Pads",
    "Panoramic": "Panorâmica",
    "Panoramic FX": "Panorâmica FX",
    "Panoramic Slides FX": "Deslizes panorâmicos",
    "Panoramics": "Panorâmicas",
    "Perspective Spin": "Giro em perspectiva",
    "Photo Frame FX In": "Moldura de foto (entrada)",
    "Photo Frame FX Out": "Moldura de foto (saída)",
    "Photo Slides": "Slides de foto",
    "Pixelation": "Pixelização",
    "Portrait": "Vertical",
    "Position": "Posição",
    "Position & Rotate": "Posição e rotação",
    "Position & Rotate & Scale": "Posição, rotação e escala",
    "Position & Scale": "Posição e escala",
    "Position 2D Rotation": "Posição com rotação 2D",
    "Position 3D Rotate & Spin": "Posição com rotação 3D e giro",
    "Position Bounce": "Posição com quique",
    "Position Rotate & Spin": "Posição com rotação e giro",
    "Position Rubber": "Posição elástica",
    "Position Scale": "Posição e escala",
    "Position Tilt Swivel": "Posição com inclinação",
    "Position Turn Tilt": "Posição com virada",
    "Position Wobble": "Posição com balanço",
    "Pull Snaps": "Puxões",
    "Pull Snaps FX": "Puxões FX",
    "Pull Strip": "Tira puxada",
    "Pull Strip FX": "Tira puxada FX",
    "Pulse Sweeps": "Varreduras de pulso",
    "Quake Cuts": "Cortes com terremoto",
    "Quick Glitch": "Glitch rápido",
    "Quick Stretch": "Esticada rápida",
    "Quick Swipes": "Swipes rápidos",
    "Quick Whips": "Chicotadas rápidas",
    "Rack Focus FX": "Troca de foco",
    "Reel Bounce FX": "Rolo com quique",
    "Reelstretch": "Rolo esticado",
    "Reflection FX": "Reflexo",
    "Reverse & Risers": "Reversos e subidas",
    "Roaring Swoosh": "Swoosh forte",
    "Rolling Credit Sections": "Créditos rolando (seções)",
    "Rolling Credits Sequences": "Créditos rolando (sequências)",
    "Rotate FX": "Rotação FX",
    "Rotate Positions": "Rotação e posição",
    "Rotation": "Rotação",
    "Rotation & Position": "Rotação e posição",
    "Rotation Babies": "Rotações pequenas",
    "Rotator Cuts": "Cortes giratórios",
    "Rubberbands": "Elásticos",
    "Rumble": "Estrondo",
    "Rumbles": "Estrondos",
    "Scale": "Escala",
    "Scale & Position": "Escala e posição",
    "Scale & Rotation": "Escala e rotação",
    "Scale & Skew": "Escala e inclinação",
    "Scale & Tracking": "Escala e espaçamento",
    "Scope Shake FX": "Tremida de mira",
    "Scope Shakes": "Tremidas de mira",
    "Scratch Cuts": "Cortes riscados",
    "Scratch Swipe Slice Cuts": "Cortes riscados com swipe",
    "Screen Scale FX (Animated)": "Escala de tela (animada)",
    "Screen Scale FX (Static)": "Escala de tela (fixa)",
    "Seamless Camera Moves DOF": "Câmera contínua com profundidade",
    "Seamless Camera Moves No DOF": "Câmera contínua sem profundidade",
    "Security Camera FX": "Câmera de segurança",
    "Shake": "Tremida",
    "Shake & Quake FX": "Tremida e terremoto",
    "Shake & Spin FX": "Tremida e giro",
    "Shake Cuts": "Cortes com tremida",
    "Shake FX": "Tremida FX",
    "Shakers": "Tremidas",
    "Shape FX": "Formas FX",
    "Shapes": "Formas",
    "Shimmy Shakes FX": "Tremidas de balanço",
    "Shimmy Slides": "Deslizes de balanço",
    "Shock Swipe Cuts": "Cortes de choque com swipe",
    "Slide Projector (Part 1)": "Projetor de slides (parte 1)",
    "Slide Projector (Part 2)": "Projetor de slides (parte 2)",
    "Slide Quakes": "Deslizes com terremoto",
    "Slide Snaps FX": "Deslizes com estalo",
    "Slide Swipers": "Deslizes swipe",
    "Slides": "Deslizes",
    "Slides Basic FX": "Deslizes básicos",
    "Slides Glitched FX": "Deslizes com glitch",
    "Slideshow Projector": "Projetor de slides",
    "Slip Cuts": "Cortes escorregados",
    "Slip Slides": "Deslizes escorregados",
    "Slip Slides FX": "Deslizes escorregados FX",
    "Slish Slide Bounce": "Deslize com quique",
    "Soft Gradient Style Grade": "Cor: degradê suave",
    "Solo Credit Blocks - Movement C-L": "Bloco de crédito animado (centro, baixo)",
    "Solo Credit Blocks - Movement C-M": "Bloco de crédito animado (centro, meio)",
    "Solo Credit Blocks - Movement L-L": "Bloco de crédito animado (esquerda, baixo)",
    "Solo Credit Blocks - Movement L-M": "Bloco de crédito animado (esquerda, meio)",
    "Solo Credit Blocks - Movement L-U": "Bloco de crédito animado (esquerda, cima)",
    "Solo Credit Blocks - Movement R-L": "Bloco de crédito animado (direita, baixo)",
    "Solo Credit Blocks - Movement R-M": "Bloco de crédito animado (direita, meio)",
    "Solo Credit Blocks - Movement R-U": "Bloco de crédito animado (direita, cima)",
    "Solo Credit Blocks - Static C-L": "Bloco de crédito fixo (centro, baixo)",
    "Solo Credit Blocks - Static C-M": "Bloco de crédito fixo (centro, meio)",
    "Solo Credit Blocks - Static L-L": "Bloco de crédito fixo (esquerda, baixo)",
    "Solo Credit Blocks - Static L-M": "Bloco de crédito fixo (esquerda, meio)",
    "Solo Credit Blocks - Static L-U": "Bloco de crédito fixo (esquerda, cima)",
    "Solo Credit Blocks - Static R-L": "Bloco de crédito fixo (direita, baixo)",
    "Solo Credit Blocks - Static R-M": "Bloco de crédito fixo (direita, meio)",
    "Solo Credit Blocks - Static R-U": "Bloco de crédito fixo (direita, cima)",
    "Solo Credit Sequences": "Sequências de crédito",
    "Spin Shakes": "Tremidas com giro",
    "Spin Swish": "Giro com swish",
    "Spin Warp Shake FX": "Giro, deformação e tremida",
    "Spin Wheel FX": "Roda girando",
    "Spinners": "Giros",
    "Splice Cuts": "Cortes de emenda",
    "Split Perspectives": "Perspectivas divididas",
    "Split Screen FX": "Tela dividida",
    "Splitter Cuts": "Cortes divididos",
    "Square": "Quadrado",
    "Static Credits": "Créditos fixos",
    "Static Cuts": "Cortes com estática",
    "Stretch Snaps": "Esticadas com estalo",
    "Stretch Snaps FX": "Esticadas com estalo FX",
    "Stretch Swipes": "Swipes esticados",
    "Style Effects": "Estilos",
    "Suspense Loop": "Suspense (loop)",
    "Sweeps": "Varreduras",
    "Swellers": "Crescendos",
    "Swingers": "Balanços",
    "Swingers FX": "Balanços FX",
    "Swipe": "Swipe",
    "Swipe Bounce": "Swipe com quique",
    "Swipe FX": "Swipe FX",
    "Swipe Quakes": "Swipes com terremoto",
    "Swipe Shakes": "Swipes com tremida",
    "Swipe Slides": "Swipes deslizantes",
    "Swipes": "Swipes",
    "Swish Hits": "Swish com batida",
    "Swish Swipers (Part 1)": "Swish swipe (parte 1)",
    "Swish Swipers (Part 2)": "Swish swipe (parte 2)",
    "Swish Swipers FX": "Swish swipe FX",
    "Swishes": "Swishes",
    "Swoop Turns": "Viradas em mergulho",
    "Swooshes": "Swooshes",
    "TV Channel": "Canal de TV",
    "Text & Title Transitions": "Transições de texto e título",
    "Text Animations": "Animações de texto",
    "Time Stretch": "Esticar o tempo",
    "Track Turn": "Virada de trilha",
    "Track Turn FX": "Virada de trilha FX",
    "Track and Spin": "Trilha e giro",
    "Tracker Swoosh FX": "Swoosh com rastreio",
    "Trailer Elements - Analogica": "Elementos de trailer: Analogica",
    "Trailer Elements - Breaking Point": "Elementos de trailer: Breaking Point",
    "Trailer Elements - Epic World": "Elementos de trailer: Epic World",
    "Trailer Elements - Escape": "Elementos de trailer: Escape",
    "Trailer Elements - Munich Nights": "Elementos de trailer: Munich Nights",
    "Trailer Elements - Shadow Game": "Elementos de trailer: Shadow Game",
    "Trailer Elements - The Last Storm": "Elementos de trailer: The Last Storm",
    "Trailer Elements - Wizard Walz": "Elementos de trailer: Wizard Walz",
    "Travel Grade": "Cor: viagem",
    "Turn Cuts": "Cortes com virada",
    "Turn Spins FX": "Viradas com giro",
    "Twirl Wobble": "Redemoinho com balanço",
    "Uppers to Downers": "De cima para baixo",
    "Urban Grade": "Cor: urbana",
    "Urban Loop": "Urbano (loop)",
    "Urban Titles": "Títulos urbanos",
    "VHS FX Builder (Part 1)": "Montador de VHS (parte 1)",
    "VHS FX Builder (Part 2)": "Montador de VHS (parte 2)",
    "VHS FX Builder (Part 3)": "Montador de VHS (parte 3)",
    "VHS Look Grade": "Cor: VHS",
    "VHS Looks (Part 1)": "Visual VHS (parte 1)",
    "VHS Looks (Part 2)": "Visual VHS (parte 2)",
    "VHS Looks (Part 3)": "Visual VHS (parte 3)",
    "VHS Looks (Part 4)": "Visual VHS (parte 4)",
    "Video Degraded FX": "Vídeo degradado",
    "Vintage Grade": "Cor: vintage",
    "Warp Drive": "Dobra espacial",
    "Warp Quake": "Deformação com terremoto",
    "Warp Rotations": "Rotações com deformação",
    "Warp Spin Shakes": "Deformação, giro e tremida",
    "Warp Spins": "Giros com deformação",
    "Warp Stretch": "Deformação esticada",
    "Warp Stretch FX": "Deformação esticada FX",
    "Warp Wipe Cuts": "Cortes com deformação",
    "Wedding Grade": "Cor: casamento",
    "Whip Pull FX": "Chicotada puxada",
    "Whipper Snapper Bump Style": "Chicotada com solavanco",
    "Whipper Snapper Smooth": "Chicotada suave",
    "Whooshes": "Whooshes",
    "Zoom": "Zoom",
    "Zoom Cuts": "Cortes com zoom",
    "Zoom Rotate": "Zoom com rotação",
    "Zooms": "Zooms"
  };

  function categoryLabel(name) {
    var n = String(name || "");
    return Object.prototype.hasOwnProperty.call(CATEGORY_PT, n) ? CATEGORY_PT[n] : n;
  }

  function parseCatalog(text) {
    var data;
    try {
      data = typeof text === "string" ? JSON.parse(text.replace(/^﻿/, "")) : text;
    } catch (e) {
      throw new Error("O catalog.json está corrompido (" + e.message + ").");
    }
    if (!data || data.format !== "fx-library-catalog") {
      throw new Error("Este arquivo não é o catálogo da biblioteca de efeitos (catalog.json).");
    }
    if (data.version !== 1 && data.version !== 2) {
      throw new Error("Catálogo na versão " + data.version + ": atualize o App Legendas para usar esta biblioteca.");
    }
    EFFECT_SECTIONS.forEach(function (s) {
      if (!Array.isArray(data[s.id])) data[s.id] = [];
    });
    return data;
  }

  // Pacote de presets que só tem áudio (Sound Master, Trailer Sound, Music...): não é efeito de vídeo.
  function audioOnly(pack) {
    var n = 0;
    var ok = (pack.categories || []).every(function (c) {
      return (c.items || []).every(function (raw) {
        n += 1;
        return raw && raw.kind === "audio";
      });
    });
    return ok && n > 0;
  }

  // As abas que o painel mostra. Os presets traziam 4.964 sons e músicas no meio dos 4.089 efeitos
  // ("Efeitos 9053", com "Sons 608" ao lado): os pacotes só de áudio vão para Sons e os de música
  // para Músicas. Cada pacote guarda de onde veio (src), que é como o item é lido.
  function viewOf(catalog) {
    if (!catalog) return {};
    if (catalog.__view) return catalog.__view;
    var view = {};
    EFFECT_SECTIONS.forEach(function (s) {
      view[s.id] = [];
    });
    (catalog.presets || []).forEach(function (pack) {
      var to = !audioOnly(pack) ? "presets" : /music|música/i.test(pack.name) ? "music" : "soundEffects";
      view[to].push({ name: pack.name, categories: pack.categories || [], src: "presets" });
    });
    ["motionPresets", "textAnimation", "mogrt"].forEach(function (id) {
      var list = catalog[id] || [];
      if (list.length) view[id].push({ name: SECTION_LABEL[id], categories: list, src: id });
    });
    // os sons avulsos primeiro (os curtos de edição), depois os pacotes de sound design
    if ((catalog.soundEffects || []).length) view.soundEffects.unshift({ name: "Sons de edição", categories: catalog.soundEffects, src: "soundEffects" });
    try {
      Object.defineProperty(catalog, "__view", { value: view, enumerable: false });
    } catch (e) {}
    return view;
  }

  function packsOf(catalog, sectionId) {
    return viewOf(catalog)[sectionId] || [];
  }

  function sectionTree(catalog, sectionId) {
    return packsOf(catalog, sectionId).map(function (pack) {
      return {
        name: pack.name,
        categories: (pack.categories || []).map(function (c) {
          return { name: c.name, label: categoryLabel(c.name), count: (c.items || []).length };
        }),
      };
    });
  }

  function sectionCount(catalog, sectionId) {
    return packsOf(catalog, sectionId).reduce(function (n, pack) {
      return n + (pack.categories || []).reduce(function (m, c) {
        return m + (c.items || []).length;
      }, 0);
    }, 0);
  }

  // Som de um efeito: { name, file } (v2) ou só o caminho (v1, o nome é o do arquivo).
  function soundEntry(s) {
    if (!s) return null;
    if (typeof s === "string") return { name: s.replace(/^.*[\\/]/, ""), file: s };
    return s.file ? { name: String(s.name || s.file.replace(/^.*[\\/]/, "")), file: s.file } : null;
  }

  function normalize(sectionId, pack, category, raw) {
    var src = pack.src || sectionId; // de onde o item veio no catalog.json: é assim que ele é lido
    var it = {
      key: "",
      section: sectionId,
      kind: "",
      name: String(raw.name || ""),
      pack: src === "presets" ? pack.name : "",
      category: categoryLabel(category.name),
      categoryName: category.name,
      file: null,
      thumb: raw.thumb || null,
      preview: raw.preview || null,
      audio: null,
      sounds: [],
      direction: raw.direction || null,
      motion: null,
      still: null,
      // filtros que o Premiere atual não tem (o efeito entra incompleto): o painel avisa
      missing: Array.isArray(raw.missing) && raw.missing.length ? raw.missing.map(String) : null,
    };
    if (src === "presets") {
      it.kind = raw.kind === "audio" ? "audio" : "fx";
      it.file = raw.kind === "audio" ? raw.audio : raw.project;
      it.audio = raw.kind === "audio" ? raw.audio : null;
      it.sounds = (Array.isArray(raw.sounds) ? raw.sounds : []).map(soundEntry).filter(Boolean);
    } else if (src === "motionPresets") {
      it.kind = "motion";
      it.motion = { in: raw.in || null, out: raw.out || null };
      var first = raw.in || raw.out || {};
      it.file = first.project || null;
      it.preview = first.preview || null;
      // quadro de repouso do cartão: o começo da SAÍDA mostra o elemento parado na tela (o da
      // entrada começa vazio, antes de ele entrar)
      it.still = (raw.out && raw.out.preview) || null;
    } else if (src === "soundEffects") {
      it.kind = "audio";
      it.file = raw.file;
      it.audio = raw.file;
    } else {
      it.kind = "mogrt";
      it.file = raw.file;
    }
    it.key = src + ":" + (it.file || pack.name + "/" + category.name + "/" + it.name);
    return it;
  }

  function effectItems(catalog, sectionId, packIndex, categoryIndex) {
    var pack = packsOf(catalog, sectionId)[packIndex];
    var category = pack && (pack.categories || [])[categoryIndex];
    if (!category) return [];
    return (category.items || [])
      .map(function (raw) {
        return normalize(sectionId, pack, category, raw);
      })
      .filter(function (it) {
        return !!it.file;
      });
  }

  function fold(text) {
    return String(text || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "");
  }

  // Todas as palavras precisam aparecer no nome, na categoria ou no pacote. Ordem: nome igual à
  // busca, nome que começa com ela, todas as palavras no nome, e só então o que bate pelo pacote ou
  // pela categoria; no empate, a aba aberta (options.prefer) vem antes das outras. Sem isso,
  // "Position 01" na aba Movimento mostrava primeiro um efeito do Animation Master (fx-2, no real).
  function searchEffects(catalog, query, options) {
    var opts = options || {};
    var words = fold(query).split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    var whole = words.join(" ");
    var limit = opts.limit || 300;
    var sections = opts.section ? [opts.section] : EFFECT_SECTIONS.map(function (s) {
      return s.id;
    });
    var found = [];
    for (var s = 0; s < sections.length; s += 1) {
      var packs = packsOf(catalog, sections[s]);
      for (var p = 0; p < packs.length; p += 1) {
        var cats = packs[p].categories || [];
        for (var c = 0; c < cats.length; c += 1) {
          var hay = fold(packs[p].name + " " + cats[c].name + " " + categoryLabel(cats[c].name));
          var items = effectItems(catalog, sections[s], p, c);
          for (var i = 0; i < items.length; i += 1) {
            var name = fold(items[i].name).replace(/\s+/g, " ").trim();
            var text = hay + " " + name;
            if (!words.every(function (w) { return text.indexOf(w) >= 0; })) continue;
            var rank = name === whole ? 0
              : name.indexOf(whole) === 0 ? 1
              : words.every(function (w) { return name.indexOf(w) >= 0; }) ? 2 : 3;
            found.push({ item: items[i], rank: rank, other: opts.prefer && sections[s] !== opts.prefer ? 1 : 0, at: found.length });
          }
        }
      }
    }
    found.sort(function (a, b) {
      return a.rank - b.rank || a.other - b.other || a.at - b.at;
    });
    return found.slice(0, limit).map(function (f) {
      return f.item;
    });
  }

  // Caminho do catálogo que fica dentro da pasta da biblioteca. Na biblioteca online o catálogo vem
  // da internet e o painel grava no disco o que ele mandar: "../", "C:\", "\\servidor", "/etc" ou
  // ":" (fluxo alternativo do NTFS) poriam o arquivo fora da pasta (achado do app-legendas-f3).
  function safeRel(rel) {
    if (typeof rel !== "string" || !rel) return false;
    if (/[\u0000-\u001f\u007f:]/.test(rel)) return false;
    if (/^[\\/]/.test(rel)) return false;
    return rel.split(/[\\/]+/).every(function (part) {
      return part !== ".." && part !== ".";
    });
  }

  function libraryPath(rootPath, rel, windows) {
    if (!safeRel(rel)) return null;
    var base = String(rootPath || "").replace(/[\\/]+$/, "");
    var full = base + "/" + rel;
    return windows ? full.replace(/\//g, "\\") : full.replace(/\\/g, "/");
  }

  // Biblioteca online: os caminhos do catálogo são os mesmos, debaixo do endereço base.
  function remoteUrl(base, rel) {
    if (!base || !safeRel(rel)) return null;
    return String(base).replace(/\/*$/, "/") + String(rel).replace(/\\/g, "/").replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
  }

  // Arquivos que um item precisa no disco para ser aplicado (miniatura e prévia tocam da nuvem).
  function itemFiles(it) {
    var out = [];
    function add(f) {
      if (f && out.indexOf(f) < 0) out.push(f);
    }
    add(it.file);
    (it.sounds || []).forEach(function (s) {
      add(s.file);
    });
    if (it.motion) {
      if (it.motion.in) add(it.motion.in.project);
      if (it.motion.out) add(it.motion.out.project);
    }
    return out;
  }

  // Tudo de um pacote (ex.: baixar só os sons de um pack de áudio).
  // Nomes para os cartões de uma categoria: tira o começo que todos repetem até um " - " ("Spin
  // Warp Shake - Left (Fast)" vira "Left (Fast)"), que era justamente o que o corte do cartão
  // deixava à vista. Sem prefixo comum, ou se algum nome ficasse vazio, devolve os nomes como vieram.
  function shortNames(names) {
    var list = (names || []).map(String);
    if (list.length < 2) return list;
    var common = list[0];
    for (var i = 1; i < list.length && common; i += 1) {
      var j = 0;
      while (j < common.length && j < list[i].length && common.charAt(j) === list[i].charAt(j)) j += 1;
      common = common.slice(0, j);
    }
    var cut = Math.max(common.lastIndexOf(" - "), common.lastIndexOf(" – "));
    if (cut < 1) return list;
    var out = list.map(function (n) {
      return n.slice(cut + 3).trim();
    });
    return out.every(Boolean) ? out : list;
  }

  // Itens pelas chaves (favoritos e usados recentemente), na ordem das chaves; chave que não existe
  // mais na biblioteca (outra versão do catálogo) fica de fora.
  function itemsByKeys(catalog, keys) {
    if (!catalog) return [];
    var index = catalog.__keys;
    if (!index) {
      index = {};
      EFFECT_SECTIONS.forEach(function (s) {
        packsOf(catalog, s.id).forEach(function (pack, p) {
          (pack.categories || []).forEach(function (c, ci) {
            effectItems(catalog, s.id, p, ci).forEach(function (it) {
              if (!index[it.key]) index[it.key] = it;
            });
          });
        });
      });
      try {
        Object.defineProperty(catalog, "__keys", { value: index, enumerable: false });
      } catch (e) {}
    }
    var out = [];
    (keys || []).forEach(function (k) {
      if (index[k] && out.indexOf(index[k]) < 0) out.push(index[k]);
    });
    return out;
  }

  function packFiles(catalog, sectionId, packIndex) {
    var pack = sectionTree(catalog, sectionId)[packIndex];
    var out = [];
    if (!pack) return out;
    pack.categories.forEach(function (c, ci) {
      effectItems(catalog, sectionId, packIndex, ci).forEach(function (it) {
        itemFiles(it).forEach(function (f) {
          if (out.indexOf(f) < 0) out.push(f);
        });
      });
    });
    return out;
  }

  return {
    EFFECT_SECTIONS: EFFECT_SECTIONS,
    parseCatalog: parseCatalog,
    sectionTree: sectionTree,
    sectionCount: sectionCount,
    effectItems: effectItems,
    searchEffects: searchEffects,
    libraryPath: libraryPath,
    safeRel: safeRel,
    remoteUrl: remoteUrl,
    itemFiles: itemFiles,
    packFiles: packFiles,
    shortNames: shortNames,
    categoryLabel: categoryLabel,
    itemsByKeys: itemsByKeys,
  };
});
