import { certNames, defaultSans, issueCert, mkcertAvailable } from "../cert.js";
import { loadConfig } from "../config.js";
import { getDefaultInterface, getLanIp } from "../network.js";

export interface CertOptions {
  renew: boolean;
  addIp: boolean;
}

export async function cert(opts: CertOptions): Promise<number> {
  const config = loadConfig();
  if (!(await mkcertAvailable())) {
    process.stderr.write("mkcert が見つかりません: brew install mkcert\n");
    return 1;
  }

  const names = new Set(certNames() ?? defaultSans(config.hostname));

  if (opts.addIp) {
    const iface =
      config.network.interface === "auto"
        ? await getDefaultInterface()
        : config.network.interface;
    const ip = iface ? await getLanIp(iface) : null;
    if (!ip) {
      process.stderr.write("LAN IP を取得できませんでした\n");
      return 1;
    }
    names.add(ip);
    process.stdout.write(`SAN に ${ip} を追加します（IP は変わるので恒久的ではありません）\n`);
  }

  if (!opts.renew && !opts.addIp) {
    process.stderr.write("使い方: sameport cert --renew | sameport cert --add-ip\n");
    return 1;
  }

  if (!(await issueCert([...names]))) {
    process.stderr.write("証明書の発行に失敗しました\n");
    return 1;
  }
  process.stdout.write(`✓ 証明書を再発行しました (${[...names].join(", ")})\n`);
  process.stdout.write("反映するには sameport を再起動してください:\n");
  process.stdout.write("    launchctl kickstart -k gui/$(id -u)/dev.sameport\n");
  return 0;
}
