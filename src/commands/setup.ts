import fs from "node:fs";
import {
  certExpiry,
  copyRootCA,
  defaultSans,
  installLocalCA,
  issueCert,
  mkcertAvailable,
  mkcertCARoot,
} from "../cert.js";
import { loadConfig, saveConfig } from "../config.js";
import { getLocalHostName, labelFromHostname, setLocalHostName } from "../hostname.js";
import { installAgent } from "../launchd.js";
import { getDefaultInterface, getLanIp } from "../network.js";
import { printQr } from "../qr.js";
import { confirm } from "../prompt.js";
import { CONFIG_FILE } from "../paths.js";

export interface SetupOptions {
  yes: boolean;
  cliPath: string;
  skipHostname: boolean;
  skipAgent: boolean;
}

function iphoneSteps(portalUrl: string): string {
  return `
iPhone 側の初回セットアップ（1 回だけ）
  1. 上の QR を iPhone のカメラで読み取り、【Safari で】開く
     ここは平文 HTTP のセットアップページなので、証明書エラーは出ません
  2. 「ルート証明書をインストール」をタップ →「許可」→「閉じる」
  3. 設定 → 一般 → VPN とデバイス管理 → ダウンロード済みプロファイル → インストール
  4. 設定 → 一般 → 情報 → 証明書信頼設定 → sameport / mkcert のトグルを ON
     ★ ここを飛ばすと動きません。最頻出のハマりどころです
  5. セットアップページの「ポータルを開く」でポータルへ移動し、ホーム画面に追加
     以降ブックマークするのはこの URL だけです:
       ${portalUrl}

補足
  ・証明書のインストールは必ず Safari で行ってください。Chrome など他のブラウザでは
    プロファイルのダウンロードに失敗します
  ・初回起動時に macOS のファイアウォール許可ダイアログが出ることがあります。許可してください
  ・クライアント分離された Wi-Fi（社内・カフェ）では原理的に届きません
`;
}

export async function setup(opts: SetupOptions): Promise<number> {
  const config = loadConfig();
  process.stdout.write("sameport のセットアップを開始します\n\n");

  // 1. mkcert（自動インストールはしない）
  if (!(await mkcertAvailable())) {
    process.stderr.write(
      "mkcert が見つかりません。先にインストールしてください:\n\n  brew install mkcert\n\n",
    );
    return 1;
  }
  process.stdout.write("✓ mkcert を検出しました\n");

  // 2. ローカル CA をキーチェーンに登録
  if (!(await installLocalCA())) {
    process.stderr.write("mkcert -install に失敗しました\n");
    return 1;
  }
  const caRoot = await mkcertCARoot();
  process.stdout.write(`✓ ローカル CA を登録しました${caRoot ? ` (${caRoot})` : ""}\n`);

  // 常駐プロセスは launchd 配下で PATH が最小限になり mkcert を呼べないので、
  // ここでルート CA を設定ディレクトリにコピーしておく
  const caCopy = await copyRootCA();
  if (caCopy) {
    process.stdout.write(`✓ ルート CA を配布用にコピーしました (${caCopy})\n`);
  } else {
    process.stderr.write(
      "! ルート CA のコピーに失敗しました。iPhone に証明書を配れません。\n" +
        "  `mkcert -install` が成功しているか確認してください\n",
    );
  }

  // 3. サーバー証明書（LAN IP は含めない。名前ベースでのアクセスを正とする）
  const names = defaultSans(config.hostname);
  if (!(await issueCert(names))) {
    process.stderr.write("証明書の発行に失敗しました\n");
    return 1;
  }
  process.stdout.write(`✓ 証明書を発行しました (${names.join(", ")})\n`);

  // 4. ホスト名の固定（案 A: LocalHostName の変更。明示的な同意を取る）
  const label = labelFromHostname(config.hostname);
  const current = await getLocalHostName();
  if (opts.skipHostname) {
    process.stdout.write("- ホスト名の変更はスキップしました (--skip-hostname)\n");
  } else if (current === label) {
    process.stdout.write(`✓ LocalHostName はすでに "${label}" です\n`);
  } else {
    process.stdout.write(
      `\nMac の LocalHostName を "${current ?? "(不明)"}" から "${label}" に変更します。\n` +
        `これで mDNS が ${config.hostname} を広告するようになり、IP が変わっても追随します。\n` +
        "管理者権限 (sudo) が必要です。`sameport uninstall` で元に戻せます。\n",
    );
    if (await confirm("変更してよいですか?", opts.yes)) {
      if (await setLocalHostName(label)) {
        config.previousLocalHostName = current;
        saveConfig(config);
        process.stdout.write(`✓ LocalHostName を "${label}" に変更しました\n`);
      } else {
        process.stderr.write(
          "! LocalHostName の変更に失敗しました。手動で実行してください:\n" +
            `    sudo scutil --set LocalHostName ${label}\n`,
        );
      }
    } else {
      process.stdout.write(
        `- スキップしました。${config.hostname} が引けない場合は手動で設定してください\n`,
      );
    }
  }

  // 5. launchd 登録（ログイン時に自動起動）
  if (opts.skipAgent) {
    process.stdout.write("- launchd 登録はスキップしました (--skip-agent)\n");
  } else if (process.platform === "darwin") {
    await installAgent(process.execPath, opts.cliPath);
    process.stdout.write("✓ launchd に登録しました（ログイン時に自動起動します）\n");
  } else {
    process.stdout.write("- macOS ではないため launchd 登録はスキップしました\n");
  }

  if (!fs.existsSync(CONFIG_FILE)) saveConfig(config);

  const expiry = certExpiry();
  process.stdout.write(
    `\n設定ファイル: ${CONFIG_FILE}\n` +
      (expiry ? `証明書の有効期限: ${expiry.toLocaleDateString("ja-JP")}\n` : ""),
  );

  // 初回の QR は「証明書配布ページ」を指す。ポータル(HTTPS)は証明書を信頼させるまで
  // iPhone がプロファイルを取得できないため、入口を平文 HTTP 側にする。
  // ホスト名解決もまだ確認できていない段階なので、確実な LAN IP を使う
  const iface =
    config.network.interface === "auto" ? await getDefaultInterface() : config.network.interface;
  const ip = iface ? await getLanIp(iface) : null;
  const host = ip ?? config.hostname;
  await printQr(`http://${host}:${config.bootstrapPort}/`);
  process.stdout.write(iphoneSteps(`https://${config.hostname}:${config.portalPort}/`));
  if (!ip) {
    process.stdout.write(
      "\n! LAN IP を取得できなかったため QR はホスト名で生成しました。" +
        "ネットワーク接続後に `sameport qr --setup` で取り直せます\n",
    );
  }
  return 0;
}
