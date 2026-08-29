/**
 * Session tokens for the bundled web UI.
 *
 * The problem: the UI should work without a human pasting a secret, but a
 * static page that calls the API needs *something* to authenticate with.
 *
 * The naive fix is to template `API_KEY` into the HTML. Don't. That publishes
 * the real key to anyone who views source, and that key is also valid from
 * curl, from another origin, and against any other deployment sharing it.
 *
 * Instead the server mints a short-lived token derived from the key and hands
 * it back as an httpOnly cookie. The browser can send it but JavaScript cannot
 * read it, it expires, and it is useless for anything except this origin's
 * profile endpoint.
 *
 * Be honest about what this does NOT do: anyone who can load the page gets a
 * cookie, so a publicly reachable UI means a publicly reachable API. This
 * protects the *credential*, not the *endpoint*. Gating the endpoint itself
 * still requires the `x-api-key` header, which the UI never uses.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const UI_COOKIE = 'ui_session';

/** How long a minted UI session stays valid. */
const TTL_MS = 12 * 60 * 60 * 1000;

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Mint a token of the form `<expiryMs>.<hmac>`. */
export function mintUiToken(secret: string, now = Date.now()): string {
  const exp = String(now + TTL_MS);
  return `${exp}.${sign(exp, secret)}`;
}

export function verifyUiToken(token: string | undefined, secret: string, now = Date.now()): boolean {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;

  const exp = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!/^\d{1,15}$/.test(exp)) return false;
  if (Number(exp) < now) return false;

  // Constant-time comparison, same reasoning as the API key: a byte-by-byte
  // early exit leaks how much of a forged signature was correct.
  const expected = Buffer.from(sign(exp, secret));
  const provided = Buffer.from(mac);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

/**
 * Read one cookie from a raw `Cookie` header.
 *
 * Hand-parsed to avoid a dependency for a single value. Splits on `;` only —
 * cookie values may legitimately contain `=`, so we split each pair on the
 * FIRST `=` rather than all of them.
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** Serialise the cookie. httpOnly so page scripts can never read it. */
export function uiCookieHeader(token: string, secure: boolean): string {
  const parts = [
    `${UI_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    // Strict: the cookie is never attached to cross-site requests, so another
    // origin cannot drive this API using the visitor's session.
    'SameSite=Strict',
    `Max-Age=${Math.floor(TTL_MS / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}
