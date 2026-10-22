import { cpus, release, totalmem, type, uptime } from 'node:os';

/** Read the host clock locally, including calendar date and offset at this instant (DST aware). */
export function systemClock(now = new Date(), timezone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, calendar: 'gregory', numberingSystem: 'latn',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
  }).formatToParts(now);
  const value = (name: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === name)!.value;
  const offset = value('timeZoneName').replace('GMT', '') || '+00:00';
  const localDate = `${value('year')}-${value('month')}-${value('day')}`;
  const utcOffsetMinutes = (offset[0] === '-' ? -1 : 1) * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
  return {
    currentTime: now.toISOString(),
    localTime: `${localDate}T${value('hour')}:${value('minute')}:${value('second')}.${String(now.getUTCMilliseconds()).padStart(3, '0')}${offset}`,
    localDate, timezone, utcOffsetMinutes, unixTimeMs: now.getTime(),
  };
}

/** No Helper, permissions, shell or internet is needed to learn today's date. */
export function systemStatus() {
  return { os: `${type()} ${release()}`, uptimeSeconds: uptime(), processorCount: cpus().length, physicalMemoryBytes: totalmem(), ...systemClock() };
}
