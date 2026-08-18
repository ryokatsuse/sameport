import { EventEmitter } from "node:events";
import os from "node:os";
import { run } from "./exec.js";
import type { Logger } from "./logger.js";

/** デフォルトルートのインターフェース名を返す（en0 決め打ちにしない） */
export async function getDefaultInterface(): Promise<string | null> {
  if (process.platform === "darwin") {
    const { stdout } = await run("route", ["-n", "get", "default"]);
    const m = /interface:\s*(\S+)/.exec(stdout);
    return m ? m[1] : null;
  }
  // 開発用フォールバック（Linux）
  const { stdout } = await run("ip", ["route", "show", "default"]);
  const m = /\bdev\s+(\S+)/.exec(stdout);
  return m ? m[1] : null;
}

export async function getLanIp(iface: string): Promise<string | null> {
  if (process.platform === "darwin") {
    const { stdout, code } = await run("ipconfig", ["getifaddr", iface]);
    if (code === 0 && stdout.trim()) return stdout.trim();
  }
  const nets = os.networkInterfaces()[iface];
  const v4 = nets?.find((n) => n.family === "IPv4" && !n.internal);
  return v4?.address ?? null;
}

/** Wi-Fi の SSID（デバッグ表示用、取れなければ null） */
export async function getSsid(iface: string): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const { stdout, code } = await run("networksetup", ["-getairportnetwork", iface]);
  if (code !== 0) return null;
  const m = /Current Wi-Fi Network:\s*(.+)/.exec(stdout);
  return m ? m[1].trim() : null;
}

export interface NetworkState {
  iface: string | null;
  ip: string | null;
}

/**
 * LAN IP の変動（Wi-Fi 切り替え、スリープ復帰、DHCP リース更新）をポーリングで監視し、
 * 変化時に "change"（NetworkState）を発火する。
 */
export class NetworkWatcher extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private state: NetworkState = { iface: null, ip: null };
  private polling = false;

  constructor(
    private opts: { intervalMs: number; interface: string; log: Logger },
  ) {
    super();
  }

  current(): NetworkState {
    return this.state;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.opts.intervalMs);
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const iface =
        this.opts.interface === "auto"
          ? await getDefaultInterface()
          : this.opts.interface;
      const ip = iface ? await getLanIp(iface) : null;
      if (ip !== this.state.ip || iface !== this.state.iface) {
        this.state = { iface, ip };
        this.emit("change", this.state);
      }
    } catch (err) {
      this.opts.log.warn(`network: IP の取得に失敗しました: ${String(err)}`);
    } finally {
      this.polling = false;
    }
  }
}
