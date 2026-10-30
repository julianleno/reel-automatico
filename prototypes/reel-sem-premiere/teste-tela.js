/**
 * Teste de tela do app sem Premiere: abre a janela de verdade pelo DevTools e clica.
 *
 *   node prototypes/reel-sem-premiere/teste-tela.js [--fotos pasta]
 *     Sem GPU (não ouve nada): os estados da tela com o motor trocado por um falso (vazio, arquivo
 *     que não é vídeo, fila, cada etapa, erro, sem internet, cancelar, pronto com capas, mudar uma
 *     chave refaz a prévia, pergunta ao fechar, janela pequena); depois um Reel de verdade com as
 *     palavras já guardadas (o whisper fica bloqueado) e fechar no meio dele: o app sai sem deixar
 *     ffmpeg rodando nem o MP4 pela metade. --fotos salva um PNG de cada estado.
 *
 *   node prototypes/reel-sem-premiere/teste-tela.js "D:/bruto.mov"
 *     Com fala de verdade (usa o whisper, na vez dele): 1º Reel ouve; mudar uma chave refaz a
 *     prévia sem ouvir; "Fazer de novo" sai o final sem ouvir; "Os três formatos" faz 3 Reels;
 *     dois vídeos com "Juntar num Reel só" fazem um Reel.
 *
 *   REEL_EXE="prototypes/reel-sem-premiere/out/Reel automatico/Reel automatico.exe" node ... (o app empacotado)
 *
 * Tudo sai numa pasta temporária (perfil do app, vídeos de teste e Reels) e é apagado no fim. A
 * porta do DevTools é a que o Electron escolher (0): dois testes ao mesmo tempo não se cruzam.
 */
"use strict";
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HERE = __dirname;
const FFMPEG = path.join(HERE, "../../src/adobe/cep/bin/ffmpeg.exe");
const args = process.argv.slice(2);
const fotos = args.includes("--fotos") ? path.resolve(args[args.indexOf("--fotos") + 1]) : "";
const video = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--fotos") || "";
if (fotos) fs.mkdirSync(fotos, { recursive: true });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "teste-tela-"));
const OUT = path.join(tmp, "reels");
process.on("exit", () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* preso */ } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, label, detail) => {
  console.log((ok ? "PASSOU " : "FALHOU ") + label + (detail ? " (" + detail + ")" : ""));
  if (!ok) failed += 1;
};

// abre o app com um perfil novo; a porta vem do DevToolsActivePort que o Chromium grava no perfil
async function open(name) {
  const profile = path.join(tmp, "perfil-" + name);
  const flags = ["--remote-debugging-port=0", "--user-data-dir=" + profile];
  const env = Object.assign({}, process.env, { REEL_OUT: OUT });
  const app = process.env.REEL_EXE
    ? spawn(process.env.REEL_EXE, flags, { stdio: "ignore", env })
    : spawn(path.join(HERE, "node_modules/electron/dist/electron.exe"), [HERE].concat(flags), { stdio: "ignore", env });
  app.exited = new Promise((r) => app.on("exit", r));
  let ws;
  for (let i = 0; i < 240 && !ws; i += 1) {
    try {
      const port = fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0].trim();
      const list = await (await fetch("http://127.0.0.1:" + port + "/json")).json();
      const page = list.find((t) => t.type === "page" && /ui\.html/.test(t.url));
      if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
    } catch (e) { /* a janela ainda está abrindo */ }
    if (!ws) await sleep(250);
  }
  if (!ws) throw new Error("a janela não abriu");
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") check(false, "erro na página", m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description);
    if (m.method === "Runtime.consoleAPICalled") logs.push(m.params.args.map((a) => a.value).join(" "));
  });
  ws.addEventListener("close", () => pending.forEach((r) => r({ result: {} })));
  const send = (method, params = {}) => new Promise((r) => {
    if (ws.readyState !== 1) return r({ result: {} });
    id += 1;
    pending.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const js = async (e) => {
    const r = await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) throw new Error("na página: " + (r.result.exceptionDetails.exception || {}).description);
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  await send("Runtime.enable");
  for (let w = 0; w < 60; w += 1) { if ((await js("typeof window.chooseVideo")) === "function") break; await sleep(250); }
  const until = async (expr, ms) => {
    for (let t = Date.now(); Date.now() - t < ms;) {
      if (await js(expr)) return true;
      await sleep(200);
    }
    return false;
  };
  const shot = async (file, w, h) => {
    if (w) await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(350);
    if (fotos && file) {
      const r = await send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(fotos, file + ".png"), Buffer.from(r.result.data, "base64"));
    }
  };
  const size = (w, h) => (w ? send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false }) : send("Emulation.clearDeviceMetricsOverride"));
  return { app, ws, js, until, shot, size, logs, close: () => ws.close() };
}

