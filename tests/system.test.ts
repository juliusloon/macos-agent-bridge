import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemClock, systemStatus } from '../mcp-server/src/adapters/system.js';
import { byName } from '../shared/registry.js';
import AjvModule from 'ajv';

test('host clock reports the local calendar date across the UTC date boundary without epoch arithmetic', () => {
  const now = new Date('2026-10-21T20:00:01.123Z');
  assert.deepEqual(systemClock(now, 'Asia/Shanghai'), {
    currentTime: '2026-10-21T20:00:01.123Z', localTime: '2026-10-22T04:00:01.123+08:00',
    localDate: '2026-10-22', timezone: 'Asia/Shanghai', utcOffsetMinutes: 480, unixTimeMs: now.getTime(),
  });
});

test('host clock handles DST, fractional-hour offsets and UTC midnight', () => {
  for (const [instant, timezone, localTime, offset] of [
    ['2026-11-01T05:30:00.000Z', 'America/New_York', '2026-11-01T01:30:00.000-04:00', -240],
    ['2026-11-01T06:30:00.000Z', 'America/New_York', '2026-11-01T01:30:00.000-05:00', -300],
    ['2026-10-21T20:00:00.000Z', 'Asia/Kathmandu', '2026-10-22T01:45:00.000+05:45', 345],
    ['2026-10-22T00:00:00.000Z', 'UTC', '2026-10-22T00:00:00.000+00:00', 0],
  ] as const) {
    const clock = systemClock(new Date(instant), timezone);
    assert.equal(clock.localTime, localTime); assert.equal(clock.utcOffsetMinutes, offset);
    assert.equal(Date.parse(clock.localTime), Date.parse(instant));
  }
});

test('system status returns a fresh host clock and matches the complete tool output contract', () => {
  const before = Date.now(); const data = systemStatus(); const after = Date.now();
  assert.ok(data.unixTimeMs >= before && data.unixTimeMs <= after);
  assert.equal(Date.parse(data.currentTime), data.unixTimeMs); assert.equal(Date.parse(data.localTime), data.unixTimeMs);
  assert.equal(data.localDate, data.localTime.slice(0, 10)); assert.ok(data.uptimeSeconds > 0);
  const validate = new AjvModule.default({ strict: false }).compile(byName.get('system_status')!.outputSchema);
  assert.ok(validate({ status: 'ok', tool: 'system_status', version: '1.0.0', data, error: null }), JSON.stringify(validate.errors));
});
