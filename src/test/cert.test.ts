import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// paths.ts は import 時に環境変数を読むので、cert.js を読み込む前に差し替える
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "sameport-cert-"));
process.env.SAMEPORT_CONFIG_DIR = configDir;
const cert = await import("../cert.js");

function writeCa(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "rootCA.pem");
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
     "-keyout", path.join(dir, "rootCA-key.pem"), "-out", file,
     "-days", "1", "-subj", "/CN=mkcert test CA"],
    { stdio: "ignore" },
  );
  return file;
}

test("readRootCA はコピーを読む。mkcert を呼べなくても配布できる", async (t) => {
  // 常駐プロセスは launchd 配下で PATH が最小になり mkcert を呼べない。
  // そのとき CA を配れなくなるのが「ルート CA が見つかりません」の原因だった
  const caRootDir = path.join(configDir, "fake-caroot");
  const source = writeCa(caRootDir);
  fs.mkdirSync(path.dirname(cert.CA_FILE), { recursive: true });
  fs.copyFileSync(source, cert.CA_FILE);

  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent"; // mkcert がまったく見えない状態
  t.after(() => {
    process.env.PATH = originalPath;
  });

  const pem = await cert.readRootCA();
  assert.ok(pem, "mkcert 不在でもコピーから読めること");
  assert.equal(pem.toString(), fs.readFileSync(source).toString());
});

test("mkcert が見つからなければ null を返し、握りつぶさない", async (t) => {
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  t.after(() => {
    process.env.PATH = originalPath;
  });

  assert.equal(await cert.mkcertAvailable(), false);
});

test("defaultSans は LAN IP を含めない（IP は変わるため）", () => {
  const sans = cert.defaultSans("dev.local");
  assert.deepEqual(sans, ["dev.local", "*.dev.local", "localhost", "127.0.0.1", "::1"]);
  assert.ok(!sans.some((n) => /^192\.168\./.test(n)));
});

test.after(() => fs.rmSync(configDir, { recursive: true, force: true }));
