// Timezone database for VHP GMT Flash Protocol
// Maps IANA timezone IDs to watch protocol parameters

export interface TimezoneEntry {
  id: string;           // IANA timezone ID
  label: string;        // Display name
  shiftHours: number;   // UTC offset in hours (base, without DST)
  minuteShift: number;  // 0=none, 1=+30min, 2=+45min
  hemisphere: number;   // 0=North, 1=South
  dstCode: number;      // DST rule code from Appendix A (0 = no DST)
}

// DST rule definitions: how to compute summer/winter transition dates
export interface DstRule {
  code: number;
  summerMonth: number;
  summerDay: (year: number) => number; // returns day of month
  summerHour: number;
  winterMonth: number;
  winterDay: (year: number) => number;
  winterHour: number;
}

// Helper: find the Nth occurrence of a weekday in a month
// weekday: 0=Sunday, 1=Monday, ...
function nthWeekday(year: number, month: number, weekday: number, n: number): number {
  const first = new Date(Date.UTC(year, month - 1, 1));
  let dayOfWeek = first.getUTCDay();
  let diff = (weekday - dayOfWeek + 7) % 7;
  return 1 + diff + (n - 1) * 7;
}

// Helper: find the last occurrence of a weekday in a month
function lastWeekday(year: number, month: number, weekday: number): number {
  const last = new Date(Date.UTC(year, month, 0)); // last day of month
  let dayOfWeek = last.getUTCDay();
  let diff = (dayOfWeek - weekday + 7) % 7;
  return last.getUTCDate() - diff;
}

export const DST_RULES: DstRule[] = [
  // Code 1: EU (CET/CEST) - Last Sun Mar -> Last Sun Oct
  {
    code: 1,
    summerMonth: 3, summerDay: (y) => lastWeekday(y, 3, 0), summerHour: 2,
    winterMonth: 10, winterDay: (y) => lastWeekday(y, 10, 0), winterHour: 3,
  },
  // Code 9: North America - 2nd Sun Mar -> 1st Sun Nov
  {
    code: 9,
    summerMonth: 3, summerDay: (y) => nthWeekday(y, 3, 0, 2), summerHour: 2,
    winterMonth: 11, winterDay: (y) => nthWeekday(y, 11, 0, 1), winterHour: 2,
  },
  // Code 14: Australia (south) - 1st Sun Oct -> 1st Sun Apr
  {
    code: 14,
    summerMonth: 10, summerDay: (y) => nthWeekday(y, 10, 0, 1), summerHour: 2,
    winterMonth: 4, winterDay: (y) => nthWeekday(y, 4, 0, 1), winterHour: 3,
  },
  // Code 16: New Zealand - Last Sun Sep -> 1st Sun Apr
  {
    code: 16,
    summerMonth: 9, summerDay: (y) => lastWeekday(y, 9, 0), summerHour: 2,
    winterMonth: 4, winterDay: (y) => nthWeekday(y, 4, 0, 1), winterHour: 3,
  },
  // Code 20: UK/Ireland (WET/WEST) - Last Sun Mar -> Last Sun Oct
  {
    code: 20,
    summerMonth: 3, summerDay: (y) => lastWeekday(y, 3, 0), summerHour: 1,
    winterMonth: 10, winterDay: (y) => lastWeekday(y, 10, 0), winterHour: 2,
  },
  // Code 21: EET (Eastern Europe) - Last Sun Mar -> Last Sun Oct
  {
    code: 21,
    summerMonth: 3, summerDay: (y) => lastWeekday(y, 3, 0), summerHour: 3,
    winterMonth: 10, winterDay: (y) => lastWeekday(y, 10, 0), winterHour: 4,
  },
];

export function getDstRule(code: number): DstRule | undefined {
  return DST_RULES.find(r => r.code === code);
}

