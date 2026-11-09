/** True if someone born on `dob` (UTC date) has turned 18 by `now`. */
export function isAdult(dob: Date, now: Date = new Date(), adultAge = 18): boolean {
  const cutoff = Date.UTC(now.getUTCFullYear() - adultAge, now.getUTCMonth(), now.getUTCDate());
  return dob.getTime() <= cutoff;
}

/** Parse a strict YYYY-MM-DD calendar date as UTC midnight, or null if invalid. */
export function parseIsoDate(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
    return null;
  }
  return date;
}
