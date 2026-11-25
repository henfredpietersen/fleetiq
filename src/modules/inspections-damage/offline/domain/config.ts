// Offline queue configuration (DEC-06, DEC-43). One place: nothing else in the app hard-codes these numbers.
export const OFFLINE_CONFIG = {
  /** DEC-43: the driver sees a "still not sent" warning once an item has waited this long. */
  stuckAfterMinutes: 30,
  /** DEC-43: the phone keeps the allocations starting or running in the next 24 hours. */
  snapshotHorizonHours: 24,
  /** Allocations that began up to this long ago (still running, or waiting for the post-shift inspection) stay in the snapshot. */
  snapshotLookBackHours: 12,
  /** The snapshot is refreshed whenever the phone is online, at least this often. */
  snapshotRefreshMinutes: 5,
  /** Retry waits: base * factor^(attempts - 1), capped. Same client_submission_id on every retry. */
  backoff: { baseMs: 2_000, factor: 2, maxMs: 5 * 60_000 },
  /** One request to our own server (a photo's slot, register, attach ...). */
  requestTimeoutMs: 45_000,
  /** The signed-URL upload of one ~1600 px photo over a weak connection. */
  uploadTimeoutMs: 120_000,
  /** A queued write is attempted at most this many times in one send of a photo (slot expired mid-upload). */
  slotReissueAttempts: 2,
} as const;
export type OfflineConfig = typeof OFFLINE_CONFIG;
