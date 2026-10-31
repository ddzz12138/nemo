const ZONE = 'Australia/Sydney';

export function sydneyParts(instant) {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid time.');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-AU', {
    timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(part => [part.type, part.value]));
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, date: `${parts.year}${parts.month}${parts.day}`, time: `${parts.hour}${parts.minute}`, zone: ZONE };
}

export function formatSydney(instant) {
  return new Intl.DateTimeFormat('en-AU', { timeZone: ZONE, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(instant));
}
