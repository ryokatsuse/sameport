import fs from "node:fs";
import { HISTORY_FILE, STATE_DIR } from "./paths.js";

export interface HistoryEntry {
  port: number;
  label: string;
  lastSeenAt: number;
}

const MAX_ENTRIES = 20;

export function loadHistory(): HistoryEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    return Array.isArray(raw) ? (raw as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

/** 見えているサーバーを履歴にマージして保存する（ポータルの「直近に見えていたサーバー」用） */
export function recordSeen(servers: { port: number; label: string }[]): void {
  if (servers.length === 0) return;
  const now = Date.now();
  const history = loadHistory();
  for (const s of servers) {
    const existing = history.find((h) => h.port === s.port);
    if (existing) {
      existing.label = s.label || existing.label;
      existing.lastSeenAt = now;
    } else {
      history.push({ port: s.port, label: s.label, lastSeenAt: now });
    }
  }
  history.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(0, MAX_ENTRIES), null, 2) + "\n");
  } catch {
    // 履歴は落としても致命的ではない
  }
}
