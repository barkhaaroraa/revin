/**
 * Which IP addresses this server is allowed to open a socket to.
 *
 * This is SSRF defense Layer 2. Layer 1 (url-guard.ts) means we never fetch a
 * user-supplied URL in the first place, so in the current design this file
 * should never actually fire. It exists because one careless refactor could
 * undo Layer 1, and because redirects are attacker-influenced even when the
 * initial URL is not.
 *
 * The rule that matters: we judge the *resolved IP*, never the hostname.
 * A hostname allowlist is meaningless here — `evil.com` can have an A record
 * pointing at 127.0.0.1, and nothing about the string "evil.com" reveals that.
 */

import ipaddr from 'ipaddr.js';

type Cidr = readonly [address: string, prefixLength: number];

/**
 * IPv4 ranges that must never be reachable. Each of these is a real, used
 * SSRF target — not theoretical padding.
 */
const DENIED_V4: readonly Cidr[] = [
  ['0.0.0.0', 8], //        "this network". On Linux, connecting to 0.0.0.0 reaches localhost.
  ['10.0.0.0', 8], //       RFC1918 private — internal services, databases, admin panels.
  ['100.64.0.0', 10], //    RFC6598 carrier-grade NAT.
  ['127.0.0.0', 8], //      Loopback. Note this is a /8: 127.1 and 127.0.0.2 are equally loopback.
  ['169.254.0.0', 16], //   Link-local. CLOUD METADATA LIVES AT 169.254.169.254. The prize target.
  ['172.16.0.0', 12], //    RFC1918 private. Note the odd boundary: 172.16-172.31, not 172.x.
  ['192.0.0.0', 24], //     IETF protocol assignments.
  ['192.0.2.0', 24], //     TEST-NET-1.
  ['192.168.0.0', 16], //   RFC1918 private — home/office LANs.
  ['198.18.0.0', 15], //    Benchmarking.
  ['198.51.100.0', 24], //  TEST-NET-2.
  ['203.0.113.0', 24], //   TEST-NET-3.
  ['224.0.0.0', 4], //      Multicast.
  ['240.0.0.0', 4], //      Reserved, incl. 255.255.255.255 broadcast.
];

/** IPv6 ranges that must never be reachable. */
const DENIED_V6: readonly Cidr[] = [
  ['::', 128], //           Unspecified. Behaves like 0.0.0.0.
  ['::1', 128], //          Loopback.
  ['fc00::', 7], //         Unique local addresses — the v6 equivalent of RFC1918.
  ['fe80::', 10], //        Link-local.
  ['ff00::', 8], //         Multicast.
  ['2001:db8::', 32], //    Documentation.
  ['64:ff9b::', 96], //     NAT64. Embeds an IPv4 address in the low bits — a v4 target in
  //                        v6 clothing, so it must be denied even though the v4 rules
  //                        above would not obviously apply to it.
];

const PARSED_V4 = DENIED_V4.map(([addr, len]) => [ipaddr.parse(addr), len] as [ipaddr.IPv4, number]);
const PARSED_V6 = DENIED_V6.map(([addr, len]) => [ipaddr.parse(addr), len] as [ipaddr.IPv6, number]);

export type IpVerdict = { allowed: true; normalized: string } | { allowed: false; reason: string };

/**
 * Decide whether we may connect to a literal IP address.
 *
 * @param raw a bare IP literal, e.g. "13.107.42.14" or "::1". Not a hostname.
 */
export function checkIp(raw: string): IpVerdict {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(raw);
  } catch {
    // Unparseable means we cannot reason about it, so we refuse. Failing closed
    // is the only correct default in a security check.
    return { allowed: false, reason: `not a valid IP address: ${raw}` };
  }

  // An IPv4-mapped IPv6 address (::ffff:127.0.0.1) is loopback wearing a costume.
  // If we judged it as "some IPv6 address" every single IPv4 rule above would be
  // trivially bypassable by rewriting the target in v6 syntax. Unwrap first, judge second.
  if (addr.kind() === 'ipv6') {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      addr = v6.toIPv4Address();
    }
  }

  const denied = addr.kind() === 'ipv4' ? PARSED_V4 : PARSED_V6;
  for (const [netAddr, prefix] of denied) {
    // `match` is a proper bitwise prefix comparison. Never compare IPs as strings:
    // "127.0.0.1".startsWith("127.") happens to work, but "10.0.0.1" vs "100.64.0.1"
    // shows why string prefixes are the wrong tool.
    if (addr.match(netAddr as never, prefix)) {
      return { allowed: false, reason: `blocked range ${netAddr.toString()}/${prefix} (resolved ${addr.toString()})` };
    }
  }

  // Belt and braces: ipaddr.js classifies addresses independently of our table.
  // Anything it does not consider ordinary public unicast, we refuse — this
  // catches ranges we forgot or that get reserved after this code was written.
  const range = addr.range();
  if (range !== 'unicast') {
    return { allowed: false, reason: `non-unicast address range "${range}" (${addr.toString()})` };
  }

  return { allowed: true, normalized: addr.toString() };
}
