/**
 * SSRF defense Layer 2: an HTTP dispatcher that physically cannot open a
 * socket to a private address.
 *
 * The subtle bug this exists to prevent is DNS REBINDING (a TOCTOU race).
 * The naive version of this control looks like:
 *
 *     const ip = await dns.resolve(url.hostname);   // 1.2.3.4 -> looks fine
 *     if (isPrivate(ip)) throw new Error('blocked');
 *     await fetch(url);                             // resolves AGAIN -> 127.0.0.1
 *
 * An attacker serves a record with a 0-second TTL that answers public on the
 * first lookup and loopback on the second. The check and the connection used
 * two different answers, so the check protected nothing.
 *
 * The fix is structural: the validation must happen INSIDE the resolution the
 * connection actually uses. undici lets us supply the `lookup` function its
 * connector calls, so we resolve once, validate that answer, and hand back the
 * validated address. There is no second lookup to poison.
 */

import { lookup as dnsLookup } from 'node:dns';
import type { LookupAddress, LookupAllOptions, LookupOptions } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { Agent } from 'undici';
import { checkIp } from './ip-rules.js';

/** Thrown when a hostname resolves to an address we refuse to connect to. */
export class SsrfBlockedError extends Error {
  override readonly name = 'SsrfBlockedError';
  constructor(
    readonly hostname: string,
    reason: string,
  ) {
    super(`refusing to connect to "${hostname}": ${reason}`);
  }
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * A drop-in replacement for `dns.lookup` that refuses private addresses.
 *
 * Fails CLOSED in every ambiguous case: a resolution error, an empty answer,
 * or a multi-record answer where *any* record is private all reject. Rejecting
 * on "any bad record" rather than "pick a good one" matters — a rebinding
 * attacker can return a public and a private address in the same response and
 * let the client's selection logic pick the wrong one.
 */
export function safeLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err, '', 0);

    if (!addresses || addresses.length === 0) {
      return callback(new SsrfBlockedError(hostname, 'resolved to no addresses') as NodeJS.ErrnoException, '', 0);
    }

    for (const entry of addresses) {
      const verdict = checkIp(entry.address);
      if (!verdict.allowed) {
        return callback(new SsrfBlockedError(hostname, verdict.reason) as NodeJS.ErrnoException, '', 0);
      }
    }

    // Every record passed. Hand back the validated answer itself — the
    // connector uses exactly these addresses, so nothing can change underneath.
    if ((options as LookupAllOptions).all) {
      return callback(null, addresses);
    }
    const first = addresses[0]!;
    callback(null, first.address, first.family);
  });
}

/**
 * The dispatcher every outbound request in this app must use.
 *
 * Note it does NOT follow redirects: undici's Agent has no redirect handling
 * unless you opt in, and every caller pairs this with `redirect: 'manual'`.
 * That is deliberate. Redirects are attacker-influenced even when the initial
 * URL is not, and a `302 -> http://169.254.169.254/` is the standard way to
 * walk around a check that only ran on the first URL. Each hop is inspected
 * explicitly instead. See linkedin/client.ts.
 */
export const safeAgent = new Agent({
  connect: {
    // The cast is unavoidable: Node types `lookup` as the narrow `all: false`
    // overload, but we deliberately resolve with `all: true` so we can validate
    // EVERY record rather than only the one the resolver happened to return
    // first. The runtime contract is satisfied; only the overload is too narrow.
    lookup: safeLookup as unknown as LookupFunction,
    timeout: 10_000,
  },
  headersTimeout: 15_000,
  bodyTimeout: 20_000,
});

/** Cap on how much of a response we are willing to buffer. */
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/**
 * Read a response body with a hard byte ceiling.
 *
 * Without this, a hostile or merely broken upstream can exhaust memory: a slow
 * drip holds the socket open, and a compressed payload can expand enormously
 * after decoding. We count what we have actually accumulated and abort past
 * the limit rather than trusting the Content-Length header, which is a claim
 * by the server, not a fact.
 */
export async function readCapped(body: ReadableStream<Uint8Array> | null, limit = MAX_RESPONSE_BYTES): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new Error(`response exceeded ${limit} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}
