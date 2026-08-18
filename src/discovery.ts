import { EventEmitter } from "node:events";
import { run } from "./exec.js";
import type { Logger } from "./logger.js";

export type BoundTo = "loopback" | "wildcard";

export interface DetectedServer {
  port: number;
  pid: number;
  command: string; // "node", "bun" など
  cwd: string; // プロジェクトディレクトリ（表示用）
  boundTo: BoundTo;
  firstSeenAt: number;
}

export interface ListenRecord {
  pid: number;
  command: string;
  addr: string;
  port: number;
}

/**
 * `lsof -nP -iTCP -sTCP:LISTEN -F pcn` の機械可読出力をパースする。
 * 出力はプロセスごとに p<pid> / c<command>、続いて listen 中の名前が n<addr>:<port> で並ぶ。
 */
export function parseLsofListeners(output: string): ListenRecord[] {
  const records: ListenRecord[] = [];
  let pid = -1;
  let command = "";
  for (const line of output.split("\n")) {
    if (line.length === 0) continue;
    const tag = line[0];
    const rest = line.slice(1);
    if (tag === "p") {
      pid = Number(rest);
      command = "";
    } else if (tag === "c") {
      command = rest;
    } else if (tag === "n") {
      const m = /^(.*):(\d+)$/.exec(rest);
      if (!m || pid < 0) continue;
      records.push({ pid, command, addr: m[1], port: Number(m[2]) });
    }
  }
  return records;
}

/** loopback 以外（*, 0.0.0.0, [::], 特定 IP バインド）はすべて「直アクセス扱い」= wildcard に寄せる */
export function classifyAddr(addr: string): BoundTo {
  const a = addr.toLowerCase();
  if (a === "localhost" || a === "[::1]" || a.startsWith("127.")) return "loopback";
  return "wildcard";
}

export interface GroupedListener {
  port: number;
  pid: number;
  command: string;
  boundTo: BoundTo;
}

/**
 * 同一ポートの複数レコード（IPv4/IPv6 など）を 1 つにまとめる。
 * loopback と wildcard が混在する場合は wildcard 優先（= LAN IP バインドが衝突するため proxy 不可）。
 */
export function groupByPort(records: ListenRecord[]): GroupedListener[] {
  const map = new Map<number, GroupedListener>();
  for (const r of records) {
    const boundTo = classifyAddr(r.addr);
    const existing = map.get(r.port);
    if (!existing) {
      map.set(r.port, { port: r.port, pid: r.pid, command: r.command, boundTo });
    } else if (existing.boundTo === "loopback" && boundTo === "wildcard") {
      existing.boundTo = "wildcard";
    }
  }
  return [...map.values()];
}

export interface DiscoveryOptions {
  intervalMs: number;
  isPortAllowed: (port: number) => boolean;
  selfPid: number;
  log: Logger;
}

/**
 * 起動中の dev サーバーを lsof ポーリングで見つける。
 * 変化があったときだけ "change" イベント（DetectedServer[]）を発火する。
 */
export class DiscoveryService extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private known = new Map<number, DetectedServer>();
  private cwdCache = new Map<number, string>();
  private polling = false;

  constructor(private opts: DiscoveryOptions) {
    super();
  }

  servers(): DetectedServer[] {
    return [...this.known.values()].sort((a, b) => a.port - b.port);
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
      // lsof は該当なしのとき exit 1 を返すので code は見ない
      const { stdout } = await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"]);
      const records = parseLsofListeners(stdout).filter(
        (r) =>
          r.pid !== this.opts.selfPid &&
          r.port >= 1024 &&
          r.port <= 65535 &&
          this.opts.isPortAllowed(r.port),
      );
      const next = new Map<number, DetectedServer>();
      let mutated = false;
      for (const g of groupByPort(records)) {
        const prev = this.known.get(g.port);
        if (prev && prev.pid === g.pid) {
          if (prev.boundTo !== g.boundTo) {
            prev.boundTo = g.boundTo;
            mutated = true;
          }
          next.set(g.port, prev);
          continue;
        }
        next.set(g.port, {
          port: g.port,
          pid: g.pid,
          command: g.command,
          cwd: await this.cwdOf(g.pid),
          boundTo: g.boundTo,
          firstSeenAt: Date.now(),
        });
      }
      const added = [...next.keys()].some((p) => !this.known.has(p));
      const removed = [...this.known.keys()].some((p) => !next.has(p));
      this.known = next;
      if (added || removed || mutated) this.emit("change", this.servers());
    } catch (err) {
      this.opts.log.warn(`discovery: lsof の実行に失敗しました: ${String(err)}`);
    } finally {
      this.polling = false;
    }
  }

  private async cwdOf(pid: number): Promise<string> {
    const cached = this.cwdCache.get(pid);
    if (cached !== undefined) return cached;
    const { stdout } = await run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-F", "n"]);
    const line = stdout.split("\n").find((l) => l.startsWith("n"));
    const cwd = line ? line.slice(1) : "";
    if (this.cwdCache.size > 256) this.cwdCache.clear();
    this.cwdCache.set(pid, cwd);
    return cwd;
  }
}

/** status コマンド用の一回きりの検出 */
export async function detectOnce(
  isPortAllowed: (port: number) => boolean,
): Promise<GroupedListener[]> {
  const { stdout } = await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"]);
  return groupByPort(
    parseLsofListeners(stdout).filter(
      (r) => r.port >= 1024 && r.port <= 65535 && isPortAllowed(r.port),
    ),
  ).sort((a, b) => a.port - b.port);
}
