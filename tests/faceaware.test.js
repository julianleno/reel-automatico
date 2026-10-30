const test = require("node:test");
const assert = require("node:assert/strict");
const F = require("../src/core/captions/faceaware.js");
const { SAFE_ZONES } = require("../src/core/captions/safezone.js");

test("legenda e rosto: a faixa da legenda tem a conta do desenho", () => {
  // 100 px em 1080x1920, 2 linhas: 2 x 100 x 1,23 = 246 px de altura, centro em 64%
  const b = F.captionBand({ fontSize: 100, positionY: 64, maxLines: 2 }, { width: 1080, height: 1920 });
  assert.equal(b.center, 0.64);
  assert.ok(Math.abs(b.half - 123 / 1920) < 1e-9);
  // sem linhas no estilo: 2; uma linha pedida: metade; entrelinha +20% aumenta
  assert.ok(Math.abs(F.captionBand({ fontSize: 100, positionY: 64 }, { lines: 1 }).half - 61.5 / 1920) < 1e-9);
  assert.ok(F.captionBand({ fontSize: 100, positionY: 64, leading: 20 }, {}).half > b.half);
});

test("legenda e rosto: o espaço livre é o das plataformas mais apertadas", () => {
  const all = F.safeLimits(SAFE_ZONES);
  assert.equal(all.top, 0.11); // Reels em cima
  assert.equal(all.bottom, 0.75); // TikTok embaixo
  assert.deepEqual(F.safeLimits(SAFE_ZONES, ["shorts"]), { top: 0.06, bottom: 0.79 });
});

test("legenda e rosto: em cima do rosto, vai para o lado mais perto que cabe", () => {
  const safe = F.safeLimits(SAFE_ZONES);
  const band = { center: 0.5, half: 0.06 };
  // rosto de 40% a 55%: acima seria 0,32 (longe 0,18); abaixo 0,63 (perto 0,13) -> desce
  assert.equal(F.dodgeFace({ top: 0.4, bottom: 0.55 }, band, safe), 63);
  // rosto de 45% a 62%: abaixo seria 0,70 e passa do fim da área (0,76 > 0,75) -> sobe para 0,37
  assert.equal(F.dodgeFace({ top: 0.45, bottom: 0.62 }, band, safe), 37);
});

test("legenda e rosto: longe do rosto fica onde está; sem lugar nos dois lados, também", () => {
  const safe = F.safeLimits(SAFE_ZONES);
  assert.equal(F.dodgeFace({ top: 0.2, bottom: 0.35 }, { center: 0.64, half: 0.06 }, safe), null, "não encosta");
  assert.equal(F.dodgeFace({ top: 0.2, bottom: 0.7 }, { center: 0.5, half: 0.06 }, safe), null, "rosto enorme: não cabe em cima nem embaixo");
  assert.equal(F.dodgeFace(null, { center: 0.5, half: 0.06 }, safe), null);
  // a folga conta: encostar a menos de 2% do rosto já é encostar
  assert.equal(F.dodgeFace({ top: 0.57, bottom: 0.7 }, { center: 0.5, half: 0.06 }, { top: 0, bottom: 1 }), 49);
});

test("legenda e rosto: o arredondamento nunca devolve a legenda para cima do rosto", () => {
  const safe = { top: 0, bottom: 1 };
  // meia altura de 2 linhas de 100 px em 1920 (0,0640625): o centro exato abaixo seria 0,6440625
  const band = F.captionBand({ fontSize: 100, positionY: 50 }, { width: 1080, height: 1920 });
  const down = F.dodgeFace({ top: 0.4, bottom: 0.56 }, band, safe);
  assert.equal(down, 64.5);
  assert.ok(down / 100 - band.half >= 0.58, "a faixa começa depois do rosto + folga");
  const up = F.dodgeFace({ top: 0.45, bottom: 0.7 }, band, safe);
  assert.ok(up / 100 + band.half <= 0.43, "a faixa acaba antes do rosto - folga: " + up);
});
