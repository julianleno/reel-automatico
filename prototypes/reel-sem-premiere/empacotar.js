/**
 * Empacota o protótipo num programa que abre sozinho no Windows (fase 4 do estudo, rascunho):
 * o Electron já baixado + uma pasta do app com a mesma estrutura relativa do repositório (o
 * protótipo usa ../../src), o ffmpeg, o whisper, os sons e as fontes do painel. Os modelos do
 * whisper continuam em %APPDATA%/AppLegendas/models (o painel baixa). Sem instalador e sem
 * assinatura: é para testar em outro PC copiando a pasta.
 *
 *   node prototypes/reel-sem-premiere/empacotar.js  ->  prototypes/reel-sem-premiere/out/Reel automatico/
 */
"use strict";
const fs = require("fs");
const path = require("path");

const HERE = __dirname;
const ROOT = path.resolve(HERE, "../..");
const OUT = path.join(HERE, "out", "Reel automatico");
const ELECTRON = path.join(HERE, "node_modules", "electron", "dist");
const APP = path.join(OUT, "resources", "app");

if (!fs.existsSync(path.join(ELECTRON, "electron.exe"))) {
  console.error("Electron não encontrado. Rode: npm install --prefix prototypes/reel-sem-premiere");
  process.exit(1);
}
fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(ELECTRON, OUT, { recursive: true });
fs.renameSync(path.join(OUT, "electron.exe"), path.join(OUT, "Reel automatico.exe"));
fs.rmSync(path.join(OUT, "resources", "default_app.asar"), { force: true });

// o app, com os mesmos caminhos relativos do repositório
// todos os .js e .html do app (uma lista fixa esquecia o arquivo novo), menos as ferramentas
const PROTO = fs.readdirSync(HERE).filter((f) => /\.(js|html)$/.test(f) && !/^(empacotar|teste-tela)\.js$/.test(f));
PROTO.forEach((f) => fs.cpSync(path.join(HERE, f), path.join(APP, "prototypes", "reel-sem-premiere", f)));
// a malha do rosto (olhar.js): o modelo e, do MediaPipe, só o pacote cjs e o wasm com SIMD (11 MB dos 42)
const MP = path.join("node_modules", "@mediapipe", "tasks-vision");
["modelos", path.join(MP, "package.json"), path.join(MP, "vision_bundle.cjs"), path.join(MP, "wasm", "vision_wasm_internal.js"), path.join(MP, "wasm", "vision_wasm_internal.wasm")]
  .forEach((f) => fs.cpSync(path.join(HERE, f), path.join(APP, "prototypes", "reel-sem-premiere", f), { recursive: true }));
const SRC = ["src/core", "src/motion-jota", "src/adobe/cep/js", "src/adobe/cep/fonts", "src/adobe/cep/bin", "src/adobe/cep/sfx", "installer/realfx.ico"];
// dereference: num worktree o src/adobe/cep/bin é uma junção para o de outra pasta; sem isso a junção ia
// para o pacote (e para o instalador) apontando para este PC
SRC.forEach((d) => fs.cpSync(path.join(ROOT, d), path.join(APP, d), { recursive: true, dereference: true }));
fs.writeFileSync(path.join(APP, "package.json"), JSON.stringify({
  name: "reel-automatico",
  productName: "Reel automático",
  version: require(path.join(ROOT, "package.json")).version,
  main: "prototypes/reel-sem-premiere/main.js",
}, null, 2));

const size = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => {
  const p = path.join(dir, e.name);
  return n + (e.isDirectory() ? size(p) : fs.statSync(p).size);
}, 0);
console.log("Pronto: " + OUT + " (" + Math.round(size(OUT) / 1048576) + " MB). Abra \"Reel automatico.exe\".");
