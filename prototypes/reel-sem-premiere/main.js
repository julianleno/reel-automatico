// Fase 0 do app independente: abre uma janela escondida com o motor do painel (o mesmo Chromium +
// Node do CEP) e roda o pipeline. Uso:
//   npx electron . --input "D:/brutos/video.mov" [--out pasta] [--style diagonal] [--model small-q8] [--seconds 60]
//   npx electron . --input a.mov --input b.mov --juntar   (as tomadas num Reel só; --seconds vale para cada uma)
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");

function arg(name, fallback) {
  const i = process.argv.indexOf("--" + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// FaceDetector do Chromium (recorte em pé que segue o rosto em vídeo deitado)
app.commandLine.appendSwitch("enable-experimental-web-platform-features");

// --input pode vir mais de uma vez: com --juntar vira um Reel só, na ordem
const inputs = process.argv.map((a, i) => (a === "--input" ? process.argv[i + 1] : "")).filter(Boolean);
const options = {
  input: inputs[0] || "",
  inputs: process.argv.includes("--juntar") ? inputs : [],
  out: arg("out", path.join(__dirname, "saida")),
  style: arg("style", "professor"), // o do Jota: Poppins branca parada a 66% da altura (docs/padrao-reel.md)
  noHalo: process.argv.includes("--sem-halo"), // sem o contorno curto que segura a letra em fundo claro (comparar)
  model: arg("model", "small-q8"),
  seconds: Number(arg("seconds", "0")) || 0,
  show: process.argv.includes("--show"),
  cpuCanvas: process.argv.includes("--cpu-canvas"),
  noZoom: process.argv.includes("--sem-zoom"),
  noSfx: process.argv.includes("--sem-sons"),
  noPunch: process.argv.includes("--sem-reenquadre"), // sem o punch-in alternado nos cortes (comparar)
  retakes: process.argv.includes("--repeticoes"),
  target: Number(arg("duracao", "0")) || 0, // --duracao 60: o melhor Reel de 60 s do bruto (0 = tudo o que é bom)
  noGaze: process.argv.includes("--sem-olhar"), // na duração, não olha para onde a pessoa olha (comparar)
  aiCode: process.env.REEL_AI_CODE || "", // código de acesso da IA (o mesmo do painel); sem ele, escolha sem IA
  planFile: arg("plano", ""), // --plano arquivo.json: um plano da IA já feito (planReel), sem pedir de novo
  music: arg("musica", ""),
  noDrop: process.argv.includes("--sem-batida"), // a música do começo, em loop (sem pôr o drop no gancho)
  onePass: !process.argv.includes("--duas-passadas"),
  format: arg("formato", "reels"), // reels (9:16), feed (4:5) ou quadrado (1:1)
  layout: process.argv.includes("--duas") ? "duas" : "", // duas pessoas empilhadas (podcast)
  noSpeaker: process.argv.includes("--sem-quem-fala"),
  speed: Number(arg("velocidade", "1")) || 1, // 1.25, 1.5...: acelera a fala no fim, mesmo tom
  brandTop: arg("topo", ""), // moldura: nome do negócio no topo
  brandBottom: arg("rodape", ""), // moldura: @perfil embaixo
  fullFrame: process.argv.includes("--tela-inteira"),
  shortStyle: arg("curta", ""), // --curta impact: legenda de até 2 palavras nesse estilo
  behind: process.argv.includes("--atras"), // legenda atrás da pessoa (mais lento: recorta a pessoa)
  preview: process.argv.includes("--previa"), // prévia rápida: 540x960, sem capa
  brandColor: arg("cor", ""), // --cor "#e63946": a cor da marca na palavra em destaque
  everyFrame: process.argv.includes("--quadro-a-quadro"), // desliga o reaproveitar da legenda parada (comparar)
};

app.whenReady().then(() => {
  if (!options.input) {
    // sem --input: a tela única (soltar o vídeo, escolher, fazer o Reel)
    const ui = new BrowserWindow({
      width: 1100,
      height: 760,
      minWidth: 900, // abaixo disso a coluna das opções aperta o vídeo
      minHeight: 620,
      backgroundColor: "#232323", // o --bg da tela: sem piscar outra cor ao abrir
      icon: path.join(__dirname, "../../installer/realfx.ico"), // o mesmo do instalador do painel
      title: "Reel automático",
      webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
    });
    ui.setMenuBarVisibility(false);
    ui.loadFile(path.join(__dirname, "ui.html"));
    app.on("window-all-closed", () => app.quit());
    return;
  }
  const win = new BrowserWindow({
    show: options.show,
    width: 540,
    height: 960,
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
  });
  ipcMain.on("log", (_e, text) => console.log(text));
  ipcMain.on("done", (_e, code) => app.exit(code));
  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2) console.log("[página] " + message);
  });
  win.loadFile(path.join(__dirname, "index.html"), { query: { options: JSON.stringify(options) } });
});
