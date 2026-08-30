/**
 * The upstream circuit breaker — the "breakpoint" that stops us digging.
 *
 * When LinkedIn returns a 999 (its bot-detection status), a checkpoint
 * challenge, or an access-denied authwall, it is telling us the account has
 * been flagged. The single worst thing to do at that moment is send another
 * request: every additional call while flagged pushes the account from
 * "challenged" toward "permanently restricted". Retrying doesn't recover the
 * session — it burns it.
 *
 * So the first hard block TRIPS this breaker, and while it is open every
 * subsequent upstream call is refused BEFORE a socket is opened. The block then
 * persists across requests — not just within the one profile fetch that hit it
 * — until a human explicitly resumes (POST /v1/admin/resume). That is the
 * "don't send requests without asking me" rule made structural: once flagged,
 * the system will not touch LinkedIn again on its own.
 *
 * A trip must also survive the PROCESS, not just the request. In memory alone,
 * a crash-loop or a redeploy silently re-closes the breaker and the app resumes
 * hammering a flagged account — turning "stop and ask a human" into "retry on
 * every restart", which is precisely the failure this exists to prevent. Hence
 * the optional TripStore: point `BREAKER_STATE_FILE` at a path on a durable
 * volume and the open state is reloaded at boot.
 *
 * The breaker itself stays a dependency-free leaf — it holds no credentials and
 * imports nothing from the client, so both the client and the routes can share
 * it. Only the file-backed store below touches the filesystem.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Why the breaker opened — enough for an operator to decide what to do next. */
export interface TripReason {
  /** LinkedIn's HTTP status, when the trip came from a response. */
  readonly status?: number;
  /** Short, credential-free description of the signal that tripped it. */
  readonly detail: string;
  /** ISO timestamp of the trip. */
  readonly at: string;
  /** How many upstream calls have been refused since it opened. */
  blockedSince: number;
}

export type BreakerState =
  | { readonly open: false }
  | { readonly open: true; readonly reason: TripReason };

/**
 * Where an open breaker is remembered across restarts.
 *
 * Deliberately synchronous. A trip happens on the failure path of an upstream
 * request and a reset on an operator action; both are rare, and making them
 * async would let a request slip out between "decided to trip" and "trip
 * recorded" — the one window that must not exist.
 */
export interface TripStore {
  /** Read the persisted trip, or null when the breaker should start closed. */
  load(): TripReason | null;
  /** Persist a trip, or clear it when passed null. */
  save(reason: TripReason | null): void;
}

/**
 * A trip persisted as one small JSON file.
 *
 * Reads FAIL CLOSED. If the file exists but cannot be read or parsed, we cannot
 * prove the breaker was closed, and the expensive mistake is the optimistic one:
 * assuming "fine" and resuming traffic against an account that may be flagged.
 * A missing file is different — that is a first boot, and it starts closed.
 */
export class FileTripStore implements TripStore {
  constructor(private readonly path: string) {}

  load(): TripReason | null {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (err) {
      // Nothing written yet: a genuinely clean start.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      return unreadable(`breaker state at ${this.path} could not be read`);
    }

    // An empty file is what a truncated write leaves behind. Treat it as
    // damage, not as "closed".
    if (raw.trim() === '') return unreadable(`breaker state at ${this.path} is empty`);

    try {
      const parsed: unknown = JSON.parse(raw);
      return validateTrip(parsed) ?? unreadable(`breaker state at ${this.path} is malformed`);
    } catch {
      return unreadable(`breaker state at ${this.path} is not valid JSON`);
    }
  }

  save(reason: TripReason | null): void {
    try {
      if (reason === null) {
        try {
          unlinkSync(this.path);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
        return;
      }

      mkdirSync(dirname(this.path), { recursive: true });
      // Write-then-rename: a crash mid-write would otherwise leave a truncated
      // file, which (fail-closed, above) would wedge the breaker open on the
      // next boot for no real reason.
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(reason, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, this.path);
    } catch (err) {
      // Never let a persistence failure replace the upstream error that caused
      // the trip — the in-memory breaker is already open, so this process stays
      // safe. Only a restart would lose the block, and that is worth shouting
      // about in the logs.
      console.error(
        `[breaker] FAILED TO PERSIST TRIP STATE to ${this.path}: ${(err as Error).message}. ` +
          'The breaker is open in memory but will NOT survive a restart.',
      );
    }
  }
}

/** The synthetic trip used when persisted state exists but cannot be trusted. */
function unreadable(detail: string): TripReason {
  return {
    detail: `${detail} — refusing upstream traffic until an operator resumes`,
    at: new Date().toISOString(),
    blockedSince: 0,
  };
}

/** Accept only a shape we wrote ourselves; anything else is damage. */
function validateTrip(value: unknown): TripReason | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.detail !== 'string' || typeof v.at !== 'string') return null;
  if (v.status !== undefined && typeof v.status !== 'number') return null;
  return {
    status: v.status as number | undefined,
    detail: v.detail,
    at: v.at,
    // Refusals counted by a previous process are not this process's business.
    blockedSince: 0,
  };
}

/** No store configured — the breaker is in-memory only, as in development. */
export function createTripStore(path: string | undefined): TripStore | undefined {
  return path ? new FileTripStore(path) : undefined;
}

export class UpstreamCircuitBreaker {
  private reason: TripReason | null;

  /**
   * Reloads any persisted trip at construction, so a restarted process starts
   * blocked if it was blocked when it died.
   */
  constructor(private readonly store?: TripStore) {
    this.reason = store?.load() ?? null;
  }

  /**
   * Record a hard block and open the breaker.
   *
   * Idempotent: only the FIRST trip is kept. A block often surfaces as several
   * failing section requests in quick succession, and we want the original
   * cause preserved, not overwritten by the follow-on symptoms.
   */
  trip(reason: Omit<TripReason, 'at' | 'blockedSince'> & { at?: string }): void {
    if (this.reason) return;
    this.reason = {
      status: reason.status,
      detail: reason.detail,
      at: reason.at ?? new Date().toISOString(),
      blockedSince: 0,
    };
    this.store?.save(this.reason);
  }

  /**
   * The gate every upstream request must pass. Returns the open reason (and
   * counts the refusal) when tripped, or `null` when it is safe to proceed.
   * Returning rather than throwing keeps this file free of the client's error
   * type; the caller translates a non-null result into its own failure.
   *
   * The refusal count is NOT persisted: that would mean a disk write per
   * refused request, and the number is only ever an operator's rough gauge of
   * how much was held back by this process.
   */
  blockIfOpen(): TripReason | null {
    if (!this.reason) return null;
    this.reason = { ...this.reason, blockedSince: this.reason.blockedSince + 1 };
    return this.reason;
  }

  /** Current state, for a status endpoint. */
  state(): BreakerState {
    return this.reason ? { open: true, reason: this.reason } : { open: false };
  }

  get isOpen(): boolean {
    return this.reason !== null;
  }

  /**
   * Human-initiated resume. Closes the breaker and returns whatever it was
   * tripped on (or null if it was already closed) so the caller can report
   * exactly what is being cleared.
   */
  reset(): TripReason | null {
    const was = this.reason;
    this.reason = null;
    if (was) this.store?.save(null);
    return was;
  }
}
