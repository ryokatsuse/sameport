import path from "node:path";
import { certExpiry, loadTls, readRootCA, renewIfExpiring } from "./cert.js";
import { BootstrapServer } from "./bootstrap.js";
import type { Config } from "./config.js";
import { makePortFilter } from "./config.js";
import { DiscoveryService, type DetectedServer } from "./discovery.js";
import { loadHistory, recordSeen } from "./history.js";
import type { Logger } from "./logger.js";
import { NetworkWatcher, getSsid } from "./network.js";
import { Portal, type PortalServerView, type PortalState } from "./portal.js";
import { ProxyManager } from "./proxy.js";

/** cwd の basename をプロジェクト名として使う。取れなければプロセス名 */
export function labelFor(server: DetectedServer): string {
  const base = server.cwd ? path.basename(server.cwd) : "";
  return base || server.command;
}

export interface Supervisor {
  stop(): void;
}

/**
 * discovery / proxy-manager / network-watcher / portal を配線して常駐させる。
 * ネットワーク未接続の起動直後でもクラッシュせず待機する（§4.8）。
 */
export async function startSupervisor(config: Config, log: Logger): Promise<Supervisor> {
  const tls = loadTls();
  if (!tls) {
    throw new Error(
      "証明書が見つかりません。先に `sameport setup`（または `sameport cert --renew`）を実行してください",
    );
  }
  await renewIfExpiring(config.hostname, log);

  const hmrWarnings = new Set<number>();
  let ssid: string | null = null;

  const proxies = new ProxyManager({
    tls,
    hostname: config.hostname,
    graceMs: config.discovery.graceMs,
    log,
    onWsFailure: (port) => {
      if (hmrWarnings.has(port)) return;
      hmrWarnings.add(port);
      portal.broadcast();
    },
  });

  const discovery = new DiscoveryService({
    intervalMs: config.discovery.intervalMs,
    isPortAllowed: makePortFilter(config),
    selfPid: process.pid,
    log,
  });

  const network = new NetworkWatcher({
    intervalMs: config.network.intervalMs,
    interface: config.network.interface,
    log,
  });

  function buildState(): PortalState {
    const { ip, iface } = network.current();
    const servers: PortalServerView[] = discovery.servers().map((s) => ({
      port: s.port,
      label: labelFor(s),
      command: s.command,
      boundTo: s.boundTo,
      hmrWarning: hmrWarnings.has(s.port),
      url:
        // wildcard バインドのサーバーは proxy を張れないので HTTP で直接続させる（§3 注意書き）
        s.boundTo === "wildcard"
          ? ip
            ? `http://${ip}:${s.port}/`
            : "#"
          : `https://${config.hostname}:${s.port}/`,
    }));
    const expiry = certExpiry();
    return {
      hostname: config.hostname,
      portalPort: config.portalPort,
      // 証明書の案内は平文 HTTP 側へ誘導する。IP が取れないうちはホスト名で出す
      bootstrapUrl: `http://${ip ?? config.hostname}:${config.bootstrapPort}/`,
      lanIp: ip,
      iface,
      ssid,
      online: ip !== null,
      servers,
      pinned: config.pinned,
      history: loadHistory(),
      certExpiresAt: expiry ? expiry.toISOString() : null,
    };
  }

  const portal = new Portal({
    tls,
    getState: buildState,
    log,
  });

  const bootstrap = new BootstrapServer({
    getCaPem: readRootCA,
    hostname: config.hostname,
    getPortalUrl: () => `https://${config.hostname}:${config.portalPort}/`,
    log,
  });

  discovery.on("change", (servers: DetectedServer[]) => {
    for (const port of [...hmrWarnings]) {
      if (!servers.some((s) => s.port === port)) hmrWarnings.delete(port);
    }
    proxies.update(servers);
    recordSeen(servers.map((s) => ({ port: s.port, label: labelFor(s) })));
    portal.broadcast();
  });

  network.on("change", async ({ ip, iface }: { ip: string | null; iface: string | null }) => {
    ssid = iface ? await getSsid(iface) : null;
    proxies.setLanIp(ip);
    if (ip) proxies.update(discovery.servers());
    portal.broadcast();
  });

  portal.start(config.portalPort);
  bootstrap.start(config.bootstrapPort);
  network.start();
  discovery.start();

  log.info(`sameport 起動。ポータル: https://${config.hostname}:${config.portalPort}/`);

  return {
    stop() {
      discovery.stop();
      network.stop();
      proxies.closeAll();
      portal.stop();
      bootstrap.stop();
    },
  };
}
