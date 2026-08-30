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
 * This holds no credentials and imports nothing from the client, so it stays a
 * dependency-free leaf that both the client and the routes can share.
 */

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

export class UpstreamCircuitBreaker {
  private reason: TripReason | null = null;

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
  }

  /**
   * The gate every upstream request must pass. Returns the open reason (and
   * counts the refusal) when tripped, or `null` when it is safe to proceed.
   * Returning rather than throwing keeps this file free of the client's error
   * type; the caller translates a non-null result into its own failure.
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
    return was;
  }
}
