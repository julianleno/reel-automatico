/**
 * Baixa os binários que a extensão embute (Windows x64) para src/adobe/cep/bin/:
 *   bin/ffmpeg.exe             build LGPL (BtbN/FFmpeg-Builds)
 *   bin/whisper/whisper-cli.exe + DLLs   (ggml-org/whisper.cpp v1.9.2 com Vulkan, ver .github/workflows/whisper-vulkan.yml)
 *
 * Uso: node scripts/fetch-binaries.js [ffmpeg] [whisper]   (sem argumentos baixa os dois)
 * A pasta bin/ é ignorada pelo git; rode antes de `npm run build:installer`.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const { execFileSync } = require("node:child_process");

const binDir = path.resolve(__dirname, "..", "src", "adobe", "cep", "bin");

const PACKAGES = {
  ffmpeg: {
    url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip",
    // copia só o executável
    install(extracted) {
      const exe = find(extracted, "ffmpeg.exe");
      fs.copyFileSync(exe, path.join(binDir, "ffmpeg.exe"));
    },
  },
  whisper: {
    // O projeto não publica build com GPU para Windows; este é o nosso (workflow whisper-vulkan).
    url: "https://github.com/julianleno/app-legendas-updates/releases/download/whisper-vulkan-v1.9.2/whisper-vulkan-bin-x64.zip",
    // copia whisper-cli.exe e as DLLs que estão ao lado dele
    install(extracted) {
      const dir = path.dirname(find(extracted, "whisper-cli.exe"));
      const dest = path.join(binDir, "whisper");
      fs.mkdirSync(dest, { recursive: true });
      for (const name of fs.readdirSync(dir)) {
        if (name === "whisper-cli.exe" || /\.dll$/i.test(name)) fs.copyFileSync(path.join(dir, name), path.join(dest, name));
      }
    },
  },
};

function find(dir, fileName) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.toLowerCase() === fileName) return path.join(entry.parentPath || entry.path, entry.name);
  }
  throw new Error(`${fileName} não encontrado no pacote baixado.`);
}

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirects >= 5) return reject(new Error("Redirecionamentos demais."));
          return download(new URL(res.headers.location, url).toString(), dest, redirects + 1).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} em ${url}`));
        }
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on("finish", () => out.close(resolve));
        out.on("error", reject);
      })
      .on("error", reject);
  });
}

async function main() {
  const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(PACKAGES);
  fs.mkdirSync(binDir, { recursive: true });

  for (const name of wanted) {
    const pkg = PACKAGES[name];
    if (!pkg) throw new Error(`Pacote desconhecido: ${name} (use: ${Object.keys(PACKAGES).join(", ")})`);

    const work = fs.mkdtempSync(path.join(os.tmpdir(), `applegendas-${name}-`));
    try {
      const zip = path.join(work, "pacote.zip");
      console.log(`Baixando ${name}: ${pkg.url}`);
      await download(pkg.url, zip);
      const extracted = path.join(work, "extraido");
      fs.mkdirSync(extracted);
      // O tar do Windows 10+ (bsdtar) lê .zip; o caminho completo evita pegar o tar do Git Bash.
      const tar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
      execFileSync(tar, ["-xf", zip, "-C", extracted], { stdio: "inherit" });
      pkg.install(extracted);
      console.log(`${name} instalado em ${path.relative(process.cwd(), binDir)}`);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
