import fs from "node:fs";
import type http from "node:http";
import https from "node:https";
import type net from "node:net";
import path from "node:path";
import type { TlsMaterial } from "./cert.js";
import type { BoundTo } from "./discovery.js";
import type { HistoryEntry } from "./history.js";
import type { Logger } from "./logger.js";
import { PORTAL_HTML } from "./portal-html.js";

export interface PortalServerView {
  port: number;
  label: string;
  command: string;
  boundTo: BoundTo;
  hmrWarning: boolean;
  url: string;
}

export interface PortalState {
  hostname: string;
  portalPort: number;
  lanIp: string | null;
  iface: string | null;
  ssid: string | null;
  online: boolean;
  servers: PortalServerView[];
  pinned: { port: number; label: string }[];
  history: HistoryEntry[];
  certExpiresAt: string | null;
}

export interface PortalOptions {
  tls: TlsMaterial;
  getState: () => PortalState;
  /** mkcert の CAROOT ディレクトリ（rootCA.pem 配布用）。null なら配布不可 */
  getCaRoot: () => Promise<string | null>;
  log: Logger;
}

const SSE_HEARTBEAT_MS = 15_000;

/**
 * 固定の入口ページ（§4.6）。iPhone がブックマークするのはこの URL だけ。
 * ポータル自身のポートは専有なので 0.0.0.0 にバインドし、IP 変動の影響を受けない。
 */
export class Portal {
  private server: https.Server | null = null;
  private clients = new Set<http.ServerResponse>();
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(private opts: PortalOptions) {}

  start(port: number): void {
    const server = https.createServer(
      { key: this.opts.tls.key, cert: this.opts.tls.cert, ALPNProtocols: ["http/1.1"] },
      (req, res) => void this.handle(req, res),
    );
    server.on("error", (err: NodeJS.ErrnoException) => {
      this.opts.log.error(`portal: listen に失敗しました (${err.code ?? err.message})`);
    });
    server.listen(port, () => {
      const { hostname } = this.opts.getState();
      this.opts.log.info(`portal: https://${hostname}:${port}/`);
    });
    this.server = server;
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) client.write(": ping\n\n");
    }, SSE_HEARTBEAT_MS);
  }

  /** listen 中のアドレス。listen(0) を使うテストからポートを知るために公開する */
  address(): net.AddressInfo | null {
    const addr = this.server?.address();
    return addr && typeof addr === "object" ? addr : null;
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const client of this.clients) client.end();
    this.clients.clear();
    this.server?.close();
    this.server?.closeAllConnections();
    this.server = null;
  }

  /** 状態が変わったら呼ぶ。接続中の SSE クライアント全員に最新状態を配る */
  broadcast(): void {
    if (this.clients.size === 0) return;
    const payload = `event: state\ndata: ${JSON.stringify(this.opts.getState())}\n\n`;
    for (const client of this.clients) client.write(payload);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "https://portal.invalid");
    switch (url.pathname) {
      case "/":
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(PORTAL_HTML);
        return;
      case "/api/servers":
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify(this.opts.getState()));
        return;
      case "/events":
        this.handleSse(res);
        return;
      case "/rootCA.pem":
        await this.serveCa(res);
        return;
      default:
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("not found\n");
    }
  }

  private handleSse(res: http.ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write(`event: state\ndata: ${JSON.stringify(this.opts.getState())}\n\n`);
    this.clients.add(res);
    res.on("close", () => this.clients.delete(res));
  }

  private async serveCa(res: http.ServerResponse): Promise<void> {
    const caRoot = await this.opts.getCaRoot();
    const file = caRoot ? path.join(caRoot, "rootCA.pem") : null;
    if (!file || !fs.existsSync(file)) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("rootCA.pem が見つかりません。Mac 側で `mkcert -install` を実行してください\n");
      return;
    }
    // iOS がプロファイルとして認識する content-type にする
    res.writeHead(200, {
      "content-type": "application/x-x509-ca-cert",
      "content-disposition": 'attachment; filename="rootCA.pem"',
    });
    res.end(fs.readFileSync(file));
  }
}
