import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "./exec.js";
import { STATE_DIR } from "./paths.js";

export const AGENT_LABEL = "dev.sameport";
export const PLIST_PATH = path.join(
  os.homedir(),
  "Library",
  "LaunchAgents",
  `${AGENT_LABEL}.plist`,
);

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!,
  );
}

export function buildPlist(nodePath: string, cliPath: string): string {
  const args = [nodePath, cliPath, "start"];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${escapeXml(a)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(path.join(STATE_DIR, "out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(STATE_DIR, "err.log"))}</string>
  <key>ProcessType</key>
  <string>Background</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <!-- launchd 既定の PATH には Homebrew が入っておらず mkcert を呼べない -->
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
`;
}

function domainTarget(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

export async function installAgent(nodePath: string, cliPath: string): Promise<void> {
  fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(PLIST_PATH, buildPlist(nodePath, cliPath));
  // 既存があれば入れ替える
  await run("launchctl", ["bootout", `${domainTarget()}/${AGENT_LABEL}`]);
  await run("launchctl", ["bootstrap", domainTarget(), PLIST_PATH]);
  await run("launchctl", ["enable", `${domainTarget()}/${AGENT_LABEL}`]);
}

export async function uninstallAgent(): Promise<void> {
  await run("launchctl", ["bootout", `${domainTarget()}/${AGENT_LABEL}`]);
  try {
    fs.unlinkSync(PLIST_PATH);
  } catch {
    // 未インストール
  }
}

export async function agentInstalled(): Promise<boolean> {
  if (!fs.existsSync(PLIST_PATH)) return false;
  const { stdout } = await run("launchctl", ["list"]);
  return stdout.includes(AGENT_LABEL);
}
