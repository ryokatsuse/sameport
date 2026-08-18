import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { Duplex } from "node:stream";
import type { TlsMaterial } from "./cert.js";
import type { DetectedServer } from "./discovery.js";
import type { Logger } from "./logger.js";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface UpstreamHeaderOptions {
  port: number;
  clientIp?: string;
  /** WebSocket Upgrade 中継時は Connection / Upgrade ヘッダを残す */
  forUpgrade?: boolean;
}

/**
 * upstream へ送るヘッダを組み立てる。
 * Host は `localhost:<port>` に書き換える（Vite の server.allowedHosts /
 * Next.js の allowedDevOrigins による Host 拒否を回避し、プロジェクト側の設定変更を不要にする。§6）。
 */
export function buildUpstreamHeaders(
  headers: http.IncomingHttpHeaders,
  opts: UpstreamHeaderOptions,
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  const originalHost = headers.host;
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const k = key.toLowerCase();
    if (k === "host") continue;
    if (k === "x-forwarded-for" || k === "x-forwarded-host" || k === "x-forwarded-proto") continue;
    if (!opts.forUpgrade && HOP_BY_HOP.has(k)) continue;
    out[key] = value;
  }
  out["host"] = `localhost:${opts.port}`;
  if (originalHost !== undefined) out["x-forwarded-host"] = originalHost;
  out["x-forwarded-proto"] = "https";
  const prior = headers["x-forwarded-for"];
  const priorStr = Array.isArray(prior) ? prior.join(", ") : prior;
  const xff = [priorStr, opts.clientIp].filter(Boolean).join(", ");
  if (xff) out["x-forwarded-for"] = xff;
  return out;
}

/**
 * upstream が返す `Location: http://localhost:5173/foo` のような絶対 URL を
 * `https://dev.local:5173/foo` に書き換える（§6）。
 * ボディ内の絶対 URL は書き換えない（明確に非対応）。
 */
export function rewriteLocation(value: string, upstreamPort: number, hostname: string): string {
  const m = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::(\d+))?([/?#].*)?$/i.exec(value);
  if (!m) return value;
  const port = m[1] ? Number(m[1]) : upstreamPort;
  const rest = m[2] ?? "/";
  return `https://${hostname}:${port}${rest}`;
}

/** クライアントへ返すレスポンスヘッダ（hop-by-hop を除去し Location を書き換える） */
export function buildDownstreamHeaders(
  headers: http.IncomingHttpHeaders,
  upstreamPort: number,
  hostname: string,
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const k = key.toLowerCase();
    if (HOP_BY_HOP.has(k)) continue;
    if (k === "location" && typeof value === "string") {
      out[key] = rewriteLocation(value, upstreamPort, hostname);
      continue;
    }
    out[key] = value;
  }
  return out;
}

export interface ForwarderOptions {
  port: number;
  hostname: string;
  log: Logger;
  onWsFailure?: () => void;
}

