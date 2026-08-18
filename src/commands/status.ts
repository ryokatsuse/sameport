import fs from "node:fs";
import { CA_FILE, certExpiry, certNames, mkcertAvailable } from "../cert.js";
import { loadConfig, makePortFilter } from "../config.js";
import { detectOnce } from "../discovery.js";
import { agentInstalled } from "../launchd.js";
import { getDefaultInterface, getLanIp, getSsid } from "../network.js";

export async function status(): Promise<number> {
  const config = loadConfig();
  const iface =
    config.network.interface === "auto" ? await getDefaultInterface() : config.network.interface;
  const ip = iface ? await getLanIp(iface) : null;
  const ssid = iface ? await getSsid(iface) : null;

  process.stdout.write(`ポータル: https://${config.hostname}:${config.portalPort}/\n`);
  process.stdout.write(`ネットワーク: ${ip ?? "(オフライン)"}`);
  if (iface) process.stdout.write(` on ${iface}`);
  if (ssid) process.stdout.write(` (${ssid})`);
  process.stdout.write("\n");

  const expiry = certExpiry();
  if (expiry) {
    const days = Math.floor((expiry.getTime() - Date.now()) / 86_400_000);
    process.stdout.write(
      `証明書: ${expiry.toLocaleDateString("ja-JP")} まで (残り ${days} 日)` +
        ` ${(certNames() ?? []).join(", ")}\n`,
    );
  } else {
    process.stdout.write("証明書: 未発行 (`sameport setup` を実行してください)\n");
  }

  // launchd 配下では PATH が最小で mkcert を呼べないため、CA はコピーを使う
  process.stdout.write(
    `配布用ルート CA: ${fs.existsSync(CA_FILE) ? CA_FILE : "未コピー (`sameport setup` を実行してください)"}\n`,
  );
  if (!(await mkcertAvailable())) {
    process.stdout.write("  ! mkcert が見つかりません (brew install mkcert)\n");
  }

  if (process.platform === "darwin") {
    process.stdout.write(
      `常駐: ${(await agentInstalled()) ? "launchd に登録済み" : "未登録 (`sameport setup`)"}\n`,
    );
  }

  const servers = await detectOnce(makePortFilter(config));
  process.stdout.write(`\n検出中の dev サーバー: ${servers.length} 件\n`);
  for (const s of servers) {
    const via =
      s.boundTo === "wildcard"
        ? `直アクセス（HTTP、--host 付き起動のため proxy 不可）${ip ? ` http://${ip}:${s.port}/` : ""}`
        : `https://${config.hostname}:${s.port}/`;
    process.stdout.write(`  :${s.port}  ${s.command} (pid ${s.pid})  → ${via}\n`);
  }
  return 0;
}
