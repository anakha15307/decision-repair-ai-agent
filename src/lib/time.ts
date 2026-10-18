// Timezone helpers without external dependencies. All instants are stored as UTC ISO strings.

function offsetMinutes(utcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return (asUtc - utcMs) / 60000;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert a wall-clock time ("YYYY-MM-DD" or "YYYY-MM-DDTHH:mm[:ss]") in an IANA zone to a UTC ISO instant.
 */
export function zonedToUtc(local: string, timeZone: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(local.trim());
  if (!m) throw new Error(`Invalid local date/time "${local}". Expected YYYY-MM-DD or YYYY-MM-DDTHH:mm.`);
  if (!isValidTimeZone(timeZone)) throw new Error(`Unknown timezone "${timeZone}".`);
  const [, y, mo, d, h = "00", mi = "00", s = "00"] = m;
  const naive = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  // Two passes handle DST transitions adequately for this use.
  let guess = naive - offsetMinutes(naive, timeZone) * 60000;
  guess = naive - offsetMinutes(guess, timeZone) * 60000;
  return new Date(guess).toISOString();
}

export function formatInZone(iso: string | null | undefined, timeZone: string, withTime = true): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit", timeZoneName: "short" } : {}),
  }).format(d);
}

export function isIsoInstant(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(v) && !isNaN(Date.parse(v));
}

export function toUtcIso(v: string): string {
  return new Date(v).toISOString();
}

export const DAY_MS = 86_400_000;

export function daysBetween(fromIso: string, toIso: string): number {
  return (Date.parse(toIso) - Date.parse(fromIso)) / DAY_MS;
}

let clockOverride: string | null = null;

/**
 * Seeding only: replay a demonstration timeline through the normal service functions so
 * seeded audit entries carry plausible dates. Never used by the running application.
 */
export function setClockForSeeding(iso: string | null): void {
  clockOverride = iso;
}

export function nowIso(): string {
  return clockOverride ?? new Date().toISOString();
}
