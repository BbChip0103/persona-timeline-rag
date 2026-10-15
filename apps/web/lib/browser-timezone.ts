/** Intl supplies the browser's own timezone; API validation remains authoritative. */
export function browserTimezone():string {
  try {
    const zone=Intl.DateTimeFormat().resolvedOptions().timeZone;
    return /^(?:UTC|[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)+)$/u.test(zone)?zone:'UTC';
  } catch {return 'UTC';}
}
