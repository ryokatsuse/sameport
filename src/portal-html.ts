/**
 * ポータルページ。依存ゼロの単一 HTML（§4.6）。
 * - SSE(/events) で自動更新、失敗時は /api/servers のポーリングにフォールバック
 * - prefers-color-scheme 対応
 * - 一覧は <ul> + リンク、件数変化のみ aria-live="polite" で通知
 */
export const PORTAL_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>sameport</title>
<style>
  :root {
    --bg: #f6f7f9; --card: #ffffff; --fg: #1c1e21; --muted: #667085;
    --accent: #2563eb; --border: #e4e7ec; --warn-bg: #fef3c7; --warn-fg: #92400e;
    color-scheme: light dark;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #101214; --card: #1a1d21; --fg: #e6e8ea; --muted: #98a2b3;
      --accent: #7aa2ff; --border: #2a2f36; --warn-bg: #3a2e10; --warn-fg: #fbbf24;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 16px; background: var(--bg); color: var(--fg);
    font-family: system-ui, -apple-system, "Hiragino Sans", sans-serif;
    max-width: 640px; margin-inline: auto;
  }
  h1 { font-size: 1.25rem; margin: 0; }
  h2 { font-size: 0.85rem; color: var(--muted); font-weight: 600; margin: 24px 0 8px; }
  header { display: flex; align-items: center; gap: 8px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: #22c55e; flex: none; }
  .dot.offline { background: #ef4444; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
  li a {
    display: block; padding: 14px 16px; border-radius: 12px;
    background: var(--card); border: 1px solid var(--border);
    color: inherit; text-decoration: none;
  }
  li a:active { opacity: 0.7; }
  .name { font-weight: 600; }
  code {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    color: var(--accent); margin-left: 6px;
  }
  .meta { display: block; color: var(--muted); font-size: 0.8rem; margin-top: 4px; }
  .badge {
    font-size: 0.7rem; padding: 2px 8px; border-radius: 999px;
    background: var(--warn-bg); color: var(--warn-fg); margin-left: 8px;
  }
  .notice {
    padding: 12px 16px; border-radius: 12px; background: var(--warn-bg);
    color: var(--warn-fg); font-size: 0.85rem; margin: 12px 0;
  }
  .empty { color: var(--muted); font-size: 0.9rem; padding: 8px 0; }
  section.cert p { font-size: 0.85rem; color: var(--muted); line-height: 1.7; }
  section.cert a { color: var(--accent); }
  footer { margin-top: 32px; font-size: 0.75rem; color: var(--muted); }
  .visually-hidden {
    position: absolute; width: 1px; height: 1px; margin: -1px;
    clip-path: inset(50%); overflow: hidden; white-space: nowrap;
  }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<header>
  <span id="dot" class="dot" aria-hidden="true"></span>
  <h1>sameport</h1>
</header>
<p id="live" class="visually-hidden" aria-live="polite"></p>
<div id="offline" class="notice" hidden>
  Mac がオフラインです（LAN IP を取得できません）。Wi-Fi 接続を確認してください。
</div>
<main>
  <section>
    <h2>起動中の dev サーバー</h2>
    <ul id="servers"></ul>
    <p id="empty" class="empty" hidden>
      いま起動している dev サーバーはありません。Mac 側で <code>npm run dev</code> すると数秒でここに出ます。
    </p>
  </section>
  <section id="pinned-section" hidden>
    <h2>ピン留め</h2>
    <ul id="pinned"></ul>
  </section>
  <section id="history-section" hidden>
    <h2>直近に見えていたサーバー</h2>
    <ul id="history"></ul>
  </section>
  <section class="cert">
    <h2>証明書</h2>
    <p>
      ページが「安全ではありません」と表示される場合は、
      <a href="/rootCA.pem" download="rootCA.pem">ルート証明書をインストール</a>
      したあと、iPhone の 設定 → 一般 → VPN とデバイス管理 でプロファイルをインストールし、さらに
      <strong>設定 → 一般 → 情報 → 証明書信頼設定 → mkcert のトグルを ON</strong>
      にしてください（ここを飛ばすと動きません）。
    </p>
    <p id="cert-expiry"></p>
  </section>
</main>
<footer id="debug"></footer>
<script>
(function () {
  "use strict";
  var lastCount = -1;

  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      if (k === "text") node.textContent = props[k];
      else node.setAttribute(k, props[k]);
    });
    (children || []).forEach(function (c) { node.appendChild(c); });
    return node;
  }

  function serverItem(s, state) {
    var a = el("a", { href: s.url || "#", "aria-label": "ポート " + s.port + "、" + (s.label || s.command) });
    a.appendChild(el("span", { "class": "name", text: s.label || s.command }));
    a.appendChild(el("code", { "aria-hidden": "true", text: ":" + s.port }));
    if (s.boundTo === "wildcard") a.appendChild(el("span", { "class": "badge", text: "直アクセス可（HTTP）" }));
    var meta = s.command;
    if (s.hmrWarning) meta += " ・ HMR が繋がらない可能性（server.hmr の設定を確認）";
    a.appendChild(el("span", { "class": "meta", text: meta }));
    return el("li", null, [a]);
  }

  function simpleItem(label, port, url) {
    var a = el("a", { href: url, "aria-label": "ポート " + port + "、" + label });
    a.appendChild(el("span", { "class": "name", text: label }));
    a.appendChild(el("code", { "aria-hidden": "true", text: ":" + port }));
    return el("li", null, [a]);
  }

  function render(state) {
    document.getElementById("dot").className = state.online ? "dot" : "dot offline";
    document.getElementById("offline").hidden = state.online;

    var servers = document.getElementById("servers");
    servers.replaceChildren();
    state.servers.forEach(function (s) { servers.appendChild(serverItem(s, state)); });
    document.getElementById("empty").hidden = state.servers.length > 0;

    var pinnedSection = document.getElementById("pinned-section");
    var pinned = document.getElementById("pinned");
    pinned.replaceChildren();
    (state.pinned || []).forEach(function (p) {
      pinned.appendChild(simpleItem(p.label, p.port, "https://" + state.hostname + ":" + p.port + "/"));
    });
    pinnedSection.hidden = !state.pinned || state.pinned.length === 0;

    var runningPorts = state.servers.map(function (s) { return s.port; });
    var historyEntries = (state.history || []).filter(function (h) {
      return runningPorts.indexOf(h.port) === -1;
    }).slice(0, 5);
    var historySection = document.getElementById("history-section");
    var history = document.getElementById("history");
    history.replaceChildren();
    historyEntries.forEach(function (h) {
      history.appendChild(simpleItem(h.label || ("ポート " + h.port), h.port, "https://" + state.hostname + ":" + h.port + "/"));
    });
    historySection.hidden = state.servers.length > 0 || historyEntries.length === 0;

    if (state.certExpiresAt) {
      document.getElementById("cert-expiry").textContent =
        "サーバー証明書の有効期限: " + new Date(state.certExpiresAt).toLocaleDateString("ja-JP");
    }

    var debug = [];
    if (state.lanIp) debug.push("IP: " + state.lanIp);
    if (state.iface) debug.push("IF: " + state.iface);
    if (state.ssid) debug.push("SSID: " + state.ssid);
    document.getElementById("debug").textContent = debug.join(" / ");

    if (state.servers.length !== lastCount) {
      lastCount = state.servers.length;
      document.getElementById("live").textContent = lastCount + " 件のサーバーを検出";
    }
  }

  function fetchState() {
    fetch("/api/servers").then(function (r) { return r.json(); }).then(render).catch(function () {});
  }

  try {
    var es = new EventSource("/events");
    es.addEventListener("state", function (e) { render(JSON.parse(e.data)); });
  } catch (err) { /* SSE 不可なら下のポーリングだけで動く */ }
  setInterval(fetchState, 10000);
  fetchState();
})();
</script>
</body>
</html>
`;
