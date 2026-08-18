import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { BootstrapServer } from "../bootstrap.js";
import { nullLogger } from "../logger.js";
import { buildMobileconfig, pemToDer } from "../mobileconfig.js";

/** テスト用のルート CA 相当の自己署名証明書 */
function makeCaPem(): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sameport-ca-"));
  const certFile = path.join(dir, "rootCA.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", path.join(dir, "key.pem"), "-out", certFile,
    "-days", "1", "-subj", "/CN=mkcert test CA",
  ], { stdio: "ignore" });
  const pem = fs.readFileSync(certFile);
  fs.rmSync(dir, { recursive: true, force: true });
  return pem;
}

function startBootstrap(
  t: TestContext,
  caPem: Buffer | null,
): Promise<{ port: number }> {
  const server = new BootstrapServer({
    getCaPem: async () => caPem,
    hostname: "dev.local",
    getPortalUrl: () => "https://dev.local:8443/",
    log: nullLogger,
  });
  server.start(0);
  t.after(() => server.stop());
  return new Promise((resolve) => {
    const check = (): void => {
      const addr = server.address();
      if (addr) resolve({ port: addr.port });
      else setImmediate(check);
    };
    check();
  });
}

function fetchPlain(
  port: number,
  urlPath: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: urlPath, agent: false },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("mobileconfig は com.apple.security.root ペイロードに DER を埋める", () => {
  const caPem = makeCaPem();
  const profile = buildMobileconfig({ caPem, hostname: "dev.local" });

  assert.match(profile, /<key>PayloadType<\/key>\s*<string>com\.apple\.security\.root<\/string>/);
  assert.match(profile, /<key>PayloadType<\/key>\s*<string>Configuration<\/string>/);

  // <data> の中身が証明書の DER と一致すること
  const data = /<data>\n([\s\S]*?)\n\s*<\/data>/.exec(profile);
  assert.ok(data, "<data> ブロックがある");
  const embedded = Buffer.from(data[1].replace(/\s/g, ""), "base64");
  assert.deepEqual(embedded, pemToDer(caPem), "埋め込まれた DER が元の証明書と一致する");
  assert.ok(!profile.includes("PRIVATE KEY"), "秘密鍵は含まれない");
});

test("mobileconfig の UUID は CA ごとに決まり、同じ CA なら不変", () => {
  const caA = makeCaPem();
  const caB = makeCaPem();
  const uuidsOf = (pem: Buffer): string[] =>
    [...buildMobileconfig({ caPem: pem, hostname: "dev.local" }).matchAll(
      /<key>PayloadUUID<\/key>\s*<string>([^<]+)<\/string>/g,
    )].map((m) => m[1]);

  assert.deepEqual(uuidsOf(caA), uuidsOf(caA), "同じ CA なら毎回同じ UUID");
  assert.notDeepEqual(uuidsOf(caA), uuidsOf(caB), "別の CA なら別の UUID");
  for (const uuid of uuidsOf(caA)) {
    assert.match(uuid, /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
  }
});

test("配布は平文 HTTP。プロファイルは iOS 用の content-type で返る", async (t) => {
  const caPem = makeCaPem();
  const { port } = await startBootstrap(t, caPem);

  const res = await fetchPlain(port, "/rootCA.mobileconfig");
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "application/x-apple-aspen-config");
  assert.equal(
    res.headers["content-disposition"],
    undefined,
    "attachment を付けるとプロファイルではなくファイル保存になる",
  );
  assert.match(res.body, /com\.apple\.security\.root/);
});

test("セットアップページは手順とプロファイルへのリンクを出す", async (t) => {
  const { port } = await startBootstrap(t, makeCaPem());
  const res = await fetchPlain(port, "/");
  assert.equal(res.status, 200);
  assert.match(res.body, /\/rootCA\.mobileconfig/);
  assert.match(res.body, /証明書信頼設定/);
  assert.match(res.body, /https:\/\/dev\.local:8443\//, "ポータルへの導線がある");
});

test("CA が無いときは 404 と mkcert -install の案内", async (t) => {
  const { port } = await startBootstrap(t, null);
  const res = await fetchPlain(port, "/rootCA.mobileconfig");
  assert.equal(res.status, 404);
  assert.match(res.body, /mkcert -install/);
  const top = await fetchPlain(port, "/");
  assert.match(top.body, /mkcert -install/);
});

test("iOS 以外向けに生の PEM も配る", async (t) => {
  const caPem = makeCaPem();
  const { port } = await startBootstrap(t, caPem);
  const res = await fetchPlain(port, "/rootCA.pem");
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "application/x-x509-ca-cert");
  assert.equal(res.body, caPem.toString());
});

test("配布された証明書で実際に TLS 検証が通る", async (t) => {
  // 「配った CA を信頼させれば HTTPS が通る」ことを実際に検証する
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sameport-chain-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = (f: string): string => path.join(dir, f);

  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", p("ca-key.pem"), "-out", p("ca.pem"), "-days", "2",
    "-subj", "/CN=sameport test CA"], { stdio: "ignore" });
  execFileSync("openssl", ["req", "-newkey", "rsa:2048", "-nodes",
    "-keyout", p("srv-key.pem"), "-out", p("srv.csr"), "-subj", "/CN=dev.local"], { stdio: "ignore" });
  fs.writeFileSync(p("ext.cnf"), "subjectAltName=DNS:dev.local\n");
  execFileSync("openssl", ["x509", "-req", "-in", p("srv.csr"),
    "-CA", p("ca.pem"), "-CAkey", p("ca-key.pem"), "-CAcreateserial",
    "-out", p("srv.pem"), "-days", "1", "-extfile", p("ext.cnf")], { stdio: "ignore" });

  const caPem = fs.readFileSync(p("ca.pem"));
  const { port } = await startBootstrap(t, caPem);
  const distributed = (await fetchPlain(port, "/rootCA.pem")).body;

  const https = await import("node:https");
  const server = https.createServer(
    { key: fs.readFileSync(p("srv-key.pem")), cert: fs.readFileSync(p("srv.pem")) },
    (_req, res) => res.end("secure"),
  );
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const tlsPort = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
  });

  const body = await new Promise<string>((resolve, reject) => {
    const req = https.request(
      {
        host: "127.0.0.1",
        port: tlsPort,
        path: "/",
        servername: "dev.local",
        // 配布された CA だけを信頼して検証する（iPhone が証明書を入れた後と同じ状態）
        ca: distributed,
        checkServerIdentity: () => undefined,
        agent: false,
      },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve(b));
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(body, "secure");
  assert.ok(crypto.createHash("sha256").update(distributed).digest("hex").length === 64);
});
