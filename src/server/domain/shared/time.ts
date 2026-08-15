/**
 * Hours between now and the given ISO timestamp (negative if it's in the
 * past). Pure epoch-millisecond arithmetic — no timezone conversion, no
 * rounding beyond ordinary floating-point division. `now` defaults to the
 * current time but can be overridden, matching every existing call site
 * (none of which currently pass it explicitly).
 */
export function hoursUntil(iso: string, now = new Date()): number {
  return (new Date(iso).getTime() - now.getTime()) / 36e5;
}
