/**
 * Doctrine freshness (ROADMAP Phase 6/7): `valid_until` in frontmatter marks when a
 * doc stops being authoritative. Inclusive through end of that calendar day (UTC).
 */

/** True when `valid_until` is set and the reference time is after that day. */
export function isDoctrineExpired(validUntil: string | undefined, now = new Date()): boolean {
  const raw = validUntil?.trim();
  if (!raw) return false;
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return false;
  const end = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999);
  return now.getTime() > end;
}