#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { cert } from "./commands/cert.js";
import { logs } from "./commands/logs.js";
import { setup } from "./commands/setup.js";
import { status } from "./commands/status.js";
import { uninstall } from "./commands/uninstall.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { printQr } from "./qr.js";
import { startSupervisor } from "./supervisor.js";

const USAGE = `sameport — ローカル開発サーバーを実機から固定 URL + HTTPS で開く

使い方:
  sameport setup          初回セットアップ（mkcert / ホスト名 / launchd 登録 / QR 表示）
  sameport start          フォアグラウンド起動（デバッグ用）
  sameport status         検出中サーバー、IP、証明書有効期限を表示
  sameport qr             ポータル URL の QR をターミナルに表示
  sameport cert --renew   証明書を再発行
  sameport cert --add-ip  現在の LAN IP を SAN に追加して再発行
  sameport logs [-f]      ログを表示
  sameport uninstall      launchd 解除、ホスト名復元、証明書削除

オプション:
  -y, --yes               確認プロンプトにすべて yes で答える
  -h, --help              このヘルプを表示
`;

async function start(): Promise<number> {
  const log = createLogger({ console: true });
  const config = loadConfig();
  let supervisor: { stop(): void } | null = null;

  // ネットワーク未接続や upstream 切断で落ちないようにする（§4.8）
  process.on("uncaughtException", (err) => log.error(`uncaught: ${String(err)}`));
  process.on("unhandledRejection", (err) => log.error(`unhandled: ${String(err)}`));

  try {
    supervisor = await startSupervisor(config, log);
  } catch (err) {
    log.error(String(err instanceof Error ? err.message : err));
    return 1;
  }

  return new Promise((resolve) => {
    const shutdown = (signal: string): void => {
      log.info(`${signal} を受信しました。終了します`);
      supervisor?.stop();
      resolve(0);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  });
}

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  const command = args.find((a) => !a.startsWith("-")) ?? "help";
  const has = (...flags: string[]): boolean => flags.some((f) => args.includes(f));

  if (has("-h", "--help") && command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  switch (command) {
    case "setup":
      return setup({
        yes: has("-y", "--yes"),
        cliPath: fileURLToPath(import.meta.url),
        skipHostname: has("--skip-hostname"),
        skipAgent: has("--skip-agent"),
      });
    case "start":
      return start();
    case "status":
      return status();
    case "qr": {
      const config = loadConfig();
      await printQr(`https://${config.hostname}:${config.portalPort}/`);
      return 0;
    }
    case "cert":
      return cert({ renew: has("--renew"), addIp: has("--add-ip") });
    case "logs":
      return logs(has("-f", "--follow"));
    case "uninstall":
      return uninstall({ yes: has("-y", "--yes") });
    case "help":
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`不明なコマンド: ${command}\n\n${USAGE}`);
      return 1;
  }
}

main(process.argv).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`${String(err instanceof Error ? err.stack : err)}\n`);
    process.exitCode = 1;
  },
);
