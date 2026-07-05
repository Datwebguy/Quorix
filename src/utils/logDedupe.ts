const lastLoggedAt = new Map<string, number>();

/** Log the same error key at most once per interval (default 2 minutes). */
export function logErrorOnce(key: string, message: string, intervalMs = 120_000): void {
  const now = Date.now();
  const last = lastLoggedAt.get(key) || 0;
  if (now - last < intervalMs) return;
  lastLoggedAt.set(key, now);
  console.error(message);
}

export function logWarnOnce(key: string, message: string, intervalMs = 120_000): void {
  const now = Date.now();
  const last = lastLoggedAt.get(key) || 0;
  if (now - last < intervalMs) return;
  lastLoggedAt.set(key, now);
  console.warn(message);
}