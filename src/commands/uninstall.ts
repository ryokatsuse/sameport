import fs from "node:fs";
import { CERTS_DIR } from "../paths.js";
import { loadConfig, saveConfig } from "../config.js";
import { getLocalHostName, setLocalHostName } from "../hostname.js";
import { uninstallAgent } from "../launchd.js";
import { confirm } from "../prompt.js";

export async function uninstall(opts: { yes: boolean }): Promise<number> {
  const config = loadConfig();

  await uninstallAgent();
  process.stdout.write("✓ launchd の登録を解除しました\n");

  const previous = config.previousLocalHostName;
  if (previous) {
    const current = await getLocalHostName();
    process.stdout.write(
      `LocalHostName を "${current ?? "(不明)"}" から "${previous}" に戻します（sudo が必要）。\n`,
    );
    if (await confirm("戻しますか?", opts.yes)) {
      if (await setLocalHostName(previous)) {
        config.previousLocalHostName = null;
        saveConfig(config);
        process.stdout.write(`✓ LocalHostName を "${previous}" に戻しました\n`);
      } else {
        process.stderr.write(
          `! 失敗しました。手動で実行してください: sudo scutil --set LocalHostName ${previous}\n`,
        );
      }
    }
  }

  if (await confirm(`証明書 (${CERTS_DIR}) を削除しますか?`, opts.yes)) {
    fs.rmSync(CERTS_DIR, { recursive: true, force: true });
    process.stdout.write("✓ 証明書を削除しました\n");
  }

  process.stdout.write(
    "\nmkcert のローカル CA は残っています。完全に削除する場合は `mkcert -uninstall` を実行してください。\n" +
      "iPhone 側のプロファイルは 設定 → 一般 → VPN とデバイス管理 から削除できます。\n",
  );
  return 0;
}
