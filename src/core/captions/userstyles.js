/**
 * Estilos salvos pelo usuário ("Meus estilos"): um nome e os campos do estilo da galeria.
 * Lista = [{ name, style }]. Arquivos importados vêm de outras pessoas: só entram campos
 * conhecidos, com valores simples, e estilos cuja base existe nesta versão.
 */
(function (root, factory) {
  if (typeof window === "undefined" && typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.AppLegendasCore = root.AppLegendasCore || {};
    var api = factory();
    root.AppLegendasCore.cleanUserStyles = api.cleanUserStyles;
    root.AppLegendasCore.upsertUserStyles = api.upsertUserStyles;
  }
})(typeof self !== "undefined" ? self : this, function () {
  var MAX_NAME = 40;
  var MAX_STYLES = 100;

  function cleanName(name) {
    // só texto: um objeto { toString: 1 } vindo de arquivo quebrava o String() e a importação
    return (typeof name === "string" ? name : "").replace(/\s+/g, " ").replace(/^ | $/g, "").slice(0, MAX_NAME);
  }

  // fields: nomes aceitos; presets: { id: ... } das bases que existem nesta versão.
  function cleanUserStyles(list, fields, presets) {
    var out = [];
    if (Object.prototype.toString.call(list) !== "[object Array]") return out;
    for (var i = 0; i < list.length && out.length < MAX_STYLES; i += 1) {
      var item = list[i] || {};
      var name = cleanName(item.name);
      var src = item.style || {};
      // própria do objeto: "constructor" ou "toString" vindos de um arquivo não são uma base
      if (!name || typeof src.preset !== "string" || !Object.prototype.hasOwnProperty.call(presets, src.preset)) continue;
      var style = {};
      for (var f = 0; f < fields.length; f += 1) {
        var v = src[fields[f]];
        var t = typeof v;
        if (t === "boolean" || (t === "number" && isFinite(v)) || (t === "string" && v.length <= 200)) style[fields[f]] = v;
      }
      out.push({ name: name, style: style });
    }
    return out;
  }

  // Junta `incoming` em `list`; o mesmo nome (sem diferenciar maiúsculas) é substituído.
  function upsertUserStyles(list, incoming) {
    var out = list.slice();
    incoming.forEach(function (item) {
      var key = item.name.toLowerCase();
      var at = -1;
      for (var i = 0; i < out.length; i += 1) if (out[i].name.toLowerCase() === key) at = i;
      if (at >= 0) out[at] = item;
      else out.push(item);
    });
    return out.slice(0, MAX_STYLES);
  }

  return { cleanUserStyles: cleanUserStyles, upsertUserStyles: upsertUserStyles };
});
