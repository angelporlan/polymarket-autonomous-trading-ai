export const SUPERVISOR_NORMAL_INTERVAL_MS = 60_000;
export const SUPERVISOR_ACTIVE_MIN_INTERVAL_MS = 5_000;
export const SUPERVISOR_ACTIVE_MAX_INTERVAL_MS = 15_000;
export const SUPERVISOR_MAX_BACKOFF_MS = 60_000;

export function nextSupervisorDelayMs(
  reconciliationActive: boolean,
  randomValue = Math.random()
): number {
  if (!reconciliationActive) {
    return SUPERVISOR_NORMAL_INTERVAL_MS;
  }
  const random = clampRandom(randomValue);
  const span =
    SUPERVISOR_ACTIVE_MAX_INTERVAL_MS - SUPERVISOR_ACTIVE_MIN_INTERVAL_MS;
  return SUPERVISOR_ACTIVE_MIN_INTERVAL_MS + Math.min(span, Math.floor(random * span));
}

export function supervisorBackoffDelayMs(
  consecutiveFailures: number,
  randomValue = Math.random()
): number {
  const failures = Math.max(1, Math.floor(consecutiveFailures));
  const exponential = Math.min(
    SUPERVISOR_MAX_BACKOFF_MS,
    1_000 * 2 ** Math.min(failures - 1, 6)
  );
  const jitter = 0.8 + 0.4 * clampRandom(randomValue);
  return Math.min(SUPERVISOR_MAX_BACKOFF_MS, Math.floor(exponential * jitter));
}

function clampRandom(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  return Math.min(1, Math.max(0, value));
}
