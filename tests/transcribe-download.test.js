// O download do modelo de voz e do recortador (services/transcribe.js downloadFile/downloadModel) com um
// https de mentira: redirecionamento, erro HTTP, redirecionamento demais, cancelar e o .part que não fica.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

// routes: url -> { status, location?, body? } ; hold: url que fica parada (para cancelar)
function load(routes, hold) {
  const https = {
    get(url, cb) {
      const req = new EventEmitter();
      req.destroy = (err) => setImmediate(() => req.emit("error", err || new Error("destruído")));
      setImmediate(() => {
        const r = routes[url];
        if (!r) return req.emit("error", new Error("sem rota: " + url));
        const res = new PassThrough();
        res.statusCode = r.status;
        res.headers = Object.assign({}, r.location ? { location: r.location } : {}, r.body ? { "content-length": String(r.body.length) } : {});
        cb(res);
        if (url === hold) return; // segura: só termina se alguém cancelar
        if (r.body) {
          res.write(r.body.subarray(0, Math.floor(r.body.length / 2)));
          res.end(r.body.subarray(Math.floor(r.body.length / 2)));
        } else {
          res.end();
        }
      });
      return req;
    },
  };
  const fakeRequire = (name) => (name === "https" ? https : require(name));
  const sandbox = { module: { exports: {} }, require: fakeRequire, setImmediate, setTimeout, Buffer };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/adobe/cep/js/services/transcribe.js"), "utf8"), sandbox);
  return sandbox.module.exports;
}

test("download: segue o redirecionamento, grava o arquivo e conta o progresso", async () => {
  const body = Buffer.from("x".repeat(1000));
  const T = load({ "https://a/m.bin": { status: 302, location: "/cdn/m.bin" }, "https://a/cdn/m.bin": { status: 200, body } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baixar-"));
  try {
    const dest = path.join(dir, "m.bin"), seen = [];
    await T.downloadFile("https://a/m.bin", dest, (p) => seen.push(p), 0);
    assert.equal(fs.readFileSync(dest, "utf8"), body.toString());
    assert.equal(seen[seen.length - 1], 1);
    assert.ok(seen.length >= 2, "progresso aos pedaços: " + seen.join(","));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("download: erro HTTP e redirecionamento demais viram erro claro", async () => {
  const loop = {};
  for (let i = 0; i < 8; i += 1) loop["https://a/" + i] = { status: 301, location: "https://a/" + (i + 1) };
  const T = load(Object.assign({ "https://a/sumiu": { status: 404 } }, loop));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baixar-"));
  try {
    await assert.rejects(T.downloadFile("https://a/sumiu", path.join(dir, "x"), null, 0), /HTTP 404/);
    await assert.rejects(T.downloadFile("https://a/0", path.join(dir, "y"), null, 0), /Redirecionamentos demais/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("download: cancelar encerra o que está baixando", async () => {
  const T = load({ "https://a/grande": { status: 200, body: Buffer.alloc(100) } }, "https://a/grande");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baixar-"));
  try {
    const p = T.downloadFile("https://a/grande", path.join(dir, "g"), null, 0);
    await new Promise((r) => setImmediate(r));
    assert.equal(T.cancelAll(), 1, "um download em andamento");
    await assert.rejects(p);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("modelo: download que falha não deixa o .part nem um modelo pela metade", async () => {
  const T = load({ "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin": { status: 500 } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "modelo-"));
  try {
    await assert.rejects(T.downloadModel(dir, "base"), /Não foi possível baixar o modelo: Download falhou \(HTTP 500\)/);
    assert.deepEqual(fs.readdirSync(dir), [], "nada sobra na pasta");
    assert.equal(T.hasModel(dir, "base"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
