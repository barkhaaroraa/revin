/**
 * The breakpoint: once LinkedIn hard-blocks us, nothing else goes out until a
 * human says so.
 */

import { describe, it, expect } from 'vitest';
import { UpstreamCircuitBreaker } from '../src/security/circuit-breaker.js';

describe('UpstreamCircuitBreaker', () => {
  it('is closed and passes requests through until it trips', () => {
    const b = new UpstreamCircuitBreaker();
    expect(b.isOpen).toBe(false);
    expect(b.blockIfOpen()).toBeNull();
    expect(b.state()).toEqual({ open: false });
  });

  it('opens on trip and blocks every subsequent request', () => {
    const b = new UpstreamCircuitBreaker();
    b.trip({ detail: 'LinkedIn returned 999 (bot detection)', status: 999 });

    expect(b.isOpen).toBe(true);
    const first = b.blockIfOpen();
    expect(first?.status).toBe(999);
    expect(first?.detail).toMatch(/999/);
    // Refusals are counted so an operator can see how much was held back.
    expect(b.blockIfOpen()?.blockedSince).toBe(2);
  });

  it('keeps the FIRST trip reason, not follow-on symptoms', () => {
    const b = new UpstreamCircuitBreaker();
    b.trip({ detail: 'first: 999', status: 999 });
    b.trip({ detail: 'second: checkpoint', status: 302 });
    expect(b.state()).toMatchObject({ open: true, reason: { detail: 'first: 999', status: 999 } });
  });

  it('only a manual reset closes it, and reset reports what it cleared', () => {
    const b = new UpstreamCircuitBreaker();
    b.trip({ detail: 'access-denied authwall', status: 303 });
    const cleared = b.reset();
    expect(cleared?.detail).toMatch(/authwall/);
    expect(b.isOpen).toBe(false);
    // Resetting an already-closed breaker is a no-op that reports nothing.
    expect(b.reset()).toBeNull();
  });
});
