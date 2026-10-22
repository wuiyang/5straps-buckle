/**
 * A moment on this device's clock, as a person at its terminal reads it (the CLI display slice): the process's TZ,
 * else the system's zone, through the Date getters, so no locale or ICU data is needed. Every stored time stays ISO
 * UTC; only what a person reads is converted.
 */
export function localTime(at: Date): string {
  return [at.getHours(), at.getMinutes(), at.getSeconds()].map(twoDigits).join(':')
}

/** The local date `localTime` belongs to, as `2026-10-21`. */
export function localDate(at: Date): string {
  return `${at.getFullYear()}-${twoDigits(at.getMonth() + 1)}-${twoDigits(at.getDate())}`
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0')
}
