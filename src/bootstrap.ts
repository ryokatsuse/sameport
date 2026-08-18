import http from "node:http";
import type net from "node:net";
import type { Logger } from "./logger.js";
import { buildMobileconfig } from "./mobileconfig.js";

/**
 * ルート CA を配るためだけの平文 HTTP サーバー。
 *
 * ポータルは mkcert の証明書で TLS 終端しているが、その証明書を信頼させる前は
 * iOS がプロファイルのダウンロードを拒否する（鶏と卵）。ページ自体は
 * 「このまま進む」で開けても、プロファイル取得は別経路で失敗する。
 * そのため CA の配布だけは平文 HTTP で行う。ここで配るのは公開鍵である
 * ルート CA 証明書だけで、秘密鍵は一切出さない。
 */
export interface BootstrapOptions {
  getCaPem: () => Promise<Buffer | null>;
  hostname: string;
  /** ポータルの URL（証明書インストール後の誘導先） */
  getPortalUrl: () => string;
  log: Logger;
}

function page(hostname: string, portalUrl: string, caAvailable: boolean): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>sameport のセットアップ</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --fg:#1c1e21; --muted:#667085; --accent:#2563eb; --border:#e4e7ec;
          color-scheme: light dark; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#101214; --card:#1a1d21; --fg:#e6e8ea; --muted:#98a2b3; --accent:#7aa2ff; --border:#2a2f36; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:20px; background:var(--bg); color:var(--fg); max-width:640px;
         margin-inline:auto; font-family:system-ui,-apple-system,"Hiragino Sans",sans-serif; line-height:1.7; }
  h1 { font-size:1.25rem; }
  ol { padding-left:1.2em; }
  li { margin-bottom:10px; }
  strong { color:var(--accent); }
  .cta { display:block; text-align:center; padding:16px; margin:20px 0; border-radius:12px;
         background:var(--accent); color:#fff; text-decoration:none; font-weight:600; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:16px; margin:16px 0; }
  .muted { color:var(--muted); font-size:0.85rem; }
  code { font-family:ui-monospace,"SF Mono",Menlo,monospace; }
</style>
</head>
<body>
<h1>sameport のセットアップ</h1>
${
  caAvailable
    ? `<p>この iPhone で <code>${hostname}</code> を HTTPS で開けるようにします。<strong>Safari で</strong>この順に進めてください。</p>
<a class="cta" href="/rootCA.mobileconfig">1. ルート証明書をインストール</a>
<ol>
  <li>上のボタンをタップし、「許可」→「閉じる」</li>
  <li>設定 → 一般 → <strong>VPN とデバイス管理</strong> → ダウンロード済みプロファイル → インストール</li>
  <li>設定 → 一般 → 情報 → <strong>証明書信頼設定</strong> → sameport / mkcert のトグルを <strong>ON</strong>
      <div class="muted">ここを飛ばすと HTTPS で開けません。最頻出のハマりどころです。</div></li>
</ol>
<div class="card">
  <p>ここまで終わったらポータルを開いてホーム画面に追加してください。以降はこの URL だけ使います。</p>
  <a class="cta" href="${portalUrl}">2. ポータルを開く</a>
  <p class="muted">${portalUrl}</p>
</div>
<p class="muted">このページだけは平文 HTTP です。証明書を信頼させる前は HTTPS でプロファイルを配れないためで、
ここで配っているのは公開のルート証明書のみです。</p>`
    : `<div class="card">
  <p>ルート CA が見つかりませんでした。Mac 側で次を実行してください。</p>
  <p><code>mkcert -install</code> のあと <code>sameport setup</code></p>
  <p class="muted">すでに実行済みでこの表示が出る場合は、Mac で <code>sameport status</code> を実行し、
  「配布用ルート CA」の行を確認してください。</p>
</div>`
}
</body>
</html>
`;
}

export class BootstrapServer {
  private server: http.Server | null = null;

  constructor(private opts: BootstrapOptions) {}

  start(port: number): void {
    const server = http.createServer((req, res) => void this.handle(req, res));
    server.on("error", (err: NodeJS.ErrnoException) => {
      this.opts.log.error(
        `bootstrap: 平文 HTTP の listen に失敗しました (${err.code ?? err.message})。` +
          "config の bootstrapPort を変えてください",
      );
    });
    server.listen(port, () => this.opts.log.info(`bootstrap(証明書配布): http://${this.opts.hostname}:${port}/`));
    this.server = server;
  }

  stop(): void {
    this.server?.close();
    this.server?.closeAllConnections();
    this.server = null;
  }

  address(): net.AddressInfo | null {
    const addr = this.server?.address();
    return addr && typeof addr === "object" ? addr : null;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://bootstrap.invalid");
    const caPem = await this.opts.getCaPem();

    switch (url.pathname) {
      case "/":
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(page(this.opts.hostname, this.opts.getPortalUrl(), caPem !== null));
        return;

      case "/rootCA.mobileconfig": {
        if (!caPem) return this.notFound(res);
        // Content-Disposition は付けない。attachment にすると
        // プロファイルインストーラではなくファイル保存の経路に流れてしまう
        res.writeHead(200, { "content-type": "application/x-apple-aspen-config" });
        res.end(buildMobileconfig({ caPem, hostname: this.opts.hostname }));
        return;
      }

      case "/rootCA.pem": {
        // iOS 以外（Android や別の Mac）向けの生の PEM
        if (!caPem) return this.notFound(res);
        res.writeHead(200, {
          "content-type": "application/x-x509-ca-cert",
          "content-disposition": 'attachment; filename="rootCA.pem"',
        });
        res.end(caPem);
        return;
      }

      default:
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("not found\n");
    }
  }

  private notFound(res: http.ServerResponse): void {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end(
      "ルート CA が見つかりません。Mac 側で `mkcert -install` のあと `sameport setup` を実行してください\n",
    );
  }
}
