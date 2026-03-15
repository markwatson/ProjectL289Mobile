import { TIMEZONE_DB, isDstActive, computeDstEvents, getDstRule } from '../timezones';

describe('TIMEZONE_DB', () => {
  test('contains expected entries', () => {
    const ids = TIMEZONE_DB.map(t => t.id);
    expect(ids).toContain('UTC');
    expect(ids).toContain('America/New_York');
    expect(ids).toContain('Europe/London');
    expect(ids).toContain('Asia/Tokyo');
    expect(ids).toContain('Australia/Sydney');
  });

  test('all entries have valid fields', () => {
    for (const tz of TIMEZONE_DB) {
      expect(tz.id.length).toBeGreaterThan(0);
      expect(tz.label.length).toBeGreaterThan(0);
      expect(tz.shiftHours).toBeGreaterThanOrEqual(-12);
      expect(tz.shiftHours).toBeLessThanOrEqual(15);
      expect([0, 1, 2]).toContain(tz.minuteShift);
      expect([0, 1]).toContain(tz.hemisphere);
    }
  });
});

describe('getDstRule', () => {
  test('returns rule for known codes', () => {
    expect(getDstRule(1)).toBeDefined();
    expect(getDstRule(9)).toBeDefined();
  });

  test('returns undefined for code 0 (no DST)', () => {
    expect(getDstRule(0)).toBeUndefined();
  });
});

describe('isDstActive', () => {
  const ny = TIMEZONE_DB.find(t => t.id === 'America/New_York')!;
  const tokyo = TIMEZONE_DB.find(t => t.id === 'Asia/Tokyo')!;

  test('DST is active in New York in July', () => {
    const july = new Date(Date.UTC(2026, 6, 15, 12, 0, 0)); // July 15
    expect(isDstActive(ny, july)).toBe(true);
  });

  test('DST is not active in New York in January', () => {
    const jan = new Date(Date.UTC(2026, 0, 15, 12, 0, 0)); // Jan 15
    expect(isDstActive(ny, jan)).toBe(false);
  });

  test('Tokyo never has DST', () => {
    const july = new Date(Date.UTC(2026, 6, 15, 12, 0, 0));
    expect(isDstActive(tokyo, july)).toBe(false);
  });

  test('Sydney DST is active in January (southern hemisphere)', () => {
    const sydney = TIMEZONE_DB.find(t => t.id === 'Australia/Sydney')!;
    const jan = new Date(Date.UTC(2026, 0, 15, 0, 0, 0)); // Jan 15
    expect(isDstActive(sydney, jan)).toBe(true);
  });

  test('Sydney DST is not active in July', () => {
    const sydney = TIMEZONE_DB.find(t => t.id === 'Australia/Sydney')!;
    const july = new Date(Date.UTC(2026, 6, 15, 0, 0, 0));
    expect(isDstActive(sydney, july)).toBe(false);
  });
});

describe('computeDstEvents', () => {
  test('returns null for non-DST timezone', () => {
    const tokyo = TIMEZONE_DB.find(t => t.id === 'Asia/Tokyo')!;
    expect(computeDstEvents(tokyo, new Date())).toBeNull();
  });

  test('returns summer and winter events for DST timezone', () => {
    const ny = TIMEZONE_DB.find(t => t.id === 'America/New_York')!;
    const events = computeDstEvents(ny, new Date(Date.UTC(2026, 0, 1)));

    expect(events).not.toBeNull();
    expect(events!.summer.season).toBe(0);
    expect(events!.summer.month).toBe(3); // March
    expect(events!.winter.season).toBe(1);
    expect(events!.winter.month).toBe(11); // November
  });

  test('North America 2026: 2nd Sun Mar = Mar 8, 1st Sun Nov = Nov 1', () => {
    const ny = TIMEZONE_DB.find(t => t.id === 'America/New_York')!;
    const events = computeDstEvents(ny, new Date(Date.UTC(2026, 0, 1)));

    expect(events!.summer.day).toBe(8);  // 2nd Sunday of March 2026
    expect(events!.winter.day).toBe(1);  // 1st Sunday of November 2026
  });

  test('EU 2026: Last Sun Mar = Mar 29, Last Sun Oct = Oct 25', () => {
    const paris = TIMEZONE_DB.find(t => t.id === 'Europe/Paris')!;
    const events = computeDstEvents(paris, new Date(Date.UTC(2026, 0, 1)));

    expect(events!.summer.day).toBe(29); // Last Sunday of March 2026
    expect(events!.winter.day).toBe(25); // Last Sunday of October 2026
  });
});
