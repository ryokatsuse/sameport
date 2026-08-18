import fs from "node:fs";
import { CONFIG_DIR, CONFIG_FILE } from "./paths.js";

export interface PortsConfig {
  mode: "auto" | "manual";
  allow: number[];
  deny: number[];
}

export interface PinnedEntry {
  port: number;
  label: string;
}

export interface Config {
  hostname: string;
  portalPort: number;
  ports: PortsConfig;
  discovery: { intervalMs: number; graceMs: number };
  network: { interface: string; intervalMs: number };
  pinned: PinnedEntry[];
  /** setup で LocalHostName を変更した場合の変更前の値（uninstall で復元する） */
  previousLocalHostName?: string | null;
}

export const DEFAULT_CONFIG: Config = {
  hostname: "dev.local",
  portalPort: 8443,
  ports: {
    mode: "auto",
    allow: [],
    // 既知の非 dev ポート: PostgreSQL, Redis, MySQL, MongoDB, AirPlay(7000), macOS AirPlay Receiver(5000)
    deny: [5432, 6379, 3306, 27017, 7000, 5000],
  },
  discovery: { intervalMs: 2000, graceMs: 5000 },
  network: { interface: "auto", intervalMs: 5000 },
  pinned: [],
};

export function mergeConfig(partial: Partial<Config> | undefined): Config {
  const p = partial ?? {};
  return {
    ...DEFAULT_CONFIG,
    ...p,
    ports: { ...DEFAULT_CONFIG.ports, ...(p.ports ?? {}) },
    discovery: { ...DEFAULT_CONFIG.discovery, ...(p.discovery ?? {}) },
    network: { ...DEFAULT_CONFIG.network, ...(p.network ?? {}) },
    pinned: p.pinned ?? [],
  };
}

export function loadConfig(): Config {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    return mergeConfig(JSON.parse(raw) as Partial<Config>);
  } catch {
    return mergeConfig(undefined);
  }
}

export function saveConfig(config: Config): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
}

/**
 * discovery が proxy 対象にしてよいポートかどうかの判定を作る。
 * - ポータル自身のポートは常に除外
 * - manual モードは allow のみ
 * - auto モードは deny を除外（allow は deny より優先）
 */
export function makePortFilter(config: Config): (port: number) => boolean {
  const allow = new Set(config.ports.allow);
  const deny = new Set(config.ports.deny);
  return (port: number): boolean => {
    if (port === config.portalPort) return false;
    if (config.ports.mode === "manual") return allow.has(port);
    if (allow.has(port)) return true;
    return !deny.has(port);
  };
}
