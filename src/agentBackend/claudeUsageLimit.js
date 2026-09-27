/**
 * Claude's usage-limit message, e.g. `You've hit your session limit · resets 7am (Europe/London)`,
 * turned into the neutral `AgentUsageLimit` (./index.js): when runs may start again. A reset epoch
 * from the stream's rate-limit event wins over the text. The reset gets a small buffer and is
 * capped; text that can't be read gives a short pause, so the next run acts as a probe.
 */

export const RESET_BUFFER_MS = 2 * 60_000;
export const FALLBACK_PAUSE_MS = 60 * 60_000;
export const MAX_PAUSE_MS = 7 * 24 * 60 * 60_000;

const RESETS_RE = /\bresets\s+(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:\(([^)]+)\))?/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_MS = 24 * 60 * 60_000;

/** @param {string} tz */
function validZone(tz) {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of instant `ms` in `tz`. @param {number} ms @param {string} tz */
function zonedParts(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(ms);
  /** @param {string} type */
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

/** How far `tz` is ahead of UTC at instant `ms`. @param {number} ms @param {string} tz */
function zoneOffset(ms, tz) {
  const p = zonedParts(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant a wall-clock time in `tz` happens (the day may overflow, e.g. the 32nd).
 * @param {{ year: number, month: number, day: number, hour: number, minute: number }} t `month` is 1-based
 * @param {string} tz
 */
function zonedInstant({ year, month, day, hour, minute }, tz) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const guess = wall - zoneOffset(wall, tz);
  // the offset at the guess can differ from the one at `wall` across a DST change
  return wall - zoneOffset(guess, tz);
}

/**
 * The next instant the `resets …` text names, or null when it can't be read.
 * @param {string} text
 * @param {number} now
 * @returns {{ at: number, note: string, timeZone: string } | null}
 */
function parseResetText(text, now) {
  const m = RESETS_RE.exec(text);
  if (!m) return null;
  const [, mon, dayStr, hourStr, minStr, ampm, zoneStr] = m;
  const tz = zoneStr?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!validZone(tz)) return null;
  const h12 = Number(hourStr);
  const minute = minStr ? Number(minStr) : 0;
  if (h12 < 1 || h12 > 12 || minute > 59) return null;
  const hour = (h12 % 12) + (ampm.toLowerCase() === 'pm' ? 12 : 0);
  const today = zonedParts(now, tz);
  const when = `${mon ? `${mon} ${dayStr}, ` : ''}${hourStr}${minStr ? `:${minStr}` : ''}${ampm}`;
  const note = `resets ${when} ${tz}`;

  if (mon) {
    const month = MONTHS.indexOf(mon.toLowerCase()) + 1;
    const day = Number(dayStr);
    if (!month || day < 1 || day > 31) return null;
    let at = zonedInstant({ year: today.year, month, day, hour, minute }, tz);
    // a date well in the past is next year's (said in late December about early January)
    if (at < now - 180 * DAY_MS) at = zonedInstant({ year: today.year + 1, month, day, hour, minute }, tz);
    return { at, note, timeZone: tz };
  }
  let at = zonedInstant({ ...today, hour, minute }, tz);
  if (at <= now) at = zonedInstant({ ...today, day: today.day + 1, hour, minute }, tz);
  return { at, note, timeZone: tz };
}

/**
 * When runs may start again after the usage-limit message `text`: `resetsAtEpoch` (seconds or ms,
 * from the stream) if given, else the text's reset time, plus the buffer, capped at 7 days. Text
 * that can't be read gives a 1h pause.
 * @param {{ text: string, resetsAtEpoch?: number | null, now: number }} p
 * @returns {import('./index.js').AgentUsageLimit}
 */
export function usageLimitFrom({ text, resetsAtEpoch = null, now }) {
  const parsed = parseResetText(String(text ?? ''), now);
  const epochMs = resetsAtEpoch && resetsAtEpoch > 0 ? (resetsAtEpoch < 1e12 ? resetsAtEpoch * 1000 : resetsAtEpoch) : null;
  const reset = epochMs ?? parsed?.at ?? null;
  const at = reset == null ? now + FALLBACK_PAUSE_MS : Math.min(Math.max(reset, now) + RESET_BUFFER_MS, now + MAX_PAUSE_MS);
  return { resetsAt: new Date(at).toISOString(), note: parsed?.note ?? null, timeZone: parsed?.timeZone ?? null };
}