/** Check if DST is currently active for a given timezone entry and UTC time. */
export function isDstActive(entry: TimezoneEntry, utcTime: Date): boolean {
  const rule = getDstRule(entry.dstCode);
  if (!rule) return false;

  const year = utcTime.getUTCFullYear();
  const offsetMs = (entry.shiftHours * 60 + [0, 30, 45][entry.minuteShift]!) * 60 * 1000;
  const localTime = new Date(utcTime.getTime() + offsetMs);

  const summerStart = Date.UTC(year, rule.summerMonth - 1, rule.summerDay(year), rule.summerHour);
  const winterStart = Date.UTC(year, rule.winterMonth - 1, rule.winterDay(year), rule.winterHour);

  const localMs = localTime.getTime();

  if (entry.hemisphere === 0) {
    // Northern hemisphere: DST active between summer start and winter start
    return localMs >= summerStart && localMs < winterStart;
  } else {
    // Southern hemisphere: DST active outside winter->summer range
    return localMs >= summerStart || localMs < winterStart;
  }
}

/** Compute DST events for the current year. */
export function computeDstEvents(entry: TimezoneEntry, utcTime: Date) {
  const rule = getDstRule(entry.dstCode);
  if (!rule) return null;

  const year = utcTime.getUTCFullYear();

  return {
    summer: {
      season: 0 as const,
      month: rule.summerMonth,
      day: rule.summerDay(year),
      hour: rule.summerHour,
    },
    winter: {
      season: 1 as const,
      month: rule.winterMonth,
      day: rule.winterDay(year),
      hour: rule.winterHour,
    },
  };
}

