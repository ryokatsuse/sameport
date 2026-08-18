import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test, { type TestContext } from "node:test";
import { nullLogger } from "../logger.js";
import { makeRequestForwarder, makeUpgradeForwarder } from "../proxy.js";

/**
 * テスト用にサーバーを listen し、確実に後片付けできるようにする。
 * upgrade したソケットはサーバーの管理から外れて close() では閉じないため、自前で掴んでおく。
 */
function listen(server: http.Server, t: TestContext): Promise<number> {
  const sockets: net.Socket[] = [];
  server.on("connection", (socket) => sockets.push(socket));
  server.on("upgrade", (_req, socket) => sockets.push(socket as net.Socket));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    server.close();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
  });
}

function get(port: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      // agent: false — keep-alive のソケットが残ると server.close() が返らずテストが終わらない
      const req = http.request({ host: "127.0.0.1", port, path, headers, agent: false }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
        );
      });
      req.on("error", reject);
      req.end();
    },
  );
}

test("プロキシは Host を localhost に書き換えて転送し、本文をそのまま返す", async (t) => {
  let seenHost: string | undefined;
  let seenXfh: string | string[] | undefined;
  const upstream = http.createServer((req, res) => {
    seenHost = req.headers.host;
    seenXfh = req.headers["x-forwarded-host"];
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("hello from upstream");
  });
  const upstreamPort = await listen(upstream, t);

  const proxy = http.createServer(
    makeRequestForwarder({ port: upstreamPort, hostname: "dev.local", log: nullLogger }),
  );
  const proxyPort = await listen(proxy, t);
  const res = await get(proxyPort, "/index.html", { host: "dev.local:5173" });
  assert.equal(res.status, 200);
  assert.equal(res.body, "hello from upstream");
  assert.equal(seenHost, `localhost:${upstreamPort}`);
  assert.equal(seenXfh, "dev.local:5173");
});

test("プロキシは upstream の Location を https://<hostname> に書き換える", async (t) => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(302, { location: "http://localhost/redirected" });
    res.end();
  });
  const upstreamPort = await listen(upstream, t);
  const proxy = http.createServer(
    makeRequestForwarder({ port: upstreamPort, hostname: "dev.local", log: nullLogger }),
  );
  const proxyPort = await listen(proxy, t);
  const res = await get(proxyPort, "/");
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, `https://dev.local:${upstreamPort}/redirected`);
});

test("upstream が落ちているときは 502 を返す", async (t) => {
  const dead = net.createServer();
  const deadPort = await new Promise<number>((resolve) => {
    dead.listen(0, "127.0.0.1", () => resolve((dead.address() as net.AddressInfo).port));
  });
  await new Promise<void>((resolve) => dead.close(() => resolve()));

  const proxy = http.createServer(
    makeRequestForwarder({ port: deadPort, hostname: "dev.local", log: nullLogger }),
  );
  const proxyPort = await listen(proxy, t);
  const res = await get(proxyPort, "/");
  assert.equal(res.status, 502);
  assert.match(res.body, /sameport/);
});

test("WebSocket の Upgrade を中継し、双方向にデータが流れる（HMR 相当）", async (t) => {
  const upstream = http.createServer();
  upstream.on("upgrade", (req, socket) => {
    assert.equal(req.headers.upgrade, "websocket");
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (chunk) => socket.write(`echo:${chunk.toString()}`));
  });
  const upstreamPort = await listen(upstream, t);

  const proxy = http.createServer((_req, res) => res.end());
  proxy.on(
    "upgrade",
    makeUpgradeForwarder({ port: upstreamPort, hostname: "dev.local", log: nullLogger }),
  );
  const proxyPort = await listen(proxy, t);
  const received = await new Promise<string>((resolve, reject) => {
    const client = net.connect(proxyPort, "127.0.0.1", () => {
      client.write(
        "GET /hmr HTTP/1.1\r\nHost: dev.local:5173\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
      );
    });
    let buf = "";
    client.on("data", (chunk) => {
      buf += chunk.toString();
      if (buf.includes("101")) {
        client.write("ping");
        buf = buf.slice(buf.indexOf("\r\n\r\n") + 4);
      }
      if (buf.includes("echo:ping")) {
        client.destroy();
        resolve(buf);
      }
    });
    client.on("error", reject);
    setTimeout(() => reject(new Error("timeout")), 5000).unref();
  });
  assert.match(received, /echo:ping/);
});

test("Upgrade 先が繋がらないときは onWsFailure で診断できる", async (t) => {
  const dead = net.createServer();
  const deadPort = await new Promise<number>((resolve) => {
    dead.listen(0, "127.0.0.1", () => resolve((dead.address() as net.AddressInfo).port));
  });
  await new Promise<void>((resolve) => dead.close(() => resolve()));

  let failed = false;
  const proxy = http.createServer((_req, res) => res.end());
  proxy.on(
    "upgrade",
    makeUpgradeForwarder({
      port: deadPort,
      hostname: "dev.local",
      log: nullLogger,
      onWsFailure: () => (failed = true),
    }),
  );
  const proxyPort = await listen(proxy, t);
  await new Promise<void>((resolve) => {
    const client = net.connect(proxyPort, "127.0.0.1", () => {
      client.write("GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    });
    client.on("close", () => resolve());
    client.on("error", () => resolve());
  });
  assert.equal(failed, true);
});
