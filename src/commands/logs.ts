import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { LOG_FILE, STATE_DIR } from "../paths.js";

export async function logs(follow: boolean): Promise<number> {
  const files = [LOG_FILE, path.join(STATE_DIR, "err.log")].filter((f) => fs.existsSync(f));
  if (files.length === 0) {
    process.stderr.write(`ログがまだありません (${STATE_DIR})\n`);
    return 1;
  }
  const args = follow ? ["-n", "50", "-F", ...files] : ["-n", "200", ...files];
  return new Promise((resolve) => {
    const child = spawn("tail", args, { stdio: "inherit" });
    child.on("exit", (code) => resolve(code ?? 0));
    child.on("error", () => resolve(1));
  });
}
