import { run } from "./exec.js";

/** "dev.local" → "dev"（LocalHostName に設定するラベル） */
export function labelFromHostname(hostname: string): string {
  return hostname.replace(/\.local$/i, "");
}

export async function getLocalHostName(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const r = await run("scutil", ["--get", "LocalHostName"]);
  const name = r.stdout.trim();
  return r.code === 0 && name ? name : null;
}

/**
 * LocalHostName を変更する。mDNSResponder が `<label>.local` を自動広告するようになり、
 * IP が変わっても追随する（§4.4 案 A）。sudo が必要。
 */
export async function setLocalHostName(label: string): Promise<boolean> {
  const r = await run("sudo", ["scutil", "--set", "LocalHostName", label]);
  return r.code === 0;
}