function clip(file, secs, w, h) {
  execFileSync(FFMPEG, ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=" + w + "x" + h + ":d=" + secs + ":r=30",
    "-f", "lavfi", "-i", "sine=f=330:d=" + secs, "-c:v", "libopenh264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file]);
}
// palavras guardadas para o vídeo (o mesmo arquivo que o pipeline lê): o Reel sai sem ouvir
function seedWords(file, secs) {
  const P = require(path.join(HERE, "plan.js"));
  const text = "Oi gente, hoje eu vou mostrar como eu faço a unha em gel em casa. Primeiro a lixa, depois a base e o gel por cima. Fica lindo!".split(" ");
  const words = [];
  for (let i = 0, t = 300; t + 400 < secs * 1000; i += 1, t += 520) words.push({ text: text[i % text.length], startMs: t, endMs: t + 400 });
  P.saveWords(P.wordsFile(path.join(os.tmpdir(), "reel-palavras"), file, fs.statSync(file), "small-q8", 0), words);
}
// ffmpeg ainda rodando com algum arquivo deste teste na linha de comando
function strayFfmpeg() {
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-Command",
      "Get-CimInstance Win32_Process -Filter \"name='ffmpeg.exe'\" | ForEach-Object { $_.CommandLine }"], { encoding: "utf8" });
    return out.split(/\r?\n/).filter((l) => l.includes(path.basename(tmp)));
  } catch (e) {
    return [];
  }
}

// o motor falso: a tela chama window.runReel; o teste manda as etapas pelos hooks e termina quando quer
const FAKE = (dir) => `(() => {
  const D = ${JSON.stringify(dir.replace(/\\/g, "/") + "/")};
  window.__calls = [];
  window.runReel = (opts, hooks) => new Promise((resolve, reject) => {
    window.__calls.push(opts);
    window.__hooks = hooks;
    window.__finish = (extra) => resolve(Object.assign({
      out: D + "falso reel.mp4", cover: D + "falso capa.jpg", covers: [1, 2, 3].map((n) => D + "falso capa " + n + ".jpg"),
      words: [{ text: "oi", startMs: 0, endMs: 300 }], lines: ["Oi, gente! Hoje eu vou", "mostrar como faço a unha", "em gel em casa."],
      landscape: false, faceX: 0.5,
    }, extra || {}));
    window.__fail = (msg) => reject(new Error(msg));
  });
  window.cancelReel = () => window.__fail && window.__fail("Cancelado.");
  return "ok";
})()`;

