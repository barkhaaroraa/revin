import { describe, expect, it } from 'vitest';
import { clearsSessionCookie } from '../src/linkedin/client.js';

/**
 * Ground truth. These three Set-Cookie lines are copied verbatim from a live
 * 302 that LinkedIn returned to this project against a session it had decided
 * to reject. The cookie VALUES are the literal placeholder LinkedIn sends
 * (`delete me`), not a redaction — there is no secret in a deletion.
 *
 * The failure this locks down: the Location header on that response pointed at
 * the exact URL we had requested, so it matched neither `/uas/login` nor
 * `/checkpoint`, fell through to `upstream_unexpected`, and surfaced to the
 * caller as "unexpected redirect to www.linkedin.com" with a hint blaming a
 * rotated queryId. Every one of those words was true and none of them was the
 * problem. The Set-Cookie is where the answer was.
 */
const LOGOUT_302_SET_COOKIE = [
  'li_at="delete me"; Version=1; Path=/; Domain=.www.linkedin.com; Expires=Thu, 01-Jan-1970 00:00:00 GMT; Max-Age=0; Secure; SameSite=None; HttpOnly',
  'li_a="delete me"; Version=1; Path=/; Domain=.www.linkedin.com; Expires=Thu, 01-Jan-1970 00:00:00 GMT; Max-Age=0; Secure; SameSite=None',
  'liap="delete me"; Version=1; Path=/; Domain=.linkedin.com; Expires=Thu, 01-Jan-1970 00:00:00 GMT; Max-Age=0; Secure; SameSite=None',
];

describe('clearsSessionCookie', () => {
  it('recognises the captured logout response', () => {
    expect(clearsSessionCookie(LOGOUT_302_SET_COOKIE)).toBe(true);
  });

  it('matches on the expiry, not on the placeholder value', () => {
    // If LinkedIn changes "delete me" to anything else, this must still fire.
    expect(
      clearsSessionCookie(['li_at=; Path=/; Expires=Thu, 01-Jan-1970 00:00:00 GMT; Max-Age=0']),
    ).toBe(true);
  });

  it('ignores the sibling cookies on their own', () => {
    // `li_a` and `liap` are cleared in the same response, but neither is the
    // session. Matching a prefix would make `li_a` look like `li_at`.
    expect(clearsSessionCookie(LOGOUT_302_SET_COOKIE.slice(1))).toBe(false);
  });

  it('does not fire on a normal li_at refresh', () => {
    // A live session gets li_at RE-SET with a future expiry. Treating that as
    // a logout would take a working server down.
    expect(
      clearsSessionCookie([
        'li_at=AQEDATEST00000000; Path=/; Domain=.linkedin.com; Expires=Fri, 28-Aug-2026 12:00:00 GMT; Max-Age=31536000; Secure; HttpOnly',
      ]),
    ).toBe(false);
  });

  it('does not fire on an empty header set', () => {
    expect(clearsSessionCookie([])).toBe(false);
  });
});
