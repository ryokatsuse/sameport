import crypto from "node:crypto";

/**
 * ルート CA を iOS の構成プロファイル (.mobileconfig) に包む。
 *
 * 生の .pem を配ると iOS 15 以降は「プロファイルをダウンロードできませんでした」で
 * 失敗することが多い。com.apple.security.root ペイロードにして
 * application/x-apple-aspen-config で返すのが確実。
 */

/** 再インストールで重複しないよう、UUID は CA の内容から決定的に導出する */
function uuidFrom(seed: string): string {
  const h = crypto.createHash("sha256").update(seed).digest("hex");
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32)]
    .join("-")
    .toUpperCase();
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!,
  );
}

/** 64 文字ごとに改行した base64（plist の <data> の慣習に合わせる） */
function wrapBase64(der: Buffer): string {
  const b64 = der.toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64));
  return lines.join("\n");
}

export interface MobileconfigOptions {
  /** PEM 形式のルート CA */
  caPem: string | Buffer;
  hostname: string;
}

/** PEM から DER を取り出す。プロファイルには DER を base64 で埋める */
export function pemToDer(pem: string | Buffer): Buffer {
  return Buffer.from(new crypto.X509Certificate(pem).raw);
}

export function buildMobileconfig(opts: MobileconfigOptions): string {
  const der = pemToDer(opts.caPem);
  const fingerprint = crypto.createHash("sha256").update(der).digest("hex");
  const payloadUuid = uuidFrom(`payload:${fingerprint}`);
  const profileUuid = uuidFrom(`profile:${fingerprint}`);
  const displayName = `sameport root CA (${opts.hostname})`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key>
      <string>rootCA.crt</string>
      <key>PayloadContent</key>
      <data>
${wrapBase64(der)}
      </data>
      <key>PayloadDescription</key>
      <string>${escapeXml(opts.hostname)} を HTTPS で開くためのローカル開発用ルート証明書</string>
      <key>PayloadDisplayName</key>
      <string>${escapeXml(displayName)}</string>
      <key>PayloadIdentifier</key>
      <string>dev.sameport.ca.${payloadUuid}</string>
      <key>PayloadType</key>
      <string>com.apple.security.root</string>
      <key>PayloadUUID</key>
      <string>${payloadUuid}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
  </array>
  <key>PayloadDescription</key>
  <string>インストール後、設定 → 一般 → 情報 → 証明書信頼設定 でこの証明書を ON にしてください。</string>
  <key>PayloadDisplayName</key>
  <string>${escapeXml(displayName)}</string>
  <key>PayloadIdentifier</key>
  <string>dev.sameport.profile.${profileUuid}</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${profileUuid}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
`;
}
