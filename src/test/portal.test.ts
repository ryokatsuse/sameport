import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { nullLogger } from "../logger.js";
import { Portal, type PortalState } from "../portal.js";

/** テスト専用の自己署名証明書（mkcert 非依存でポータルの TLS 経路を通す） */
function selfSignedTls(): { key: Buffer; cert: Buffer } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sameport-test-"));
  const keyFile = path.join(dir, "key.pem");
  const certFile = path.join(dir, "cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyFile, "-out", certFile,
    "-days", "1", "-subj", "/CN=dev.local",
  ]);
  const material = { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
  fs.rmSync(dir, { recursive: true, force: true });
  return material;
}

function baseState(): PortalState {
  return {
    hostname: "dev.local",
    portalPort: 0,
    lanIp: "192.168.1.10",
    iface: "en0",
    ssid: "home",
    online: true,
    servers: [
      {
        port: 5173,
        label: "portfolio",
        command: "node",
        boundTo: "loopback",
        hmrWarning: false,
        url: "https://dev.local:5173/",
      },
    ],
    pinned: [],
    history: [],
    certExpiresAt: null,
  };
}

function startPortal(
  t: TestContext,
  getState: () => PortalState,
): Promise<{ port: number; portal: Portal }> {
  const portal = new Portal({
    tls: selfSignedTls(),
    getState,
    getCaRoot: async () => null,
    log: nullLogger,
  });
  // listen(0) でエフェメラルポートを割り当て、実際に開いたポートを拾う
  portal.start(0);
  t.after(() => portal.stop());
  return new Promise((resolve) => {
    const check = (): void => {
      const addr = portal.address();
      if (addr) resolve({ port: addr.port, portal });
      else setImmediate(check);
    };
    check();
  });
}

function fetchPortal(port: number, urlPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: "127.0.0.1", port, path: urlPath, rejectUnauthorized: false, agent: false },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("ポータルは HTTPS で単一 HTML を返す", async (t) => {
  const { port } = await startPortal(t, baseState);
  const res = await fetchPortal(port, "/");
  assert.equal(res.status, 200);
  assert.match(res.body, /<title>sameport<\/title>/);
  assert.match(res.body, /aria-live="polite"/);
  assert.match(res.body, /prefers-color-scheme/);
});

test("/api/servers は現在の状態を JSON で返す", async (t) => {
  const { port } = await startPortal(t, baseState);
  const res = await fetchPortal(port, "/api/servers");
  assert.equal(res.status, 200);
  const state = JSON.parse(res.body) as PortalState;
  assert.equal(state.servers.length, 1);
  assert.equal(state.servers[0].url, "https://dev.local:5173/");
  assert.equal(state.lanIp, "192.168.1.10");
});

test("/events は SSE で初期状態を流し、broadcast で更新を配る", async (t) => {
  let state = baseState();
  const { port, portal } = await startPortal(t, () => state);

  const events: string[] = [];
  const received = await new Promise<string>((resolve, reject) => {
    const req = https.request(
      { host: "127.0.0.1", port, path: "/events", rejectUnauthorized: false, agent: false },
      (res) => {
        assert.match(String(res.headers["content-type"]), /text\/event-stream/);
        res.on("data", (chunk: Buffer) => {
          events.push(chunk.toString());
          if (events.length === 1) {
            // 初期状態を受け取ったら状態を変えて broadcast する
            state = { ...state, servers: [] };
            portal.broadcast();
          } else {
            req.destroy();
            resolve(events.join(""));
          }
        });
      },
    );
    req.on("error", (err) => {
      if (events.length < 2) reject(err);
    });
    req.end();
    setTimeout(() => reject(new Error("timeout")), 5000).unref();
  });

  assert.match(received, /event: state/);
  assert.match(received, /portfolio/, "初期状態に検出中サーバーが含まれる");
  assert.match(received, /"servers":\[\]/, "broadcast 後の空一覧が届く");
});

test("CA が無いときの /rootCA.pem は 404 と対処を返す", async (t) => {
  const { port } = await startPortal(t, baseState);
  const res = await fetchPortal(port, "/rootCA.pem");
  assert.equal(res.status, 404);
  assert.match(res.body, /mkcert -install/);
});
