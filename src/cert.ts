import { X509Certificate } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { run } from "./exec.js";
import { CERTS_DIR } from "./paths.js";
import type { Logger } from "./logger.js";

export const CERT_FILE = path.join(CERTS_DIR, "server.pem");
export const KEY_FILE = path.join(CERTS_DIR, "server-key.pem");
const META_FILE = path.join(CERTS_DIR, "meta.json");

/**
 * ルート CA のコピー。
 *
 * 常駐プロセスは launchd から起動されるため PATH が /usr/bin:/bin:/usr/sbin:/sbin しかなく、
 * Homebrew の mkcert (/opt/homebrew/bin など) を呼べない。実行時に mkcert -CAROOT へ
 * 問い合わせる作りだと CA を配れなくなるので、setup 時にここへコピーしておく。
 */
export const CA_FILE = path.join(CERTS_DIR, "rootCA.pem");

/** launchd 配下では PATH が最小限なので、Homebrew の場所も直接見る */
const MKCERT_CANDIDATES = [
  "/opt/homebrew/bin/mkcert", // Apple Silicon の Homebrew
  "/usr/local/bin/mkcert", // Intel の Homebrew
  "/opt/local/bin/mkcert", // MacPorts
];

let cachedMkcert: string | null = null;

/** 実行可能な mkcert のパスを解決する。PATH → 既知の場所の順で探す */
export async function resolveMkcert(): Promise<string | null> {
  if (cachedMkcert && fs.existsSync(cachedMkcert)) return cachedMkcert;
  for (const candidate of ["mkcert", ...MKCERT_CANDIDATES]) {
    if ((await run(candidate, ["-version"])).code === 0) {
      cachedMkcert = candidate;
      return candidate;
    }
  }
  return null;
}

async function runMkcert(args: string[]): Promise<{ code: number; stdout: string }> {
  const bin = await resolveMkcert();
  if (!bin) return { code: 127, stdout: "" };
  return run(bin, args);
}

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
  return (await resolveMkcert()) !== null;
}

export async function mkcertCARoot(): Promise<string | null> {
  const r = await runMkcert(["-CAROOT"]);
  const dir = r.stdout.trim();
  return r.code === 0 && dir ? dir : null;
}

/** ローカル CA を作成し Mac のキーチェーンに登録する */
export async function installLocalCA(): Promise<boolean> {
  return (await runMkcert(["-install"])).code === 0;
}

/**
 * mkcert の CAROOT から rootCA.pem を設定ディレクトリにコピーする。
 * 以降、常駐プロセスは mkcert を呼ばずにこのファイルを読む。
 */
export async function copyRootCA(): Promise<string | null> {
  const caRoot = await mkcertCARoot();
  if (!caRoot) return null;
  const source = path.join(caRoot, "rootCA.pem");
  try {
    fs.mkdirSync(CERTS_DIR, { recursive: true });
    fs.copyFileSync(source, CA_FILE);
    return CA_FILE;
  } catch {
    return null;
  }
}

/**
 * 配布用のルート CA を読む。コピーが無ければ mkcert に問い合わせ、
 * 取れたらそのときコピーしておく（setup を通していない場合の保険）。
 */
export async function readRootCA(): Promise<Buffer | null> {
  try {
    return fs.readFileSync(CA_FILE);
  } catch {
    // コピーがまだ無い
  }
  return (await copyRootCA()) ? fs.readFileSync(CA_FILE) : null;
}

export async function issueCert(names: string[]): Promise<boolean> {
  fs.mkdirSync(CERTS_DIR, { recursive: true });
  const r = await runMkcert([
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