// Common timezone database
export const TIMEZONE_DB: TimezoneEntry[] = [
  // UTC
  { id: 'UTC', label: 'UTC', shiftHours: 0, minuteShift: 0, hemisphere: 0, dstCode: 0 },

  // Europe
  { id: 'Europe/London', label: 'London (GMT/BST)', shiftHours: 0, minuteShift: 0, hemisphere: 0, dstCode: 20 },
  { id: 'Europe/Paris', label: 'Paris (CET/CEST)', shiftHours: 1, minuteShift: 0, hemisphere: 0, dstCode: 1 },
  { id: 'Europe/Berlin', label: 'Berlin (CET/CEST)', shiftHours: 1, minuteShift: 0, hemisphere: 0, dstCode: 1 },
  { id: 'Europe/Rome', label: 'Rome (CET/CEST)', shiftHours: 1, minuteShift: 0, hemisphere: 0, dstCode: 1 },
  { id: 'Europe/Madrid', label: 'Madrid (CET/CEST)', shiftHours: 1, minuteShift: 0, hemisphere: 0, dstCode: 1 },
  { id: 'Europe/Zurich', label: 'Zurich (CET/CEST)', shiftHours: 1, minuteShift: 0, hemisphere: 0, dstCode: 1 },
  { id: 'Europe/Athens', label: 'Athens (EET/EEST)', shiftHours: 2, minuteShift: 0, hemisphere: 0, dstCode: 21 },
  { id: 'Europe/Helsinki', label: 'Helsinki (EET/EEST)', shiftHours: 2, minuteShift: 0, hemisphere: 0, dstCode: 21 },
  { id: 'Europe/Moscow', label: 'Moscow (MSK)', shiftHours: 3, minuteShift: 0, hemisphere: 0, dstCode: 0 },

  // Americas
  { id: 'America/New_York', label: 'New York (ET)', shiftHours: -5, minuteShift: 0, hemisphere: 0, dstCode: 9 },
  { id: 'America/Chicago', label: 'Chicago (CT)', shiftHours: -6, minuteShift: 0, hemisphere: 0, dstCode: 9 },
  { id: 'America/Denver', label: 'Denver (MT)', shiftHours: -7, minuteShift: 0, hemisphere: 0, dstCode: 9 },
  { id: 'America/Los_Angeles', label: 'Los Angeles (PT)', shiftHours: -8, minuteShift: 0, hemisphere: 0, dstCode: 9 },
  { id: 'America/Anchorage', label: 'Anchorage (AKT)', shiftHours: -9, minuteShift: 0, hemisphere: 0, dstCode: 9 },
  { id: 'Pacific/Honolulu', label: 'Honolulu (HST)', shiftHours: -10, minuteShift: 0, hemisphere: 0, dstCode: 0 },
  { id: 'America/Phoenix', label: 'Phoenix (MST)', shiftHours: -7, minuteShift: 0, hemisphere: 0, dstCode: 0 },
  { id: 'America/Toronto', label: 'Toronto (ET)', shiftHours: -5, minuteShift: 0, hemisphere: 0, dstCode: 9 },
  { id: 'America/Vancouver', label: 'Vancouver (PT)', shiftHours: -8, minuteShift: 0, hemisphere: 0, dstCode: 9 },

  // Asia
  { id: 'Asia/Tokyo', label: 'Tokyo (JST)', shiftHours: 9, minuteShift: 0, hemisphere: 0, dstCode: 0 },
  { id: 'Asia/Shanghai', label: 'Shanghai (CST)', shiftHours: 8, minuteShift: 0, hemisphere: 0, dstCode: 0 },
  { id: 'Asia/Hong_Kong', label: 'Hong Kong (HKT)', shiftHours: 8, minuteShift: 0, hemisphere: 0, dstCode: 0 },
  { id: 'Asia/Singapore', label: 'Singapore (SGT)', shiftHours: 8, minuteShift: 0, hemisphere: 0, dstCode: 0 },
  { id: 'Asia/Dubai', label: 'Dubai (GST)', shiftHours: 4, minuteShift: 0, hemisphere: 0, dstCode: 0 },
  { id: 'Asia/Kolkata', label: 'Kolkata (IST)', shiftHours: 5, minuteShift: 1, hemisphere: 0, dstCode: 0 },
  { id: 'Asia/Kathmandu', label: 'Kathmandu (NPT)', shiftHours: 5, minuteShift: 2, hemisphere: 0, dstCode: 0 },
  { id: 'Asia/Seoul', label: 'Seoul (KST)', shiftHours: 9, minuteShift: 0, hemisphere: 0, dstCode: 0 },
  { id: 'Asia/Bangkok', label: 'Bangkok (ICT)', shiftHours: 7, minuteShift: 0, hemisphere: 0, dstCode: 0 },

  // Oceania
  { id: 'Australia/Sydney', label: 'Sydney (AEST/AEDT)', shiftHours: 10, minuteShift: 0, hemisphere: 1, dstCode: 14 },
  { id: 'Australia/Melbourne', label: 'Melbourne (AEST/AEDT)', shiftHours: 10, minuteShift: 0, hemisphere: 1, dstCode: 14 },
  { id: 'Australia/Perth', label: 'Perth (AWST)', shiftHours: 8, minuteShift: 0, hemisphere: 1, dstCode: 0 },
  { id: 'Australia/Adelaide', label: 'Adelaide (ACST/ACDT)', shiftHours: 9, minuteShift: 1, hemisphere: 1, dstCode: 14 },
  { id: 'Pacific/Auckland', label: 'Auckland (NZST/NZDT)', shiftHours: 12, minuteShift: 0, hemisphere: 1, dstCode: 16 },

  // Other
  { id: 'Africa/Johannesburg', label: 'Johannesburg (SAST)', shiftHours: 2, minuteShift: 0, hemisphere: 1, dstCode: 0 },
  { id: 'America/Sao_Paulo', label: 'Sao Paulo (BRT)', shiftHours: -3, minuteShift: 0, hemisphere: 1, dstCode: 0 },
  { id: 'America/Argentina/Buenos_Aires', label: 'Buenos Aires (ART)', shiftHours: -3, minuteShift: 0, hemisphere: 1, dstCode: 0 },
];
