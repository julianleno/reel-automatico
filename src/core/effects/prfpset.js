/**
 * Lê uma predefinição de efeitos do Premiere (.prfpset, XML) para recriar no clipe pelo host
 * (issue #4). O Premiere não tem API para aplicar .prfpset; o host adiciona cada efeito e grava
 * os valores e as chaves que saem daqui.
 *
 * parsePrfpset(xml) -> { name, effects:[{ matchName, displayName, anchor, intrinsic, seconds, params:[
 *   { index, id, name, timeVarying, value, keys:[{ seconds, value, interp }] } ] }] }
 *
 * - seconds das chaves: a partir do começo do efeito (AnchorInPoint); com anchor "out", a partir
 *   do fim (AnchorOutPoint), negativos.
 * - anchor: "scale" (a animação estica para o clipe), "in" (presa no começo) ou "out" (no fim).
 * - intrinsic: efeito que todo clipe já tem (Opacidade): o host reaproveita em vez de adicionar.
 * - value: número, booleano, ou [x, y] para ponto (posição e âncora vêm normalizadas, 0 a 1).
 * - interp: o código de interpolação do Premiere (0 linear, 4 manter, 5 Bézier...).
 * - seconds do efeito: a duração entre as âncoras (o tamanho do clipe onde o preset foi salvo).
 *
 * Global no painel: AppLegendasCore.parsePrfpset. No Node (testes): module.exports.
 */
(function (root, factory) {
  if (typeof window === "undefined" && typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.AppLegendasCore = root.AppLegendasCore || {};
    root.AppLegendasCore.parsePrfpset = factory().parsePrfpset;
  }
})(typeof self !== "undefined" ? self : this, function () {
  var TICKS = 254016000000;
  // <Type> do FilterPreset: como o Premiere encaixa as chaves no clipe. "scale" estica a animação
  // para a duração do clipe; "in" ancora no começo; "out" no fim (o host conta do fim do clipe).
  var ANCHORS = { 0: "scale", 1: "in", 2: "out" };

  function unescape(text) {
    return String(text).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  }

  function tag(body, name) {
    var m = new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + name + ">").exec(body);
    return m ? unescape(m[1].trim()) : "";
  }

  function refs(body, name) {
    var out = [], re = new RegExp("<" + name + " Index=\"(\\d+)\" ObjectRef=\"(\\d+)\"", "g"), m;
    while ((m = re.exec(body))) out.push({ index: Number(m[1]), ref: m[2] });
    return out;
  }

  function value(text) {
    if (text === undefined) return undefined; // chave sem valor (arquivo estragado)
    if (text === "true" || text === "false") return text === "true";
    if (text.indexOf(":") > 0) return text.split(":").map(Number);
    var n = Number(text);
    return isFinite(n) ? n : text;
  }

  // "ticks,valor,interp,…;" -> [{ seconds, value, interp }]
  function keyframes(text, anchor) {
    return String(text || "").split(";").filter(Boolean).map(function (k) {
      var f = k.split(",");
      return { seconds: Math.round((Number(f[0]) - anchor) / TICKS * 1000) / 1000, value: value(f[1]), interp: Number(f[2]) || 0 };
    }).filter(function (k) { return isFinite(k.seconds) && k.value !== undefined; });
  }

  function parsePrfpset(xml) {
    xml = String(xml || "");
    var objects = {};
    var re = /<(\w+) ObjectID="(\d+)"[^>]*>([\s\S]*?)<\/\1>/g, m;
    while ((m = re.exec(xml))) objects[m[2]] = { kind: m[1], body: m[3] };
    var item = null;
    for (var id in objects) if (objects[id].kind === "FilterPresetItem") { item = objects[id]; break; }
    if (!item) throw new Error("Este arquivo não é uma predefinição de efeitos do Premiere (.prfpset).");
    var named = null;
    for (id in objects) if (objects[id].kind === "TreeItem") named = objects[id];
    // arquivo estragado: referência a objeto que não existe fica de fora, em vez de quebrar
    var effects = refs(item.body, "FilterPreset").filter(function (r) { return objects[r.ref]; }).map(function (r) {
        var preset = objects[r.ref].body;
        var placement = ANCHORS[tag(preset, "Type")] || "scale";
        var inPoint = Number(tag(preset, "AnchorInPoint")) || 0;
        var outPoint = Number(tag(preset, "AnchorOutPoint")) || 0;
        var anchor = placement === "out" ? outPoint : inPoint; // "out": chaves negativas, contadas do fim
        var component = objects[(/<Component ObjectRef="(\d+)"/.exec(preset) || [])[1]];
        var compBody = component ? component.body : "";
        return {
          matchName: tag(preset, "FilterMatchName"),
          displayName: tag(compBody, "DisplayName"),
          anchor: placement,
          intrinsic: tag(compBody, "Intrinsic") === "true", // Opacidade e Movimento já existem no clipe
          seconds: Math.round((outPoint - inPoint) / TICKS * 1000) / 1000,
          params: refs(compBody, "Param").map(function (p) {
            var body = (objects[p.ref] || {}).body || "";
            var start = tag(body, "StartKeyframe").split(",");
            return {
              index: p.index,
              id: Number(tag(body, "ParameterID")),
              name: tag(body, "Name"),
              timeVarying: tag(body, "IsTimeVarying") === "true",
              value: start.length > 1 ? value(start[1]) : null,
              keys: keyframes(tag(body, "Keyframes"), anchor),
            };
          }),
        };
      }).filter(function (e) { return e.matchName; });
    if (!effects.length) throw new Error("Esta predefinição de efeitos não tem nenhum efeito que o app consiga ler.");
    return { name: named ? tag(named.body, "Name") : "", effects: effects };
  }

  return { parsePrfpset: parsePrfpset };
});
