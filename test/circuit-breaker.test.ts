/**
 * The breakpoint: once LinkedIn hard-blocks us, nothing else goes out until a
 * human says so.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileTripStore, UpstreamCircuitBreaker } from '../src/security/circuit-breaker.js';

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

/**
 * The breakpoint has to survive the PROCESS, not just the request. In memory
 * alone, a crash-loop or a redeploy re-closes the breaker and the app resumes
 * hitting an account LinkedIn has already flagged.
 */
describe('UpstreamCircuitBreaker persistence', () => {
  const dirs: string[] = [];

  const stateFile = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'breaker-'));
    dirs.push(dir);
    return join(dir, 'state', 'breaker.json');
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('reopens on restart when the previous process was blocked', () => {
    const path = stateFile();
    const before = new UpstreamCircuitBreaker(new FileTripStore(path));
    before.trip({ detail: 'LinkedIn returned 999 (bot detection)', status: 999 });

    // A brand new process, same volume.
    const after = new UpstreamCircuitBreaker(new FileTripStore(path));
    expect(after.isOpen).toBe(true);
    expect(after.state()).toMatchObject({ open: true, reason: { status: 999, detail: /999/ as never } });
    expect(after.blockIfOpen()?.detail).toMatch(/999/);
  });

  it('starts closed when nothing was ever written', () => {
    const fresh = new UpstreamCircuitBreaker(new FileTripStore(stateFile()));
    expect(fresh.isOpen).toBe(false);
    expect(fresh.blockIfOpen()).toBeNull();
  });

  it('an operator resume clears the file, so the next process starts closed', () => {
    const path = stateFile();
    const before = new UpstreamCircuitBreaker(new FileTripStore(path));
    before.trip({ detail: 'access-denied authwall', status: 303 });
    expect(before.reset()?.detail).toMatch(/authwall/);

    expect(new UpstreamCircuitBreaker(new FileTripStore(path)).isOpen).toBe(false);
  });

  it('does not carry the refusal count across restarts', () => {
    const path = stateFile();
    const before = new UpstreamCircuitBreaker(new FileTripStore(path));
    before.trip({ detail: 'checkpoint challenge', status: 302 });
    before.blockIfOpen();
    before.blockIfOpen();

    // Refusals counted by a dead process are not this process's business.
    const after = new UpstreamCircuitBreaker(new FileTripStore(path));
    expect(after.blockIfOpen()?.blockedSince).toBe(1);
  });

  it('FAILS CLOSED on damaged state — an unreadable file is not "fine"', () => {
    for (const damage of ['', 'not json at all', '{"detail":42}', '[]']) {
      const path = stateFile();
      const store = new FileTripStore(path);
      // Create the directory the same way a real save would, then damage it.
      new UpstreamCircuitBreaker(store).trip({ detail: 'seed', status: 999 });
      writeFileSync(path, damage, 'utf8');

      const after = new UpstreamCircuitBreaker(new FileTripStore(path));
      expect(after.isOpen).toBe(true);
      expect(after.state()).toMatchObject({ open: true, reason: { detail: /operator/ as never } });
    }
  });

  it('fails closed when the state path itself is unusable', () => {
    // Parent is a regular file, so the read fails with ENOTDIR rather than the
    // ENOENT of a clean first boot. A misconfigured volume must not read as
    // "no trip recorded".
    const dir = mkdtempSync(join(tmpdir(), 'breaker-'));
    dirs.push(dir);
    const blocker = join(dir, 'not-a-dir');
    writeFileSync(blocker, 'x', 'utf8');

    const b = new UpstreamCircuitBreaker(new FileTripStore(join(blocker, 'breaker.json')));
    expect(b.isOpen).toBe(true);
    expect(b.state()).toMatchObject({ open: true, reason: { detail: /could not be read/ as never } });
  });

  it('a write failure is loud but never masks the upstream error that tripped it', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), 'breaker-'));
    dirs.push(dir);
    // Nothing exists yet, so the breaker boots closed, as on a clean start...
    const path = join(dir, 'state', 'breaker.json');
    const b = new UpstreamCircuitBreaker(new FileTripStore(path));
    expect(b.isOpen).toBe(false);
    // ...and only then does the volume turn out to be unwritable.
    writeFileSync(join(dir, 'state'), 'x', 'utf8');

    expect(() => b.trip({ detail: 'LinkedIn returned 999', status: 999 })).not.toThrow();

    // In-memory protection still holds; only the restart guarantee is lost, and
    // that is what the log line has to say.
    expect(b.isOpen).toBe(true);
    expect(b.blockIfOpen()?.status).toBe(999);
    expect(errors).toHaveBeenCalledWith(expect.stringMatching(/FAILED TO PERSIST.*NOT survive a restart/s));
  });

  it('writes the trip as readable JSON an operator can inspect', () => {
    const path = stateFile();
    new UpstreamCircuitBreaker(new FileTripStore(path)).trip({
      detail: 'LinkedIn returned 999 (bot detection)',
      status: 999,
    });
    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written).toMatchObject({ status: 999, detail: expect.stringContaining('999') });
    expect(typeof written.at).toBe('string');
  });
});