/** 通常の HTTP リクエストを http://127.0.0.1:<port> へ転送するハンドラ */
export function makeRequestForwarder(
  opts: ForwarderOptions,
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return (req, res) => {
    const upstreamReq = http.request(
      {
        host: "127.0.0.1",
        port: opts.port,
        method: req.method,
        path: req.url,
        headers: buildUpstreamHeaders(req.headers, {
          port: opts.port,
          clientIp: req.socket.remoteAddress,
        }),
      },
      (upstreamRes) => {
        res.writeHead(
          upstreamRes.statusCode ?? 502,
          buildDownstreamHeaders(upstreamRes.headers, opts.port, opts.hostname),
        );
        upstreamRes.pipe(res);
        upstreamRes.on("error", () => res.destroy());
      },
    );
    upstreamReq.on("error", (err) => {
      opts.log.warn(`proxy :${opts.port} upstream エラー: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      }
      res.end(`sameport: 127.0.0.1:${opts.port} に接続できません\n`);
    });
    req.pipe(upstreamReq);
    res.on("close", () => upstreamReq.destroy());
  };
}

/**
 * WebSocket（HMR）の Upgrade を生ソケットで中継するハンドラ。
 * HMR がここに依存するので最優先で通す（§4.2）。
 */
export function makeUpgradeForwarder(
  opts: ForwarderOptions,
): (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void {
  return (req, socket, head) => {
    const upstream = net.connect({ host: "127.0.0.1", port: opts.port });
    let established = false;
    upstream.on("connect", () => {
      established = true;
      const headers = buildUpstreamHeaders(req.headers, {
        port: opts.port,
        clientIp: (socket as net.Socket).remoteAddress,
        forUpgrade: true,
      });
      const lines = [`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1`];
      for (const [key, value] of Object.entries(headers)) {
        if (value === undefined) continue;
        for (const v of Array.isArray(value) ? value : [value]) {
          lines.push(`${key}: ${String(v)}`);
        }
      }
      upstream.write(lines.join("\r\n") + "\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", (err) => {
      if (!established) {
        // 黙って壊れるのが最悪（§6）。ポータルとログに具体的な対処を出す
        opts.log.warn(
          `proxy :${opts.port} WebSocket 中継に失敗 (${err.message})。` +
            `HMR が繋がらない場合、このプロジェクトは server.hmr（clientPort 等）の設定が必要かもしれません`,
        );
        opts.onWsFailure?.();
      }
      socket.destroy();
    });
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
  };
}

interface ProxyEntry {
  server: https.Server;
  closeTimer: NodeJS.Timeout | null;
  listening: boolean;
}

export interface ProxyManagerOptions {
  tls: TlsMaterial;
  hostname: string;
  graceMs: number;
  log: Logger;
  onWsFailure?: (port: number) => void;
}

/**
 * discovery の差分を受け取り、ポートごとに TLS リバースプロキシを
 * `<lanIp>:<port>` で立てる/畳む（§4.2）。
 *
 * dev サーバーは 127.0.0.1:<port> を掴んでいるので、LAN IP へのバインドは衝突しない。
 * これにより Mac 側 localhost:5173 と iPhone 側 dev.local:5173 のポート番号が一致する（§3）。
 */
export class ProxyManager {
  private lanIp: string | null = null;
  private desired = new Set<number>();
  private entries = new Map<number, ProxyEntry>();

  constructor(private opts: ProxyManagerOptions) {}

  activePorts(): number[] {
    return [...this.entries.entries()]
      .filter(([, e]) => e.listening && e.closeTimer === null)
      .map(([port]) => port)
      .sort((a, b) => a - b);
  }

  /** IP 変動時: 全 proxy を close → 新 IP で再 listen（§4.5） */
  setLanIp(ip: string | null): void {
    if (ip === this.lanIp) return;
    this.lanIp = ip;
    for (const port of [...this.entries.keys()]) this.closeEntry(port);
    if (ip === null) {
      this.opts.log.info("オフラインのため全 proxy を停止しました");
      return;
    }
    this.opts.log.info(`LAN IP ${ip} で listen します`);
    for (const port of this.desired) this.openEntry(port);
  }

  update(servers: DetectedServer[]): void {
    // wildcard バインド（--host 付き起動）は LAN IP でも listen 済みで衝突するため proxy しない（§3 注意書き）
    this.desired = new Set(
      servers.filter((s) => s.boundTo === "loopback").map((s) => s.port),
    );
    for (const port of this.desired) {
      const entry = this.entries.get(port);
      if (entry) {
        if (entry.closeTimer) {
          // グレース期間中に復活（dev サーバー再起動）→ proxy は立てたまま
          clearTimeout(entry.closeTimer);
          entry.closeTimer = null;
        }
      } else if (this.lanIp) {
        this.openEntry(port);
      }
    }
    for (const [port, entry] of this.entries) {
      if (!this.desired.has(port) && entry.closeTimer === null) {
        entry.closeTimer = setTimeout(() => this.closeEntry(port), this.opts.graceMs);
      }
    }
  }

  closeAll(): void {
    this.desired.clear();
    for (const port of [...this.entries.keys()]) this.closeEntry(port);
  }

  private openEntry(port: number): void {
    const ip = this.lanIp;
    if (!ip) return;
    const forwarderOpts: ForwarderOptions = {
      port,
      hostname: this.opts.hostname,
      log: this.opts.log,
      onWsFailure: () => this.opts.onWsFailure?.(port),
    };
    const server = https.createServer(
      {
        key: this.opts.tls.key,
        cert: this.opts.tls.cert,
        // h2 をネゴシエートすると WebSocket の Upgrade が使えなくなるため http/1.1 固定（§4.2）
        ALPNProtocols: ["http/1.1"],
      },
      makeRequestForwarder(forwarderOpts),
    );
    server.on("upgrade", makeUpgradeForwarder(forwarderOpts));
    const entry: ProxyEntry = { server, closeTimer: null, listening: false };
    server.on("error", (err: NodeJS.ErrnoException) => {
      this.opts.log.warn(`:${port} の listen に失敗しました (${err.code ?? err.message})`);
      this.entries.delete(port);
    });
    server.listen(port, ip, () => {
      entry.listening = true;
      this.opts.log.info(
        `https://${this.opts.hostname}:${port} → http://127.0.0.1:${port}`,
      );
    });
    this.entries.set(port, entry);
  }

  private closeEntry(port: number): void {
    const entry = this.entries.get(port);
    if (!entry) return;
    if (entry.closeTimer) clearTimeout(entry.closeTimer);
    entry.server.close();
    entry.server.closeAllConnections();
    this.entries.delete(port);
  }
}
