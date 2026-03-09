// VHP GMT Flash Protocol Encoder
// Implements the L289.2 Watch Optical Protocol (WOP) message encoding

// --- Opcodes ---
export const Opcode = {
  TZ_TIME_DATE_T1: 57,
  TZ_TIME_DATE_T2: 58,
  DST_DATE_TIME_SW_T1: 59,
  DST_DATE_TIME_SW_T2: 60,
} as const;

// --- Bit utilities ---

/** Convert an integer to an MSB-first bit array of the given width. */
export function toBitArray(value: number, width: number): number[] {
  const bits: number[] = [];
  for (let i = width - 1; i >= 0; i--) {
    bits.push((value >>> i) & 1);
  }
  return bits;
}

/** Convert a signed integer to two's complement bit array of the given width. */
function toSignedBitArray(value: number, width: number): number[] {
  if (value < 0) {
    value = (1 << width) + value;
  }
  return toBitArray(value, width);
}

// --- Message field encoders ---

export function encodeTime(hour: number, minute: number, second: number): number[] {
  return [
    ...toBitArray(hour, 5),
    ...toBitArray(minute, 6),
    ...toBitArray(second, 6),
  ];
}

export function encodeDate(year: number, month: number, day: number): number[] {
  // year is offset from 2000
  const y = year >= 2000 ? year - 2000 : year;
  return [
    ...toBitArray(y, 7),
    ...toBitArray(month, 4),
    ...toBitArray(day, 5),
  ];
}

export function encodeTimezone(
  shiftHours: number,
  minuteShift: number, // 0=none, 1=+30min, 2=+45min
  hemisphere: number,  // 0=North, 1=South
): number[] {
  // Timezone shift is encoded MSB-first, same as all other fields (ByteUtil.toByteArray)
  const shiftBits = toSignedBitArray(shiftHours, 5);
  return [
    ...shiftBits,
    ...toBitArray(minuteShift, 2),
    ...toBitArray(hemisphere, 1),
  ];
}

export function encodeDstDateTime(
  season: number, // 0=summer(start), 1=winter(end)
  month: number,
  day: number,
  hour: number,
): number[] {
  return [
    ...toBitArray(season, 1),
    ...toBitArray(month, 4),
    ...toBitArray(day, 5),
    ...toBitArray(hour, 5),
  ];
}

// --- Header ---

const HEADER_BITS = [1, 1, 1, 0, 1, 0, 1, 0];

// --- CRC-8 ---

/** CRC-8 with polynomial 0x107 (x^8 + x^2 + x + 1), computed over a bit array. */
export function crc8(bits: number[]): number[] {
  const poly = [1, 0, 0, 0, 0, 0, 1, 1, 1]; // 0x107
  const reg = [...bits, 0, 0, 0, 0, 0, 0, 0, 0]; // append 8 zero bits

  for (let i = 0; i < bits.length; i++) {
    if (reg[i] === 1) {
      for (let j = 0; j < poly.length; j++) {
        reg[i + j] = (reg[i + j]! ^ poly[j]!);
      }
    }
  }

  return reg.slice(bits.length); // last 8 bits are the CRC
}

// --- Bit stuffing ---

/** Insert opposite bit after 5 consecutive same-value bits. */
export function addStuffBits(bits: number[]): number[] {
  const result: number[] = [];
  let consecutiveCount = 0;
  let lastBit = -1;

  for (const bit of bits) {
    result.push(bit);
    if (bit === lastBit) {
      consecutiveCount++;
    } else {
      consecutiveCount = 1;
      lastBit = bit;
    }
    if (consecutiveCount === 5) {
      const stuffBit = bit === 1 ? 0 : 1;
      result.push(stuffBit);
      consecutiveCount = 1;
      lastBit = stuffBit;
    }
  }

  return result;
}

// --- MultiMessage assembly ---

export interface TimezoneInfo {
  shiftHours: number;
  minuteShift: number; // 0, 1 (+30min), 2 (+45min)
  hemisphere: number;  // 0=North, 1=South
  dstActive: boolean;
}

export interface DstEvent {
  season: number; // 0=summer, 1=winter
  month: number;
  day: number;
  hour: number;
}

export interface TransmitParams {
  targetTimezone: 'T1' | 'T2';
  utcTime: Date;
  tz: TimezoneInfo;
  dstSummer?: DstEvent; // DST start event
  dstWinter?: DstEvent; // DST end event
}

