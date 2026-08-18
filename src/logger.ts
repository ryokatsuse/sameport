import fs from "node:fs";
import { LOG_FILE, STATE_DIR } from "./paths.js";

const MAX_LOG_BYTES = 5 * 1024 * 1024;

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export const nullLogger: Logger = { info() {}, warn() {}, error() {} };

export function createLogger(opts: { console?: boolean } = {}): Logger {
  const toConsole = opts.console ?? true;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  } catch {
    // 書けなくても動作は続ける
  }

  function rotateIfNeeded(): void {
    try {
      const st = fs.statSync(LOG_FILE);
      if (st.size > MAX_LOG_BYTES) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    } catch {
      // ファイル未作成
    }
  }

  function write(level: "info" | "warn" | "error", msg: string): void {
    const line = `${new Date().toISOString()} [${level}] ${msg}\n`;
    try {
      rotateIfNeeded();
      fs.appendFileSync(LOG_FILE, line);
    } catch {
      // ログ書き込み失敗で本体を止めない
    }
    if (toConsole) {
      (level === "error" ? process.stderr : process.stdout).write(line);
    }
  }

  return {
    info: (msg) => write("info", msg),
    warn: (msg) => write("warn", msg),
    error: (msg) => write("error", msg),
  };
}
