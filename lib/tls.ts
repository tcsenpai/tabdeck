// Optional HTTPS listener: browsers only offer the microphone (and a real PWA install) in a secure context, and
// plain http://<LAN-IP> is not one. A self-signed certificate is enough: the tablet shows a warning once
// ("Advanced → Proceed") and the page is then secure. The certificate is generated with the system `openssl`
// (LibreSSL on macOS), lives in the data dir and is regenerated when the Mac's addresses change.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

export interface TlsFiles {
  cert: string;
  key: string;
}

const OPENSSL = existsSync("/usr/bin/openssl") ? "/usr/bin/openssl" : "openssl"; // launchd runs us with a minimal PATH

// The names the certificate must cover, normalised so the same set always gives the same string.
export const sanFor = (ips: string[]): string[] => [...new Set(["localhost", "127.0.0.1", ...ips])].sort();

export function ensureCert(dir: string, ips: string[]): TlsFiles {
  mkdirSync(dir, { recursive: true });
  const cert = `${dir}/tls-cert.pem`;
  const key = `${dir}/tls-key.pem`;
  const meta = `${dir}/tls-names.txt`;
  const names = sanFor(ips).join(",");
  let fresh = existsSync(cert) && existsSync(key);
  try {
    if (fresh && readFileSync(meta, "utf8") !== names) fresh = false;
  } catch {
    fresh = false;
  }
  if (!fresh) {
    const san = sanFor(ips).map((n) => (/^[\d.]+$/.test(n) ? `IP:${n}` : `DNS:${n}`)).join(",");
    const r = Bun.spawnSync([
      OPENSSL, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "825", "-sha256",
      "-keyout", key, "-out", cert, "-subj", "/CN=TabDeck", "-addext", `subjectAltName=${san}`,
    ], { stdout: "ignore", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`openssl failed: ${r.stderr.toString().trim().slice(0, 200)}`);
    writeFileSync(meta, names);
  }
  return { cert: readFileSync(cert, "utf8"), key: readFileSync(key, "utf8") };
}
