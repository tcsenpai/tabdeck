// Access guards. The pad (tablet) can only press already-defined buttons;
// anything that creates or changes commands (editor, test) is allowed ONLY from the Mac itself.

const LOOPBACK_IPS: Record<string, true> = { "127.0.0.1": true, "::1": true, "::ffff:127.0.0.1": true };
const LOOPBACK_HOSTS: Record<string, true> = { localhost: true, "127.0.0.1": true, "[::1]": true };

function hostname(hostHeader: string | null): string {
  if (!hostHeader) return "";
  // "[::1]:8430" → "[::1]"; "localhost:8430" → "localhost"
  return hostHeader.startsWith("[") ? hostHeader.slice(0, hostHeader.indexOf("]") + 1) : hostHeader.split(":")[0];
}

// "From the Mac" = the socket comes from loopback or from one of the Mac's own IPs (opening the LAN address from the
// Mac makes the connection originate from its LAN IP), AND the Host header is localhost or one of the Mac's IPs.
// The Host check blocks DNS rebinding: a foreign domain resolving to this Mac does not pass.
// Another LAN device has a different source IP, so it stays out.
export function editorAllowed(hostHeader: string | null, remoteIp: string | undefined, localIps: string[] = []): boolean {
  if (!remoteIp) return false;
  const remoteOk = Object.hasOwn(LOOPBACK_IPS, remoteIp) || localIps.includes(remoteIp.replace(/^::ffff:/, ""));
  const host = hostname(hostHeader).toLowerCase();
  return remoteOk && (Object.hasOwn(LOOPBACK_HOSTS, host) || localIps.includes(host));
}

// Anti-CSRF: if the browser sends an Origin, it must be the server's own.
// Requests without Origin (curl, scripts) pass: a third-party web page cannot send them.
export function sameOriginOk(origin: string | null, hostHeader: string | null): boolean {
  if (origin === null) return true;
  try {
    return new URL(origin).host === hostHeader;
  } catch {
    return false;
  }
}
