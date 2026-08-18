import { createRequire } from "node:module";

interface QrcodeTerminal {
  generate(text: string, options: { small?: boolean }, callback: (qr: string) => void): void;
}

/** ポータル URL の QR をターミナルに表示する */
export async function printQr(url: string): Promise<void> {
  try {
    // qrcode-terminal は CJS。ESM から読むと名前付き export が生えないので default を取る
    const require = createRequire(import.meta.url);
    const qrcode = require("qrcode-terminal") as QrcodeTerminal;
    await new Promise<void>((resolve) => {
      qrcode.generate(url, { small: true }, (art: string) => {
        process.stdout.write("\n" + art + "\n");
        resolve();
      });
    });
  } catch (err) {
    process.stdout.write(
      `\n(QR を生成できませんでした: ${String(err instanceof Error ? err.message : err)})\n` +
        "URL を手入力してください。\n",
    );
  }
  process.stdout.write(`  ${url}\n\n`);
}
