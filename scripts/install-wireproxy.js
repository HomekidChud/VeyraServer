"use strict";









const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const VERSION = process.env.VPN_WIREPROXY_VERSION || "v1.1.3";
const REPO = "windtf/wireproxy";
const BIN_DIR = path.join(__dirname, "..", "bin");
const TARGET = path.join(BIN_DIR, "wireproxy");

async function main() {
  if (/^(1|true|yes)$/i.test(process.env.VPN_WIREPROXY_SKIP || "")) return console.log("[wireproxy] skipped (VPN_WIREPROXY_SKIP).");
  if (fs.existsSync(TARGET) && !process.argv.includes("--force")) return console.log(`[wireproxy] already installed at ${TARGET}.`);
  const arch = { x64: "amd64", arm64: "arm64", arm: "arm", ia32: "386" }[os.arch()];
  const platform = { linux: "linux", darwin: "darwin" }[os.platform()];
  if (!arch || !platform) return console.log(`[wireproxy] no prebuilt binary for ${os.platform()}/${os.arch()}; WireGuard profiles disabled.`);
  const asset = `wireproxy_${platform}_${platform === "darwin" ? "all" : arch}.tar.gz`;
  const base = `https://github.com/${REPO}/releases/download/${VERSION}`;
  console.log(`[wireproxy] downloading ${asset} ${VERSION}…`);
  const [tarball, sums] = await Promise.all([download(`${base}/${asset}`), download(`${base}/checksums.txt`).then(b => b.toString("utf8")).catch(() => "")]);
  const expected = sums.split("\n").map(l => l.trim().split(/\s+/)).find(([, name]) => name === asset)?.[0];
  const actual = crypto.createHash("sha256").update(tarball).digest("hex");
  if (expected && expected !== actual) throw new Error(`checksum mismatch for ${asset} (expected ${expected}, got ${actual})`);
  if (!expected) console.log("[wireproxy] warning: checksum list unavailable, continuing without verification.");
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const tmp = path.join(os.tmpdir(), `wireproxy-${process.pid}.tar.gz`);
  fs.writeFileSync(tmp, tarball);
  execFileSync("tar", ["-xzf", tmp, "-C", BIN_DIR, "wireproxy"], { stdio: "inherit" });
  fs.unlinkSync(tmp);
  fs.chmodSync(TARGET, 0o755);
  console.log(`[wireproxy] installed ${TARGET}${expected ? " (sha256 verified)" : ""}.`);
}

async function download(url, redirects = 5) {
  const r = await fetch(url, { redirect: "follow", headers: { "user-agent": "veyra-install" } });
  if (!r.ok) throw new Error(`GET ${url} → HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

main().catch(e => { console.log(`[wireproxy] not installed: ${e.message}. HTTP/SOCKS5 VPN profiles still work.`); });
