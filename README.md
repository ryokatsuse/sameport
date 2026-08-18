# sameport

Mac のローカル開発サーバーを、iPhone 実機から **固定 URL + HTTPS** で常時開けるようにする常駐ツールです。

```
Mac:     npm run dev        （いつもどおり。--host も設定変更も不要）
iPhone:  https://dev.local:8443   （このブックマーク 1 つだけ）
```

## 何が変わるか

これまで実機確認のたびにやっていたこと:

1. `ipconfig getifaddr en0` で IP を調べる
2. dev サーバーを `--host` 付きで起動し直す
3. iPhone で `http://192.168.x.x:5173` を手打ちする
4. DHCP で IP が変わってブックマークが死ぬ
5. Service Worker / カメラ / Clipboard が secure context ではないので動かない

sameport を入れると、Mac 側は普段どおり `npm run dev` するだけ、iPhone 側はポータルをブックマークしておくだけになります。

## 仕組み

```
┌───────────────────────── Mac ─────────────────────────┐
│  vite      127.0.0.1:5173 ─┐                          │
│  next dev  127.0.0.1:3000 ─┤ (http, 平文, ループバック)  │
│  storybook 127.0.0.1:6006 ─┤                          │
│                            ▼                          │
│                    ┌──────────────┐                   │
│                    │   sameport   │ ポート探索/TLS 終端  │
│                    └──────────────┘ リバプロ/ポータル   │
│      192.168.x.x:5173 (TLS) ┤                         │
│      192.168.x.x:8443 (TLS) ┘ ← ポータル（固定）        │
└─────────────────────────────┼─────────────────────────┘
                              ▼  同一 LAN
                    https://dev.local:8443
```

キモは **LAN IP にだけバインドすること**です。dev サーバーは `127.0.0.1:5173` を掴んでいるので、
sameport が `192.168.x.x:5173` にバインドしてもアドレスが違うため衝突しません。
結果として Mac 側 `http://localhost:5173` と iPhone 側 `https://dev.local:5173` で
**ポート番号が一致**し、変換表を覚える必要がなくなります。

名前 `sameport` はここから来ています。

## 必要なもの

