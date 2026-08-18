import assert from "node:assert/strict";
import test from "node:test";
import { mergeConfig, makePortFilter, DEFAULT_CONFIG } from "../config.js";
import { classifyAddr, groupByPort, parseLsofListeners } from "../discovery.js";
import { labelFromHostname } from "../hostname.js";
import { buildPlist } from "../launchd.js";
import {
  buildDownstreamHeaders,
  buildUpstreamHeaders,
  rewriteLocation,
  rewriteReferer,
  rewriteSetCookie,
} from "../proxy.js";
import { labelFor } from "../supervisor.js";

test("parseLsofListeners はプロセス単位の -F 出力をレコードに展開する", () => {
  const output = ["p123", "cnode", "n127.0.0.1:5173", "n[::1]:5173", "p456", "cbun", "n*:3000"].join(
    "\n",
  );
  assert.deepEqual(parseLsofListeners(output), [
    { pid: 123, command: "node", addr: "127.0.0.1", port: 5173 },
    { pid: 123, command: "node", addr: "[::1]", port: 5173 },
    { pid: 456, command: "bun", addr: "*", port: 3000 },
  ]);
});

test("parseLsofListeners はプロセス見出しの前に来た名前行を捨てる", () => {
  assert.deepEqual(parseLsofListeners("n127.0.0.1:5173\np1\ncnode\nn127.0.0.1:3000"), [
    { pid: 1, command: "node", addr: "127.0.0.1", port: 3000 },
  ]);
});

test("classifyAddr は loopback とそれ以外を分ける", () => {
  assert.equal(classifyAddr("127.0.0.1"), "loopback");
  assert.equal(classifyAddr("[::1]"), "loopback");
  assert.equal(classifyAddr("localhost"), "loopback");
  assert.equal(classifyAddr("*"), "wildcard");
  assert.equal(classifyAddr("0.0.0.0"), "wildcard");
  assert.equal(classifyAddr("192.168.1.5"), "wildcard");
});

test("groupByPort は同一ポートをまとめ、wildcard を優先する", () => {
  const grouped = groupByPort([
    { pid: 1, command: "node", addr: "127.0.0.1", port: 5173 },
    { pid: 1, command: "node", addr: "[::1]", port: 5173 },
    { pid: 2, command: "node", addr: "127.0.0.1", port: 3000 },
    { pid: 2, command: "node", addr: "*", port: 3000 },
  ]);
  assert.deepEqual(grouped, [
    { port: 5173, pid: 1, command: "node", boundTo: "loopback" },
    { port: 3000, pid: 2, command: "node", boundTo: "wildcard" },
  ]);
});

test("makePortFilter は deny とポータルポートを除外する", () => {
  const filter = makePortFilter(mergeConfig({ portalPort: 8443 }));
  assert.equal(filter(5173), true);
  assert.equal(filter(5432), false);
  assert.equal(filter(8443), false);
});

test("makePortFilter: allow は deny より優先される", () => {
  const filter = makePortFilter(mergeConfig({ ports: { mode: "auto", allow: [5432], deny: [5432] } }));
  assert.equal(filter(5432), true);
});

test("makePortFilter: manual モードは allow のみ通す", () => {
  const filter = makePortFilter(mergeConfig({ ports: { mode: "manual", allow: [5173], deny: [] } }));
  assert.equal(filter(5173), true);
  assert.equal(filter(3000), false);
});

test("mergeConfig は部分設定をデフォルトに重ねる", () => {
  const config = mergeConfig({ portalPort: 9443, discovery: { intervalMs: 1000 } as never });
  assert.equal(config.portalPort, 9443);
  assert.equal(config.hostname, DEFAULT_CONFIG.hostname);
  assert.equal(config.discovery.intervalMs, 1000);
  assert.equal(config.discovery.graceMs, DEFAULT_CONFIG.discovery.graceMs);
});

test("buildUpstreamHeaders は Host を localhost に書き換え XFF 系を付ける", () => {
  const headers = buildUpstreamHeaders(
    { host: "dev.local:5173", accept: "text/html", connection: "keep-alive" },
    { port: 5173, clientIp: "192.168.1.20" },
  );
  assert.equal(headers.host, "localhost:5173");
  assert.equal(headers["x-forwarded-host"], "dev.local:5173");
  assert.equal(headers["x-forwarded-proto"], "https");
  assert.equal(headers["x-forwarded-for"], "192.168.1.20");
  assert.equal(headers.accept, "text/html");
  assert.equal(headers.connection, undefined, "hop-by-hop は落とす");
});

test("buildUpstreamHeaders は Upgrade 時に connection/upgrade を残す", () => {
  const headers = buildUpstreamHeaders(
    { host: "dev.local:5173", connection: "Upgrade", upgrade: "websocket" },
    { port: 5173, forUpgrade: true },
  );
  assert.equal(headers.connection, "Upgrade");
  assert.equal(headers.upgrade, "websocket");
});

