/**
 * Whether a share-service URL points at the local network rather than a
 * public host. That is the distinction that matters on Android: reaching
 * a LAN service is local-network traffic and needs the local network
 * permission, while a public URL goes out over the ordinary internet
 * connection the app already has. Loopback counts as local: the
 * service running on this same device is LAN traffic to itself.
 */
export function isLocalServiceUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::" ||
    host === "[::]"
  ) {
    return true;
  }
  // mDNS and common LAN name suffixes.
  if (
    host.endsWith(".local") ||
    host.endsWith(".lan") ||
    host.endsWith(".localdomain")
  ) {
    return true;
  }
  // Private IPv4 ranges: 127/8, 10/8, 172.16/12, 192.168/16.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 127 || a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  // IPv6: link-local (fe80::/10) and unique-local (fc00::/7).
  if (
    host.startsWith("fe80") ||
    host.startsWith("fc") ||
    host.startsWith("fd")
  ) {
    return true;
  }
  return false;
}
