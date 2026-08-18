import { X509Certificate } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { run } from "./exec.js";
import { CERTS_DIR } from "./paths.js";
import type { Logger } from "./logger.js";

export const CERT_FILE = path.join(CERTS_DIR, "server.pem");
export const KEY_FILE = path.join(CERTS_DIR, "server-key.pem");
const META_FILE = path.join(CERTS_DIR, "meta.json");

const RENEW_BEFORE_DAYS = 30;

export interface TlsMaterial {
  key: Buffer;
  cert: Buffer;
}

interface CertMeta {
  names: string[];
  issuedAt: string;
}

/** 証明書に LAN IP は含めない。名前ベース（dev.local）でのアクセスを正とする（§4.3） */
export function defaultSans(hostname: string): string[] {
  return [hostname, `*.${hostname}`, "localhost", "127.0.0.1", "::1"];
}

export async function mkcertAvailable(): Promise<boolean> {
  return (await run("mkcert", ["-version"])).code === 0;
}

export async function mkcertCARoot(): Promise<string | null> {
  const r = await run("mkcert", ["-CAROOT"]);
  const dir = r.stdout.trim();
  return r.code === 0 && dir ? dir : null;
}

/** ローカル CA を作成し Mac のキーチェーンに登録する */
export async function installLocalCA(): Promise<boolean> {
  return (await run("mkcert", ["-install"])).code === 0;
}

export async function issueCert(names: string[]): Promise<boolean> {
  fs.mkdirSync(CERTS_DIR, { recursive: true });
  const r = await run("mkcert", [
    "-cert-file",
    CERT_FILE,
    "-key-file",
    KEY_FILE,
    ...names,
  ]);
  if (r.code !== 0) return false;
  const meta: CertMeta = { names, issuedAt: new Date().toISOString() };
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2) + "\n");
  return true;
}

export function loadTls(): TlsMaterial | null {
  try {
    return { key: fs.readFileSync(KEY_FILE), cert: fs.readFileSync(CERT_FILE) };
  } catch {
    return null;
  }
}

/** 証明書に載っている名前。meta.json が無ければ証明書の SAN から読む */
export function certNames(): string[] | null {
  try {
    const meta = JSON.parse(fs.readFileSync(META_FILE, "utf8")) as CertMeta;
    if (Array.isArray(meta.names) && meta.names.length > 0) return meta.names;
  } catch {
    // meta.json が無い場合は証明書本体を見る
  }
  try {
    const san = new X509Certificate(fs.readFileSync(CERT_FILE)).subjectAltName;
    if (!san) return null;
    // "DNS:dev.local, IP Address:127.0.0.1" のような形式
    return san.split(", ").map((entry) => entry.replace(/^(DNS|IP Address|URI|email):/, ""));
  } catch {
    return null;
  }
}

export function certExpiry(): Date | null {
  try {
    const x509 = new X509Certificate(fs.readFileSync(CERT_FILE));
    return new Date(x509.validTo);
  } catch {
    return null;
  }
}

/** 起動時チェック: 有効期限が 30 日を切っていたら再発行 + ログ警告（§4.3） */
export async function renewIfExpiring(hostname: string, log: Logger): Promise<void> {
  const expiry = certExpiry();
  if (!expiry) return;
  const daysLeft = (expiry.getTime() - Date.now()) / 86_400_000;
  if (daysLeft >= RENEW_BEFORE_DAYS) return;
  log.warn(`証明書の有効期限が残り ${Math.floor(daysLeft)} 日です。再発行します`);
  if (!(await mkcertAvailable())) {
    log.error("mkcert が見つからないため再発行できません。`sameport cert --renew` を実行してください");
    return;
  }
  const names = certNames() ?? defaultSans(hostname);
  if (await issueCert(names)) {
    log.info("証明書を再発行しました（反映には再起動が必要です）");
  } else {
    log.error("証明書の再発行に失敗しました。`sameport cert --renew` を手動で実行してください");
  }
}