test("buildUpstreamHeaders は既存の X-Forwarded-For に追記する", () => {
  const headers = buildUpstreamHeaders(
    { "x-forwarded-for": "10.0.0.1" },
    { port: 5173, clientIp: "192.168.1.20" },
  );
  assert.equal(headers["x-forwarded-for"], "10.0.0.1, 192.168.1.20");
});

test("rewriteLocation は loopback 絶対 URL だけを書き換える", () => {
  assert.equal(
    rewriteLocation("http://localhost:5173/foo?a=1", 5173, "dev.local"),
    "https://dev.local:5173/foo?a=1",
  );
  assert.equal(rewriteLocation("http://127.0.0.1:3000/", 3000, "dev.local"), "https://dev.local:3000/");
  assert.equal(rewriteLocation("http://localhost", 5173, "dev.local"), "https://dev.local:5173/");
  assert.equal(rewriteLocation("/relative/path", 5173, "dev.local"), "/relative/path");
  assert.equal(
    rewriteLocation("https://example.com/x", 5173, "dev.local"),
    "https://example.com/x",
    "外部 URL は触らない",
  );
});

test("buildDownstreamHeaders は Location を書き換え hop-by-hop を落とす", () => {
  const headers = buildDownstreamHeaders(
    { location: "http://localhost:5173/next", "transfer-encoding": "chunked", "set-cookie": ["a=1"] },
    5173,
    "dev.local",
  );
  assert.equal(headers.location, "https://dev.local:5173/next");
  assert.equal(headers["transfer-encoding"], undefined);
  assert.deepEqual(headers["set-cookie"], ["a=1"]);
});

test("labelFromHostname は .local を落とす", () => {
  assert.equal(labelFromHostname("dev.local"), "dev");
  assert.equal(labelFromHostname("dev"), "dev");
});

test("labelFor は cwd の basename を使い、なければプロセス名にフォールバックする", () => {
  const base = { port: 5173, pid: 1, boundTo: "loopback" as const, firstSeenAt: 0 };
  assert.equal(labelFor({ ...base, command: "node", cwd: "/Users/me/src/portfolio" }), "portfolio");
  assert.equal(labelFor({ ...base, command: "bun", cwd: "" }), "bun");
});

test("buildPlist は XML をエスケープし start 引数を含む", () => {
  const plist = buildPlist("/usr/local/bin/node", "/opt/app & co/dist/cli.js");
  assert.match(plist, /<string>dev\.sameport<\/string>/);
  assert.match(plist, /<string>start<\/string>/);
  assert.match(plist, /app &amp; co/);
});

test("buildUpstreamHeaders は Origin を Host と同じオリジンに揃える", () => {
  // Host だけ書き換えて Origin を素通しすると、CSRF 対策で POST が 403 になる
  const headers = buildUpstreamHeaders(
    { host: "dev.local:5555", origin: "https://dev.local:5555" },
    { port: 5555 },
  );
  assert.equal(headers.origin, "http://localhost:5555");
  assert.equal(headers.host, "localhost:5555");
  assert.equal(
    new URL(String(headers.origin)).host,
    headers.host,
    "Origin のホストと Host が一致している",
  );
});

test("buildUpstreamHeaders は Referer のパスを保ったまま書き換える", () => {
  const headers = buildUpstreamHeaders(
    { host: "dev.local:5555", referer: "https://dev.local:5555/login?next=/dashboard#top" },
    { port: 5555 },
  );
  assert.equal(headers.referer, "http://localhost:5555/login?next=/dashboard#top");
});

test("rewriteReferer は外部サイトからの遷移には触らない", () => {
  assert.equal(
    rewriteReferer("https://github.com/some/page", 5555, "dev.local:5555"),
    "https://github.com/some/page",
  );
  assert.equal(rewriteReferer("(not a url)", 5555), "(not a url)");
});

test("rewriteSetCookie は localhost 向けの Domain を落とす", () => {
  assert.equal(
    rewriteSetCookie("session=abc; Domain=localhost; Path=/; HttpOnly"),
    "session=abc; Path=/; HttpOnly",
  );
  assert.equal(rewriteSetCookie("session=abc; domain=.localhost; Path=/"), "session=abc; Path=/");
  assert.equal(rewriteSetCookie("session=abc; Domain=127.0.0.1; Path=/"), "session=abc; Path=/");
});

test("rewriteSetCookie は localhost 以外の Domain と他の属性を残す", () => {
  assert.equal(
    rewriteSetCookie("session=abc; Domain=example.com; Path=/"),
    "session=abc; Domain=example.com; Path=/",
  );
  assert.equal(
    rewriteSetCookie("session=abc; Path=/; Secure; SameSite=None"),
    "session=abc; Path=/; Secure; SameSite=None",
  );
});

test("buildDownstreamHeaders は複数の Set-Cookie をすべて処理する", () => {
  const headers = buildDownstreamHeaders(
    { "set-cookie": ["a=1; Domain=localhost; Path=/", "b=2; Domain=example.com"] },
    5555,
    "dev.local",
  );
  assert.deepEqual(headers["set-cookie"], ["a=1; Path=/", "b=2; Domain=example.com"]);
});