async function semGpu() {
  const media = path.join(tmp, "midia");
  fs.mkdirSync(media);
  const short = path.join(media, "bruto curto #1.mp4"); // "#" no nome: o file:/// precisa escapar
  clip(short, 3, 1080, 1920);
  clip(path.join(media, "falso reel.mp4"), 2, 1080, 1920);
  for (const n of [1, 2, 3]) {
    execFileSync(FFMPEG, ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=1080x1920:d=1", "-vf", "hue=h=" + n * 90, "-frames:v", "1", path.join(media, "falso capa " + n + ".jpg")]);
  }
  fs.copyFileSync(path.join(media, "falso capa 1.jpg"), path.join(media, "falso capa.jpg"));

  // ---- 1. estados com o motor falso
  let s = await open("estados");
  const { js, until, shot } = s;
  check(await js("typeof AppLegendasReelPlan === 'object' && typeof AppLegendasAI === 'object'"), "a tela carrega o plano do Reel e a IA (duração com e sem código)");
  await js(FAKE(media));
  const view = () => js("document.getElementById('side').dataset.view");
  const text = (id) => js("document.getElementById(" + JSON.stringify(id) + ").textContent");
  const visible = (id) => js("(() => { const e = document.getElementById(" + JSON.stringify(id) + "); return !!(e && e.getClientRects().length); })()");

  await shot("01 vazio");
  check(await js("document.getElementById('go').disabled") && /Escolha um vídeo/.test(await text("status")), "vazio: botão desligado diz o motivo");

  await js("document.getElementById('look-btn').click(); 'ok'");
  await sleep(800);
  await shot("01b galeria de estilos");
  const tiles = await js("[document.querySelectorAll('#gal-top .tile').length, document.querySelectorAll('.tile').length, document.activeElement.dataset.id]");
  check(await visible("gallery") && tiles[0] >= 5 && tiles[1] === (await js("document.getElementById('style').options.length")) && tiles[2] === (await js("document.getElementById('style').value")),
    "galeria: todos os estilos em miniatura, os Destaques primeiro, o escolhido em foco", tiles.join(", "));
  await js("document.querySelectorAll('#gal-top .tile')[1].click(); 'ok'");
  check(!(await visible("gallery")) && (await js("document.getElementById('style').value === document.querySelectorAll('#gal-top .tile')[1].dataset.id && JSON.parse(localStorage.getItem('reel-sem-premiere.opcoes')).style === document.getElementById('style').value")),
    "clicar num estilo escolhe, fecha e lembra");
  await js("document.getElementById('look-btn').click(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); 'ok'");
  check(!(await visible("gallery")), "Esc fecha a galeria");

  await js("window.chooseVideos(['C:/x/foto.jpg']); 'ok'");
  await shot("02 nao e video");
  check(/não é um vídeo/.test(await text("stagenote-text")) && await visible("stagenote") && await js("document.getElementById('go').disabled"), "foto solta: aviso e nada começa");

  await js("window.chooseVideos([" + JSON.stringify(short) + ", 'C:/x/b.mov', 'C:/x/nota.txt', 'C:/x/c.MP4']); 'ok'");
  await until("document.getElementById('filelen').textContent", 8000);
  await shot("03 fila");
  check(/\+2 na fila/.test(await text("queue")) && /ficou de fora/.test(await text("stagenote-text")), "vários: 2 na fila e o .txt fica de fora", await text("queue"));
  check((await text("filename")) === path.basename(short) && /0:03/.test(await text("filelen")), "o nome e a duração do vídeo aparecem", await text("filename") + " " + await text("filelen"));
  check(await js("!document.getElementById('player').error"), "nome com # abre no player");
  check(await visible("joinbox"), "vários: aparece a chave Juntar num Reel só");
  await js("document.getElementById('o-join').checked = true; document.getElementById('go').click(); 'ok'");
  await sleep(200);
  check((await js("__calls[__calls.length - 1].inputs.length")) === 3 && /3 vídeos num Reel só/.test(await text("queue")) &&
    (await js("document.querySelector('#steps li').textContent")) === "Juntando os vídeos", "Juntar: os 3 vão juntos e a 1ª etapa é juntar", await text("queue"));
  await js("document.getElementById('stop').click(); document.getElementById('o-join').checked = false; 'ok'");
  await js("window.chooseVideos([" + JSON.stringify(short) + "]); 'ok'"); // um só: a fila de antes sai
  check(!(await visible("queue")) && !(await visible("joinbox")), "escolher de novo troca a fila (e a junção sai)");
  check(await js("getComputedStyle(document.getElementById('go')).backgroundColor") === "rgb(153, 153, 255)", "o botão principal é lavanda (dourado é só da IA)");

  await js("document.getElementById('target').value = '60'; document.getElementById('go').click(); 'ok'");
  await sleep(200);
  check((await view()) === "run" && (await js("document.querySelectorAll('#steps li').length")) === 8, "fazendo: 8 etapas (com 'melhores momentos' na duração de 1 minuto)");
  check(!(await visible("go")), "fazendo: o botão de fazer sai da frente");
  await js("__hooks.step('leitura'); __hooks.step('áudio'); __hooks.downloading(0.42); 'ok'");
  await shot("04 baixando o modelo");
  check(/baixando o reconhecimento de voz.*42%/.test(await text("msg")), "1ª vez: progresso do download na tela", await text("msg"));
  await js("__hooks.waiting(); 'ok'");
  check(/Esperando o computador/.test(await text("msg")), "outra transcrição no PC: a tela explica a espera");
  await js("__hooks.listening(0.5); 'ok'");
  await shot("05 ouvindo");
  const pctListen = parseInt(await text("pct"), 10);
  check((await text("now")) === "Ouvindo a fala" && pctListen > 10, "ouvindo: a barra anda junto com a escuta", pctListen + "%");
  await js("['transcrição', 'melhores momentos', 'silêncios', 'corte', 'legendas'].forEach((k) => __hooks.step(k)); __hooks.progress(0.1); 'ok'");
  await sleep(2600);
  await js("__hooks.progress(0.5); 'ok'");
  await shot("06 gerando");
  check((await text("now")) === "Gerando o vídeo" && (await js("document.querySelectorAll('#steps li.ok').length")) === 7, "gerando: 7 etapas feitas e a da vez acesa");
  check(/falta|quase/.test(await text("eta")), "gerando: mostra quanto falta", await text("eta"));
  const pctRender = parseInt(await text("pct"), 10);
  check(pctRender > pctListen && pctRender < 100, "a barra só anda para a frente", pctListen + "% -> " + pctRender + "%");

  await js("__fail('ffmpeg 4294967274: Error opening input file C:/x.mov.'); 'ok'");
  await sleep(200);
  await shot("07 erro");
  check((await view()) === "error" && /Não consegui ler esse vídeo/.test(await text("err-title")) && (await js("document.querySelectorAll('#steps li.fail').length")) === 1,
    "erro: título humano e a etapa marcada", await text("err-title"));
  check((await js("document.activeElement.id")) === "retry", "erro: o foco do teclado vai para Tentar de novo");
  check(/ffmpeg 4294967274/.test(await text("err-tech")) && !(await js("document.getElementById('err-tech').closest('details').open")), "erro: o texto técnico fica escondido nos detalhes");
  await js("document.getElementById('retry').click(); __hooks.step('leitura'); __hooks.step('áudio'); __fail('Não foi possível baixar o modelo: getaddrinfo ENOTFOUND huggingface.co'); 'ok'");
  await sleep(200);
  await shot("08 sem internet");
  check(/Sem internet/.test(await text("err-title")) && /Conecte a internet/.test(await text("err-what")), "sem internet: diz para conectar e tentar de novo");

  await js("document.getElementById('retry').click(); __hooks.step('leitura'); 'ok'");
  await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); 'ok'");
  await sleep(200);
  check((await view()) === "opts" && /Cancelado/.test(await text("status")), "Esc cancela e volta para as opções", await text("status"));

  const post = path.join(media, "falso post.txt");
  fs.writeFileSync(post, "Unha em gel em casa\n\nPasso a passo sem segredo.\n\n#unhas #gel");
  await js("document.getElementById('go').click(); ['leitura', 'áudio', 'transcrição', 'melhores momentos', 'silêncios', 'corte', 'legendas', 'legenda + vídeo final'].forEach((k) => __hooks.step(k)); __hooks.warn('IA indisponível (sem internet): o Reel sai pelas regras do app, sem o texto do post.'); __finish({ post: " + JSON.stringify(post) + " }); 'ok'");
  await until("document.getElementById('side').dataset.view === 'done'", 3000);
  await js("document.getElementById('player').pause(); 'ok'");
  await shot("09 pronto");
  check(/Seu Reel está pronto/.test(await text("done-title")) && /Reel automático|reels/.test(await text("where")) && await visible("show"), "pronto: título, onde salvou e Abrir a pasta", await text("where"));
  check((await js("document.activeElement.id")) === "show", "pronto: o foco do teclado vai para Abrir a pasta");
  await until("/Reel de 0:02/.test(document.getElementById('reel-len').textContent)", 8000);
  check(/^Reel de 0:02\. Salvo na pasta “reels”\.$/.test(await text("where")), "pronto: diz quanto ficou o Reel e onde salvou", await text("where"));
  check((await js("document.querySelectorAll('#covers button').length")) === 3 && (await js("document.querySelector('#covers button').getAttribute('aria-pressed')")) === "true", "pronto: 3 capas em botões, a 1ª escolhida");
  await js("document.querySelectorAll('#covers button')[1].click(); 'ok'");
  check(fs.readFileSync(path.join(media, "falso capa.jpg")).equals(fs.readFileSync(path.join(media, "falso capa 2.jpg"))) &&
    (await js("document.querySelectorAll('#covers button')[1].getAttribute('aria-pressed')")) === "true", "clicar na 2ª capa troca a capa.jpg");
  check((await js("document.querySelectorAll('#lines li').length")) === 3 && /Refazer com as correções$/.test(await text("redo")), "pronto: legendas e Refazer (sem 'enquadramento' em vídeo em pé)");
  check(/IA indisponível/.test(await text("donemsg")), "pronto: o aviso da IA aparece", await text("donemsg"));
  const clip0 = await js("require('electron').clipboard.readText()");
  await js("document.getElementById('post-copy').click(); 'ok'");
  check(await visible("postbox") && (await js("require('electron').clipboard.readText()")) === fs.readFileSync(post, "utf8") && /Copiado/.test(await text("post-copy-text")),
    "texto do post da IA: à vista e Copiar põe na área de transferência");
  await js("require('electron').clipboard.writeText(" + JSON.stringify(clip0 || "") + "); 'ok'"); // devolve o que estava lá
  await s.size(900, 620);
  await sleep(300);
  check(await js("(() => { const b = document.getElementById('show').getBoundingClientRect(); return b.bottom <= innerHeight && document.documentElement.scrollWidth <= innerWidth; })()"), "janela mínima (900x620): Abrir a pasta à vista, sem rolar de lado");
  await shot("10 pronto 900x620");
  await s.size();

  await js("document.getElementById('back').click(); 'ok'");
  check((await view()) === "opts" && /a prévia se refaz sozinha/.test(await text("status")), "Mudar opções: as opções voltam e dizem que a prévia se refaz");
  const before = await js("__calls.length");
  await js("(() => { const c = document.getElementById('o-sfx'); c.checked = !c.checked; c.dispatchEvent(new Event('change')); return 'ok'; })()");
  await until("__calls.length > " + before, 4000);
  check(await js("__calls.length > " + before + " && __calls[__calls.length - 1].preview === true && !!__calls[__calls.length - 1].words"), "mudar uma chave refaz a prévia sozinha, sem ouvir de novo");
  await shot("11 previa refazendo");
  check(/Refazendo a prévia/.test(await text("status")) && (await view()) === "opts", "a prévia se refaz com as opções à vista");
  await js("__finish(); 'ok'");
  await until("/Prévia pronta/.test(document.getElementById('status').textContent)", 3000);
  check(/Prévia pronta/.test(await text("status")), "prévia pronta avisa embaixo do botão", await text("status"));

  await js("document.getElementById('go').click(); 'ok'");
  await js("window.close(); 'ok'");
  await sleep(500);
  await shot("12 fechar no meio");
  check(await visible("closeask") && s.app.exitCode === null, "fechar no meio: pergunta e a janela fica");
  await js("document.getElementById('keep').click(); 'ok'");
  check(!(await visible("closeask")) && (await view()) === "run", "Continuar fazendo: segue de onde estava");
  await js("document.getElementById('stop').click(); 'ok'");
  await js("window.chooseVideo(" + JSON.stringify(short) + "); 'ok'");
  check((await view()) === "opts" && (await text("go-text")) === "Fazer de novo", "trocar de vídeo depois de cancelar volta às opções");
  s.close();
  s.app.kill();
  await s.app.exited;

  // ---- 2. um Reel de verdade (palavras guardadas, whisper bloqueado) e fechar no meio de outro
  const long = path.join(media, "bruto longo.mp4");
  clip(long, 40, 1080, 1920);
  seedWords(short, 3);
  seedWords(long, 40);
  s = await open("real");
  const guard = "AppLegendasTranscribe.transcribeWav = AppLegendasTranscribe.downloadModel = () => Promise.reject(new Error('teste sem GPU: não era para ouvir')); 'ok'";
  await s.js(guard);
  await s.js("document.getElementById('target').value = '30'; document.getElementById('o-preview').checked = true; window.chooseVideo(" + JSON.stringify(short) + "); document.getElementById('go').click(); 'ok'");
  await s.until("['done', 'error'].includes(document.getElementById('side').dataset.view)", 120000);
  const real = await s.js("[document.getElementById('side').dataset.view, document.getElementById('err-tech').textContent, document.querySelectorAll('#lines li').length]");
  check(real[0] === "done" && real[2] > 0, "Reel de verdade pela tela (sem ouvir): pronto com legendas", real[0] === "done" ? real[2] + " legendas" : real[1]);
  check(s.logs.some((l) => /transcrição .*guardadas deste vídeo/.test(l)), "usou as palavras guardadas (não ouviu)");
  await s.shot("13 pronto de verdade");

  await s.js("document.getElementById('o-preview').checked = false; window.chooseVideo(" + JSON.stringify(long) + "); document.getElementById('go').click(); 'ok'");
  const rendering = await s.until("document.getElementById('now').textContent === 'Gerando o vídeo' && parseInt(document.getElementById('pct').textContent, 10) > 60", 120000);
  check(rendering, "Reel longo chegou em Gerando o vídeo", await s.js("document.getElementById('now').textContent"));
  await s.js("window.close(); 'ok'");
  await sleep(400);
  check(await s.js("!document.getElementById('closeask').classList.contains('hidden')"), "fechar enquanto gera o vídeo: pergunta");
  const t0 = Date.now();
  let gone = 0;
  s.ws.addEventListener("close", () => (gone = Date.now() - t0));
  await s.js("document.getElementById('quit').click(); 'ok'");
  // a janela some em 2 a 4 s; o processo do Electron às vezes leva mais 10 s para sair (medido também com a tela parada)
  const quit = await Promise.race([s.app.exited.then(() => true), sleep(30000).then(() => false)]);
  check(quit && gone && gone < 8000, "Parar e fechar: a janela fecha e o app sai", "janela em " + (gone / 1000).toFixed(1) + " s, app em " + ((Date.now() - t0) / 1000).toFixed(1) + " s");
  await sleep(1500);
  const stray = strayFfmpeg();
  check(!stray.length, "nenhum ffmpeg ficou rodando", stray.join(" | ").slice(0, 200));
  const half = fs.existsSync(OUT) ? fs.readdirSync(OUT).filter((f) => /bruto longo.*\.mp4$/.test(f)) : [];
  check(!half.length, "o MP4 pela metade não fica na pasta", half.join(", "));
  if (!quit) s.app.kill();
}