/**
 * Assemble a complete MultiMessage frame (pre-stuffing bit array).
 * Returns the payload bits (without header) for CRC, then the full frame.
 */
export function assembleFrame(params: TransmitParams): number[] {
  const { targetTimezone, utcTime, tz, dstSummer, dstWinter } = params;

  // Time is always transmitted as UTC (spec section 2.8)
  const hour = utcTime.getUTCHours();
  const minute = utcTime.getUTCMinutes();
  const second = utcTime.getUTCSeconds();
  const year = utcTime.getUTCFullYear();
  const month = utcTime.getUTCMonth() + 1;
  const day = utcTime.getUTCDate();

  const hasDst = dstSummer != null && dstWinter != null;
  const numMessages = hasDst ? 2 : 1;

  const isT1 = targetTimezone === 'T1';
  const tzTimeDateOpcode = isT1 ? Opcode.TZ_TIME_DATE_T1 : Opcode.TZ_TIME_DATE_T2;

  // Build payload (everything after header, before CRC)
  const payload: number[] = [];

  // Length field (4 bits)
  payload.push(...toBitArray(numMessages, 4));

  // Sub-message 1: TZ_TIME_DATE
  payload.push(...toBitArray(tzTimeDateOpcode, 8));

  // If DST is active, shift is incremented by 1 per spec note
  const effectiveShift = tz.dstActive ? tz.shiftHours + 1 : tz.shiftHours;
  payload.push(...encodeTimezone(effectiveShift, tz.minuteShift, tz.hemisphere));
  payload.push(...encodeTime(hour, minute, second));
  payload.push(...encodeDate(year, month, day));

  // Sub-message 2: DST_DATE_TIME_SUMMER_WINTER (if applicable)
  if (hasDst) {
    const dstOpcode = isT1 ? Opcode.DST_DATE_TIME_SW_T1 : Opcode.DST_DATE_TIME_SW_T2;
    payload.push(...toBitArray(dstOpcode, 8));
    payload.push(...encodeDstDateTime(dstSummer.season, dstSummer.month, dstSummer.day, dstSummer.hour));
    payload.push(...encodeDstDateTime(dstWinter.season, dstWinter.month, dstWinter.day, dstWinter.hour));
  }

  // CRC over payload
  const crcBits = crc8(payload);

  // Full frame: header + payload + CRC
  const frame = [...HEADER_BITS, ...payload, ...crcBits];

  return frame;
}

/**
 * Build the complete transmission bitstream: frame → stuff bits → trailing zeros.
 */
export function buildBitstream(params: TransmitParams): number[] {
  const frame = assembleFrame(params);
  const stuffed = addStuffBits(frame);
  // Append 2 trailing zeros
  stuffed.push(0, 0);
  return stuffed;
}

/**
 * Build a bitstream with time pre-compensation, matching the Android's
 * TimeMessageAutoAdjustUtc + getMessageDelay() approach.
 *
 * 1. Estimate total transmission duration (overhead + bits × period)
 * 2. Find the next second boundary after (now + duration)
 * 3. Encode the UTC time at that boundary
 * 4. Return a messageDelayMs: how long to wait before starting transmission
 *    so that the last bit lands exactly on that second boundary
 *
 * @param preTransmitOverheadMs Fixed delay before payload begins (e.g. wake-up pulse + gap)
 */
export function buildCompensatedBitstream(
  params: TransmitParams,
  bitPeriodMs: number,
  preTransmitOverheadMs: number = 0,
): { bitstream: number[]; messageDelayMs: number } {
  const now = params.utcTime.getTime();

  // First pass: build to get approximate length
  const trial = buildBitstream(params);
  const estimatedDurationMs = preTransmitOverheadMs + trial.length * bitPeriodMs;

  // Find next second boundary after transmission would end
  const futureMs = now + estimatedDurationMs;
  const targetMs = futureMs + (1000 - (futureMs % 1000));

  // Encode the time at the target second boundary
  const adjustedUtc = new Date(targetMs);
  const adjustedParams = { ...params, utcTime: adjustedUtc };

  // Rebuild with adjusted time (bit count may differ slightly due to stuffing)
  const bitstream = buildBitstream(adjustedParams);

  // Delay before starting so transmission ends at targetMs
  const messageDelayMs = Math.max(0, Math.min(1000, targetMs - now - (preTransmitOverheadMs + bitstream.length * bitPeriodMs)));

  return { bitstream, messageDelayMs };
}
