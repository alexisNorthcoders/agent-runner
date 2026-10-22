/** Narrowing `unknown` values at a boundary: parsed JSON and caught errors. */

export const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

export const stringOrNull = (v: unknown) => (typeof v === 'string' ? v : null);

export const numberOrNull = (v: unknown) => (typeof v === 'number' ? v : null);

/** `v` when it is an object, else `{}`: for reading optional fields of untrusted JSON. */
export const recordOrEmpty = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});

/** `raw` parsed as a JSON object, or null when it isn't JSON or isn't an object. */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(raw);
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

/** A caught value's non-blank message, else an Error's name, else the value itself, as text. Never throws. */
export function errorText(err: unknown): string {
  if (err instanceof Error) return typeof err.message === 'string' && err.message.trim() ? err.message : err.name || 'Error';
  if (isRecord(err) && typeof err.message === 'string' && err.message.trim()) return err.message;
  try {
    return String(err);
  } catch {
    return 'Unknown error';
  }
}
