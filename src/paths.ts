import os from "node:os";
import path from "node:path";

// SAMEPORT_CONFIG_DIR / SAMEPORT_STATE_DIR はテスト・デバッグ用の上書き
export const CONFIG_DIR =
  process.env.SAMEPORT_CONFIG_DIR ?? path.join(os.homedir(), ".config", "sameport");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
export const CERTS_DIR = path.join(CONFIG_DIR, "certs");

export const STATE_DIR =
  process.env.SAMEPORT_STATE_DIR ?? path.join(os.homedir(), ".local", "state", "sameport");
export const HISTORY_FILE = path.join(STATE_DIR, "history.json");
export const LOG_FILE = path.join(STATE_DIR, "out.log");
