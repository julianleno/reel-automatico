/**
 * Área segura dos vídeos verticais: as faixas da tela que o Instagram (Reels), o TikTok e o
 * YouTube Shorts cobrem com o nome do perfil, a descrição, a música e a coluna de botões.
 *
 * Nenhuma das três publica essas medidas, e os guias de 2026 discordam entre si
 * (docs/estudo-interface.md). Os números abaixo, em fração da tela, ficam do lado prudente:
 * fora das faixas a legenda não fica embaixo de nada.
 *
 * SAFE_ZONES[id] = { label, top, bottom, left, right, rightFrom }
 *   top/bottom: faixas inteiras (fração da altura); left/right: faixas dos lados (fração da
 *   largura); a da direita (botões) só vale de rightFrom para baixo.
 * safeZoneIssues(box, ids) -> [{ id, label, sides: ["top" | "bottom" | "left" | "right"] }]
 *   box = { left, top, right, bottom } da legenda, em frações da tela (0..1).
 * liftIntoSafe(box, ids) -> quanto mover na vertical (fração; negativo sobe) para sair das faixas
 *   de cima e de baixo; 0 se já está fora; null se não cabe entre as duas.
 * shrinkIntoSafe(box, ids) -> por quanto multiplicar a largura (legenda centrada) para sair da
 *   coluna de botões e das bordas; 1 se já está fora. Subir até acima dos botões jogaria a legenda
 *   para o terço de cima, então a correção é diminuir a letra.
 */
(function (root, factory) {
  // No painel CEP o Node também define `module`; lá o destino é o global do painel.
  if (typeof window === "undefined" && typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    var api = factory();
    root.AppLegendasCore = root.AppLegendasCore || {};
    root.AppLegendasCore.SAFE_ZONES = api.SAFE_ZONES;
    root.AppLegendasCore.safeZoneIssues = api.safeZoneIssues;
    root.AppLegendasCore.liftIntoSafe = api.liftIntoSafe;
    root.AppLegendasCore.shrinkIntoSafe = api.shrinkIntoSafe;
  }
})(typeof self !== "undefined" ? self : this, function () {
  // Em 1080x1920. Topo e rodapé do lado prudente: Reels 210/420 px, TikTok 130/480, Shorts
  // 120/400. Coluna de botões no meio-termo dos guias (Reels 84-120 px, TikTok 120-151,
  // Shorts 96-192): os ícones são estreitos e centrados na faixa, e o lado prudente acusava
  // até o estilo padrão. Começa na metade de baixo da tela. Lados: 60 px.
  var SAFE_ZONES = {
    reels: { label: "Reels", top: 0.11, bottom: 0.22, left: 0.055, right: 0.1, rightFrom: 0.55 },
    tiktok: { label: "TikTok", top: 0.07, bottom: 0.25, left: 0.055, right: 0.125, rightFrom: 0.5 },
    shorts: { label: "Shorts", top: 0.06, bottom: 0.21, left: 0.055, right: 0.13, rightFrom: 0.55 },
  };

  function zonesOf(ids) {
    return (ids && ids.length ? ids : Object.keys(SAFE_ZONES)).filter(function (id) {
      return Object.prototype.hasOwnProperty.call(SAFE_ZONES, id);
    });
  }

  // 1% de folga: as faixas são aproximadas e a medida é feita em 1/4 da resolução; quem só
  // encosta na borda (o estilo padrão vai até 87% da largura, a borda do Shorts) não é acusado.
  var TOLERANCE = 0.01;

  function sidesHit(box, z) {
    var sides = [];
    if (box.top < z.top - TOLERANCE) sides.push("top");
    if (box.bottom > 1 - z.bottom + TOLERANCE) sides.push("bottom");
    if (box.left < z.left - TOLERANCE) sides.push("left");
    if (box.right > 1 - z.right + TOLERANCE && box.bottom > z.rightFrom + TOLERANCE) sides.push("right");
    return sides;
  }

  function safeZoneIssues(box, ids) {
    var out = [];
    zonesOf(ids).forEach(function (id) {
      var sides = sidesHit(box, SAFE_ZONES[id]);
      if (sides.length) out.push({ id: id, label: SAFE_ZONES[id].label, sides: sides });
    });
    return out;
  }

  function liftIntoSafe(box, ids) {
    var zones = zonesOf(ids).map(function (id) {
      return SAFE_ZONES[id];
    });
    if (!zones.length) return 0;
    var ceiling = Math.max.apply(null, zones.map(function (z) { return z.top; }));
    var floor = 1 - Math.max.apply(null, zones.map(function (z) { return z.bottom; }));
    if (box.bottom - box.top > floor - ceiling) return null;
    if (box.bottom > floor) return floor - box.bottom;
    if (box.top < ceiling) return ceiling - box.top;
    return 0;
  }

  function shrinkIntoSafe(box, ids) {
    var scale = 1;
    zonesOf(ids).forEach(function (id) {
      var z = SAFE_ZONES[id];
      // a margem da esquerda vale em qualquer altura; a coluna de botões, só da altura dela para baixo
      var half = Math.max(box.right - 0.5, 0.5 - box.left);
      var room = 0.5 - (box.bottom > z.rightFrom ? Math.max(z.right, z.left) : z.left);
      if (half > room) scale = Math.min(scale, room / half);
    });
    return scale;
  }

  return { SAFE_ZONES: SAFE_ZONES, safeZoneIssues: safeZoneIssues, liftIntoSafe: liftIntoSafe, shrinkIntoSafe: shrinkIntoSafe };
});