- macOS
- Node.js 20 以上
- [mkcert](https://github.com/FiloSottile/mkcert)（`brew install mkcert`）

## セットアップ

```bash
git clone https://github.com/ryokatsuse/sameport.git
cd sameport
npm install && npm run build
npm link            # sameport コマンドを使えるようにする

sameport setup
```

`sameport setup` は次を行います。

1. mkcert の存在確認（自動インストールはしません）
2. `mkcert -install` でローカル CA を Mac のキーチェーンに登録
3. `dev.local` / `*.dev.local` / `localhost` / `127.0.0.1` / `::1` のサーバー証明書を発行
4. Mac の LocalHostName を `dev` に変更（**確認プロンプトあり・sudo が必要**）
   → mDNS が `dev.local` を広告するようになり、IP が変わっても追随します
5. launchd に登録（ログイン時に自動起動）
6. 証明書インストール用ページ（平文 HTTP）の QR と iPhone 側の手順を表示

### iPhone 側（1 回だけ）

1. `sameport setup`（または `sameport qr --setup`）の QR をカメラで読み取り、**Safari で**開く
   これは平文 HTTP のセットアップページなので証明書エラーは出ません
2. 「ルート証明書をインストール」をタップ →「許可」→「閉じる」
3. 設定 → 一般 → VPN とデバイス管理 → ダウンロード済みプロファイル → インストール
4. **設定 → 一般 → 情報 → 証明書信頼設定 → sameport / mkcert のトグルを ON**
   ← ここを飛ばすと動きません。最頻出のハマりどころです
5. セットアップページの「ポータルを開く」でポータルへ移動し、ホーム画面に追加

証明書のインストールは必ず **Safari** で行ってください。Chrome など他のブラウザでは
プロファイルのダウンロードに失敗します。

#### なぜ証明書の配布だけ平文 HTTP なのか

ポータルは mkcert の証明書で HTTPS 配信していますが、その証明書を信頼させる前に
そこからルート CA を配ろうとすると、iOS は「プロファイルをダウンロードできませんでした」で
失敗します。ページ自体は「このまま進む」で開けても、プロファイルの取得は別経路で
TLS 検証されるためです。この鶏と卵を避けるため、CA の配布だけは平文 HTTP の
別ポート（デフォルト 8480）で行います。配るのは公開鍵であるルート CA 証明書だけで、
秘密鍵は一切ネットワークに出ません。

証明書は iOS が扱いやすい構成プロファイル（`.mobileconfig`）に包んで
`application/x-apple-aspen-config` で返しています。生の `.pem` を直接配ると
iOS 15 以降は失敗しがちです。

## コマンド

```
sameport setup          初回セットアップ
sameport start          フォアグラウンド起動（デバッグ用）
sameport status         検出中サーバー、IP、証明書有効期限を表示
sameport qr             ポータル URL の QR をターミナルに表示
sameport qr --setup     証明書インストール用ページの QR を表示（初回・平文 HTTP）
sameport cert --renew   証明書を再発行
sameport cert --add-ip  現在の LAN IP を SAN に追加して再発行（IP 直打ちしたいとき）
sameport logs [-f]      ログを表示
sameport uninstall      launchd 解除、ホスト名復元、証明書削除
```

## ポータル

`https://dev.local:8443` に常駐する固定の入口ページです。**iPhone がブックマークするのはこれだけ。**

- 検出中の dev サーバー一覧（ポート / プロジェクト名 / プロセス名）をタップで開ける
- SSE で自動更新。Mac で `npm run dev` すると数秒で一覧に出ます
- 何も起動していないときは直近に見えていたサーバーの履歴を表示
- 証明書セットアップページ（平文 HTTP）への導線
- 現在の LAN IP / インターフェース / SSID（デバッグ用）
- ダークモード対応。一覧は `<ul>` + リンクで、更新は件数のみ `aria-live` で通知します

## 設定ファイル

`~/.config/sameport/config.json`

```jsonc
{
  "hostname": "dev.local",
  "portalPort": 8443,
  "bootstrapPort": 8480,      // ルート CA を配る平文 HTTP のポート
  "ports": {
    "mode": "auto",           // "auto" | "manual"
    "allow": [],              // manual 時、あるいは auto の追加許可（deny より優先）
    "deny": [5432, 6379, 3306, 27017, 7000, 5000]
  },
  "discovery": { "intervalMs": 2000, "graceMs": 5000 },
  "network": { "interface": "auto", "intervalMs": 5000 },
  "pinned": [
    { "port": 5173, "label": "portfolio" }  // 起動していなくてもポータル上部に出す
  ]
}
```

`graceMs` は dev サーバーが消えてから proxy を畳むまでの猶予です。
再起動のたびに proxy を落として立て直すのを避けるためのもので、この間はブックマークが生きたままになります。

## dev サーバー側の互換性

プロキシ経由でも各プロジェクトの設定を変えなくて済むよう、次の処理を入れています。

- **Host ヘッダ**: upstream には `Host: localhost:<port>` を送ります。
  Vite の `server.allowedHosts` や Next.js の `allowedDevOrigins` による Host 拒否を避けるためです。
- **Origin / Referer**: Host と同じ `http://localhost:<port>` に揃えます。
  Host だけ書き換えて Origin を素通しすると両者が食い違い、Next.js の Server Actions や
  SvelteKit のフォーム POST など、この一致を CSRF 対策として見るフレームワークが POST を拒否します
  （**ログインから先に進めない**、という形で出ます）。
- **Set-Cookie の Domain**: `Domain=localhost` が付いていたら削って host-only クッキーにします。
  そのままだとブラウザが `dev.local` 上でクッキーを保存せず、セッションが維持されません。
- **Location ヘッダ**: upstream が `http://localhost:5173/foo` を返したら `https://dev.local:5173/foo` に書き換えます。
  ボディ内の絶対 URL は書き換えません（HTML 書き換えは副作用が大きいため非対応）。
- **X-Forwarded-Host / -Proto / -For** を付与します。
- **WebSocket**: `upgrade` を生ソケットで中継します。HMR はここを通ります。
- **ALPN は `http/1.1` 固定**。h2 をネゴシエートすると WebSocket の Upgrade が使えなくなるためです。

HMR が繋がらない場合、`server.hmr.clientPort` を明示しているプロジェクトの可能性があります。
その場合はポータルとログに警告を出します（黙って壊れないようにしています）。

`--host` 付きで起動済みの dev サーバー（`0.0.0.0` バインド）はポートが衝突するので proxy をスキップし、
ポータル上に「直アクセス可（HTTP）」と表示します。

## ポート番号が決まっているプロジェクト

ログインや API が特定のポート（例: 5555）でないと通らない、というプロジェクトでも
そのまま動きます。sameport はポート番号を保つので、Mac 側で `localhost:5555` に
立てていれば iPhone からは `https://dev.local:5555` になります。**ポート番号は同じです。**

upstream から見た Host / Origin / Referer はすべて `localhost:5555` に揃えて送るため、
「`localhost:5555` からのアクセスのみ許可」というサーバー側のチェックも通ります。

ただし iPhone のアドレスバーに `localhost:5555` と打つことはできません。
iPhone にとって `localhost` は iPhone 自身を指すためで、これは原理的な制約です。
`dev.local:5555` を使ってください。Mac 側からも同じ `https://dev.local:5555` で開けるので、
両方の端末で URL を揃えられます。

## 制限

- **LAN 内限定**です。LAN 外からのアクセスは Tailscale / cloudflared を使ってください
- **クライアント分離された AP**（社内 Wi-Fi、カフェ）では原理的に届きません
- `.local` は mDNS なので、VPN クライアントによっては名前解決が奪われることがあります
- Mac のファイアウォールが有効だと初回に許可ダイアログが出ます
- Android は設計上動くはずですが検証していません

## 開発

```bash
npm install
npm run build
npm test        # ビルドして node:test を実行
npm run watch
```

テストは実際に loopback でサーバーを立てて、Host 書き換え・Location 書き換え・502・
WebSocket の Upgrade 中継・ポータルの HTTPS/SSE 配信・構成プロファイルの中身と
配布した CA での TLS 検証までを通しで確認します。

環境変数 `SAMEPORT_CONFIG_DIR` / `SAMEPORT_STATE_DIR` で設定・状態の保存先を差し替えられます。

## ライセンス

MIT
