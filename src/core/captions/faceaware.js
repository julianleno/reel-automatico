/**
 * Legenda que desvia do rosto: quando a faixa da legenda cai em cima do rosto, ela sobe ou desce
 * para o lado mais perto, sem sair da área segura (safezone.js). Tudo em fração da altura da
 * sequência (0 = topo, 1 = base).
 *
 * captionBand(style, { width, height, lines }) -> { center, half }
 *   a faixa que a legenda ocupa, com a mesma conta do desenho (services/render.js drawFrame):
 *   centro em positionY, altura = linhas x fontSize x 1,23 x (1 + entrelinha); sem lines, usa as
 *   "Linhas" do estilo ou 2 (o caso mais alto).
 * safeLimits(zones, ids) -> { top, bottom }: o espaço livre entre as faixas das plataformas.
 * dodgeFace(face, band, safe, margin) -> o positionY novo (%, uma casa) ou null
 *   face = { top, bottom }; null quando a legenda não encosta no rosto (com a folga) ou quando
 *   nenhum dos dois lados cabe na área segura (aí ela fica onde está).
 */
(function (root, factory) {
  // No painel CEP o Node também define `module`; lá o destino é o global do painel.
  if (typeof window === "undefined" && typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    var api = factory();
    root.AppLegendasCore = root.AppLegendasCore || {};
    root.AppLegendasCore.captionBand = api.captionBand;
    root.AppLegendasCore.safeLimits = api.safeLimits;
    root.AppLegendasCore.dodgeFace = api.dodgeFace;
    root.AppLegendasCore.FACE_MARGIN = api.MARGIN;
  }
})(typeof self !== "undefined" ? self : this, function () {
  var MARGIN = 0.02; // folga entre o rosto e a legenda (2% da altura, uns 38 px em 1920)

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function captionBand(style, o) {
    var W = (o && o.width) || 1080, H = (o && o.height) || 1920;
    var px = clamp(Number(style.fontSize) || 86, 10, 300) * (Math.min(W, H) / 1080);
    var lines = Math.max(1, Math.round(Number(o && o.lines) || Number(style.maxLines) || 2));
    var lineHeight = px * 1.23 * (1 + clamp(Number(style.leading) || 0, -40, 100) / 100);
    return { center: clamp(Number(style.positionY) || 55, 5, 95) / 100, half: (lines * lineHeight) / 2 / H };
  }

  function safeLimits(zones, ids) {
    var list = Object.keys(zones || {}).filter(function (id) { return !ids || !ids.length || ids.indexOf(id) >= 0; }).map(function (id) { return zones[id]; });
    if (!list.length) return { top: 0, bottom: 1 };
    return {
      top: Math.max.apply(null, list.map(function (z) { return z.top; })),
      bottom: 1 - Math.max.apply(null, list.map(function (z) { return z.bottom; })),
    };
  }

  function dodgeFace(face, band, safe, margin) {
    if (!face || !band || !(face.bottom > face.top)) return null;
    var m = margin === undefined ? MARGIN : margin;
    var limits = safe || { top: 0, bottom: 1 };
    var near0 = face.top - m, near1 = face.bottom + m;
    if (band.center + band.half <= near0 || band.center - band.half >= near1) return null;
    var options = [];
    var above = near0 - band.half, below = near1 + band.half;
    if (above - band.half >= limits.top) options.push(above);
    if (below + band.half <= limits.bottom) options.push(below);
    if (!options.length) return null;
    options.sort(function (a, b) { return Math.abs(a - band.center) - Math.abs(b - band.center); });
    // arredonda para longe do rosto: a casa decimal nunca devolve a legenda para cima dele
    var y = options[0] * 1000;
    return (options[0] > band.center ? Math.ceil(y - 1e-9) : Math.floor(y + 1e-9)) / 10;
  }

  return { captionBand: captionBand, safeLimits: safeLimits, dodgeFace: dodgeFace, MARGIN: MARGIN };
});
