/**
 * Date helpers. PRCD stores *floating* local dates and times ("2026-11-20", "14:15") so that
 * lessons never shift with daylight-saving changes. All arithmetic is done on UTC day numbers
 * to stay independent from the device time zone.
 */

export type ISODate = string; // YYYY-MM-DD
export type HM = string; // HH:MM (24h)
export type LocalDateTime = string; // YYYY-MM-DDTHH:MM

const MS_DAY = 86_400_000;

export const MONTHS_IT = [
  'gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
  'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre',
];
export const MONTHS_SHORT_IT = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
/** Index 0 = Monday (ISO weekday 1). */
export const WEEKDAYS_IT = ['lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato', 'domenica'];
export const WEEKDAYS_SHORT_IT = ['lun', 'mar', 'mer', 'gio', 'ven', 'sab', 'dom'];
export const WEEKDAY_LETTERS_IT = ['L', 'M', 'M', 'G', 'V', 'S', 'D'];

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isISODate(s: unknown): s is ISODate {
  if (typeof s !== 'string') return false;
  const m = ISO_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function isHM(s: unknown): s is HM {
  return typeof s === 'string' && HM_RE.test(s);
}

export function parseISODate(iso: ISODate): { y: number; m: number; d: number } {
  const m = ISO_RE.exec(iso);
  if (!m) throw new Error(`Invalid ISO date: ${iso}`);
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/** Days since 1970-01-01 (UTC) for an ISO date. */
export function dayNumber(iso: ISODate): number {
  const { y, m, d } = parseISODate(iso);
  return Math.round(Date.UTC(y, m - 1, d) / MS_DAY);
}

export function fromDayNumber(n: number): ISODate {
  const dt = new Date(n * MS_DAY);
  return `${String(dt.getUTCFullYear()).padStart(4, '0')}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

export function addDays(iso: ISODate, n: number): ISODate {
  return fromDayNumber(dayNumber(iso) + n);
}

export function diffDays(a: ISODate, b: ISODate): number {
  return dayNumber(a) - dayNumber(b);
}

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export function weekdayISO(iso: ISODate): number {
  const n = dayNumber(iso);
  // 1970-01-01 was a Thursday (ISO 4).
  return ((((n + 3) % 7) + 7) % 7) + 1;
}

/** Monday of the ISO week containing `iso`. */
export function startOfWeek(iso: ISODate): ISODate {
  return addDays(iso, -(weekdayISO(iso) - 1));
}

export function startOfMonth(iso: ISODate): ISODate {
  const { y, m } = parseISODate(iso);
  return makeISODate(y, m, 1);
}

export function endOfMonth(iso: ISODate): ISODate {
  const { y, m } = parseISODate(iso);
  return makeISODate(y, m, daysInMonth(y, m));
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function makeISODate(y: number, m: number, d: number): ISODate {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function addMonths(iso: ISODate, n: number): ISODate {
  const { y, m, d } = parseISODate(iso);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12 + 12) % 12 + 1;
  return makeISODate(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

/** Inclusive list of dates from `from` to `to`. */
export function eachDay(from: ISODate, to: ISODate): ISODate[] {
  const out: ISODate[] = [];
  for (let n = dayNumber(from); n <= dayNumber(to); n++) out.push(fromDayNumber(n));
  return out;
}

/** First date on/after `from` that falls on ISO weekday `weekday`. */
export function nextWeekdayOnOrAfter(from: ISODate, weekday: number): ISODate {
  const delta = (weekday - weekdayISO(from) + 7) % 7;
  return addDays(from, delta);
}

/** ISO week key of the form "2026-W47" (Monday-based, week containing Thursday). */
export function isoWeekKey(iso: ISODate): string {
  const thursday = addDays(startOfWeek(iso), 3);
  const { y } = parseISODate(thursday);
  const jan1 = makeISODate(y, 1, 1);
  const week = Math.floor(diffDays(thursday, jan1) / 7) + 1;
  return `${y}-W${String(week).padStart(2, '0')}`;
}

export function hmToMin(hm: HM): number {
  const m = HM_RE.exec(hm);
  if (!m) throw new Error(`Invalid time: ${hm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function minToHM(min: number): HM {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function addMinutes(hm: HM, delta: number): HM {
  return minToHM(hmToMin(hm) + delta);
}

export function toLocalDateTime(date: ISODate, time: HM): LocalDateTime {
  return `${date}T${time}`;
}

export function splitLocalDateTime(dt: LocalDateTime): { date: ISODate; time: HM } {
  const [date, time] = dt.split('T');
  return { date: date as ISODate, time: (time ?? '00:00').slice(0, 5) };
}

/** Local "now" as floating date and time (uses the device time zone, like the user's wall clock). */
export function localNow(now: Date = new Date()): LocalDateTime {
  return `${makeISODate(now.getFullYear(), now.getMonth() + 1, now.getDate())}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

export function todayISO(now: Date = new Date()): ISODate {
  return localNow(now).slice(0, 10);
}

/** Interpret a floating local date-time as an instant in the device time zone. */
export function localToDate(dt: LocalDateTime): Date {
  const { date, time } = splitLocalDateTime(dt);
  const { y, m, d } = parseISODate(date);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

export function dateToLocalDateTime(d: Date): LocalDateTime {
  return localNow(d);
}

export function durationMinutes(startTime: HM, endTime: HM): number {
  return hmToMin(endTime) - hmToMin(startTime);
}

// ---------------------------------------------------------------- formatting (Italian)

export function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/** "Venerdì 20 novembre" */
export function formatDayLong(iso: ISODate): string {
  const { m, d } = parseISODate(iso);
  return `${capitalize(WEEKDAYS_IT[weekdayISO(iso) - 1])} ${d} ${MONTHS_IT[m - 1]}`;
}

/** "venerdì 20 novembre" */
export function formatDayLongLower(iso: ISODate): string {
  const { m, d } = parseISODate(iso);
  return `${WEEKDAYS_IT[weekdayISO(iso) - 1]} ${d} ${MONTHS_IT[m - 1]}`;
}

/** "ven 20 nov" */
export function formatDayShort(iso: ISODate): string {
  const { m, d } = parseISODate(iso);
  return `${WEEKDAYS_SHORT_IT[weekdayISO(iso) - 1]} ${d} ${MONTHS_SHORT_IT[m - 1]}`;
}

/** "20 nov 2026" */
export function formatDateMedium(iso: ISODate): string {
  const { y, m, d } = parseISODate(iso);
  return `${d} ${MONTHS_SHORT_IT[m - 1]} ${y}`;
}

/** "novembre 2026" */
export function formatMonthYear(iso: ISODate): string {
  const { y, m } = parseISODate(iso);
  return `${MONTHS_IT[m - 1]} ${y}`;
}

export function formatNumberIT(x: number, decimals = 2): string {
  if (!Number.isFinite(x)) return '–';
  return roundTo(x, decimals).toFixed(decimals).replace('.', ',');
}

/** Round half away from zero without binary floating-point surprises (e.g. 1.005 -> 1.01). */
export function roundTo(x: number, decimals: number): number {
  const sign = x < 0 ? -1 : 1;
  const factor = 10 ** decimals;
  const shifted = Number((Math.abs(x) * factor).toPrecision(15));
  return (sign * Math.round(shifted)) / factor;
}