async function comGpu() {
  // cópia numa pasta nova: as palavras guardadas (reel-palavras) são por caminho, e o 1º Reel precisa ouvir
  const copy = path.join(tmp, path.basename(video));
  fs.copyFileSync(video, copy);
  const s = await open("gpu");
  const { js, until } = s;
  const heardSince = (n) => s.logs.slice(n).some((l) => /✔ transcrição .*modelo/.test(l));
  // espera o fim de uma rodada; ouviu = o log da transcrição diz o modelo (não "rodada anterior"/"guardadas")
  const waitDone = async (expr) => {
    const t0 = Date.now();
    const n = s.logs.length;
    await until(expr, 600000);
    const file = String(await js("decodeURIComponent(document.getElementById('player').src)")).split("/").pop();
    return { secs: Math.round((Date.now() - t0) / 1000), heard: heardSince(n), file, view: await js("document.getElementById('side').dataset.view"),
      msg: await js("document.getElementById('status').textContent + ' ' + document.getElementById('donemsg').textContent + ' ' + document.getElementById('err-tech').textContent") };
  };
  const ended = "['done', 'error'].includes(document.getElementById('side').dataset.view)";

  await js("window.chooseVideo(" + JSON.stringify(copy) + "); document.getElementById('go').click(); 'ok'");
  const first = await waitDone(ended);
  check(first.view === "done" && first.heard, "1º Reel ouve o vídeo", first.secs + " s, " + first.file + " " + first.msg.trim());

  await js("document.getElementById('back').click(); (() => { const c = document.getElementById('o-sfx'); c.checked = !c.checked; c.dispatchEvent(new Event('change')); })(); 'ok'");
  await sleep(2500);
  const quick = await waitDone("/Prévia pronta|Cancelado/.test(document.getElementById('status').textContent) || document.getElementById('side').dataset.view === 'error'");
  check(/previa/.test(quick.file) && !quick.heard, "mudar uma chave refaz a prévia sozinha, sem ouvir", quick.secs + " s, " + quick.file);

  await js("(() => { const c = document.getElementById('o-sfx'); c.checked = !c.checked; document.getElementById('go').click(); })(); 'ok'");
  await sleep(1000);
  const again = await waitDone(ended);
  check(again.view === "done" && !/previa/.test(again.file) && !again.heard, "Fazer de novo sai o final sem ouvir", again.secs + " s, " + again.file);

  await js("document.getElementById('back').click(); document.getElementById('format').value = 'todos'; document.getElementById('go').click(); 'ok'");
  await sleep(1000);
  const all = await waitDone("/3 Reels prontos/.test(document.getElementById('done-title').textContent) || document.getElementById('side').dataset.view === 'error'");
  check(/3 Reels/.test(await js("document.getElementById('done-title').textContent")) && !all.heard, "Os três formatos: 3 Reels sem ouvir de novo", all.secs + " s");

  // dois vídeos com "Juntar num Reel só": um Reel com o nome dos dois (a 2ª cópia é outro arquivo)
  const second = copy.replace(/(\.\w+)$/, " b$1");
  fs.copyFileSync(copy, second);
  await js("document.getElementById('back').click(); document.getElementById('format').value = 'reels'; window.chooseVideos(" + JSON.stringify([copy, second]) + "); document.getElementById('o-join').checked = true; document.getElementById('go').click(); 'ok'");
  await sleep(1000);
  const joined = await waitDone(ended);
  check(joined.view === "done" && / \+ /.test(joined.file), "Juntar num Reel só: 2 vídeos, 1 Reel", joined.secs + " s, " + joined.file);
  s.close();
  s.app.kill();
}

(video ? comGpu() : semGpu()).then(() => {
  console.log(failed ? failed + " FALHA(S)" : "tudo passou");
  process.exit(failed ? 1 : 0);
}, (e) => {
  console.error("FALHOU " + (e && e.stack ? e.stack : e));
  process.exit(1);
});
