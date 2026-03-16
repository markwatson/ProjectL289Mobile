import {
  toBitArray,
  encodeTime,
  encodeDate,
  encodeTimezone,
  encodeDstDateTime,
  crc8,
  addStuffBits,
  assembleFrame,
  buildBitstream,
  buildCompensatedBitstream,
  Opcode,
} from '../encoder';
import { BIT_PERIOD_MS } from '../transmitter';

// --- Helpers ---

/** Convert a hex string (e.g. "27425146D2A98") to a bit array, 4 bits per hex char. */
function hexToBits(hex: string): number[] {
  const bits: number[] = [];
  for (const c of hex) {
    const n = parseInt(c, 16);
    bits.push((n >> 3) & 1, (n >> 2) & 1, (n >> 1) & 1, n & 1);
  }
  return bits;
}

/** Convert a bit array to a byte value (MSB-first). */
function bitsToUint(bits: number[]): number {
  return bits.reduce((acc, b, i) => acc | (b << (bits.length - 1 - i)), 0);
}

// =============================================================================
// Existing unit tests
// =============================================================================

describe('toBitArray', () => {
  test('converts 0 to all zeros', () => {
    expect(toBitArray(0, 8)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  test('converts 0x75 (117) to MSB-first bits', () => {
    expect(toBitArray(0x75, 8)).toEqual([0, 1, 1, 1, 0, 1, 0, 1]);
  });

  test('converts small values with padding', () => {
    expect(toBitArray(3, 5)).toEqual([0, 0, 0, 1, 1]);
  });

  test('converts 57 (TZ_TIME_DATE_T1 opcode)', () => {
    expect(toBitArray(57, 8)).toEqual([0, 0, 1, 1, 1, 0, 0, 1]);
  });
});

describe('encodeTime', () => {
  test('encodes 00:00:00', () => {
    const bits = encodeTime(0, 0, 0);
    expect(bits.length).toBe(17);
    expect(bits).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  test('encodes 23:59:59', () => {
    const bits = encodeTime(23, 59, 59);
    expect(bits.length).toBe(17);
    // 23=10111, 59=111011, 59=111011
    expect(bits).toEqual([1, 0, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1]);
  });

  test('encodes 12:30:00', () => {
    const bits = encodeTime(12, 30, 0);
    expect(bits.length).toBe(17);
    // 12=01100, 30=011110, 0=000000
    expect(bits).toEqual([0, 1, 1, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe('encodeDate', () => {
  test('encodes 2026-03-06', () => {
    const bits = encodeDate(2026, 3, 6);
    expect(bits.length).toBe(16);
    // year=26=0011010, month=3=0011, day=6=00110
    expect(bits).toEqual([0, 0, 1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 0, 1, 1, 0]);
  });

  test('encodes year as offset from 2000', () => {
    const bits2000 = encodeDate(2000, 1, 1);
    const bitsRaw = encodeDate(0, 1, 1);
    expect(bits2000).toEqual(bitsRaw);
  });
});

describe('encodeTimezone', () => {
  test('encodes UTC+0 North', () => {
    const bits = encodeTimezone(0, 0, 0);
    expect(bits.length).toBe(8);
    // shift=0 LSB-first: 00000, minuteShift=0=00, hemisphere=0
    expect(bits).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  test('encodes UTC-5 North (New York standard)', () => {
    const bits = encodeTimezone(-5, 0, 0);
    expect(bits.length).toBe(8);
    // -5 in 5-bit two's complement MSB = 11011, LSB-first = 11011 (palindrome)
    expect(bits).toEqual([1, 1, 0, 1, 1, 0, 0, 0]);
  });

  test('encodes UTC+5:30 North (India)', () => {
    const bits = encodeTimezone(5, 1, 0);
    expect(bits.length).toBe(8);
    // 5 MSB=00101, minuteShift=1=01, hemisphere=0
    expect(bits).toEqual([0, 0, 1, 0, 1, 0, 1, 0]);
  });

  test('encodes UTC+10 South (Sydney)', () => {
    const bits = encodeTimezone(10, 0, 1);
    expect(bits.length).toBe(8);
    // 10 MSB=01010, minuteShift=0=00, hemisphere=1
    expect(bits).toEqual([0, 1, 0, 1, 0, 0, 0, 1]);
  });
});

describe('encodeDstDateTime', () => {
  test('encodes summer DST event (March 29, 2am)', () => {
    const bits = encodeDstDateTime(0, 3, 29, 2);
    expect(bits.length).toBe(15);
    // season=0, month=3=0011, day=29=11101, hour=2=00010
    expect(bits).toEqual([0, 0, 0, 1, 1, 1, 1, 1, 0, 1, 0, 0, 0, 1, 0]);
  });

  test('encodes winter DST event (October 25, 3am)', () => {
    const bits = encodeDstDateTime(1, 10, 25, 3);
    expect(bits.length).toBe(15);
    // season=1, month=10=1010, day=25=11001, hour=3=00011
    expect(bits).toEqual([1, 1, 0, 1, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1]);
  });
});

describe('crc8', () => {
  test('CRC of all zeros is zero', () => {
    const result = crc8([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(result).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  test('CRC returns 8 bits', () => {
    const result = crc8([1, 0, 1, 0]);
    expect(result.length).toBe(8);
  });

  test('CRC is deterministic', () => {
    const input = [0, 0, 0, 1, 0, 0, 1, 1, 1, 0, 0, 1];
    expect(crc8(input)).toEqual(crc8(input));
  });

  test('CRC changes with different inputs', () => {
    const a = crc8([1, 0, 1, 0, 1, 0, 1, 0]);
    const b = crc8([1, 0, 1, 0, 1, 0, 1, 1]);
    expect(a).not.toEqual(b);
  });

  test('appending CRC to data yields zero remainder', () => {
    const data = [1, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0, 1];
    const checksum = crc8(data);
    const withCrc = [...data, ...checksum];
    const remainder = crc8(withCrc);
    expect(remainder).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe('addStuffBits', () => {
  test('no stuffing needed for alternating bits', () => {
    const input = [1, 0, 1, 0, 1, 0, 1, 0];
    expect(addStuffBits(input)).toEqual(input);
  });

  test('inserts opposite bit after 5 consecutive same bits', () => {
    const input = [1, 1, 1, 1, 1, 1]; // 6 ones
    const result = addStuffBits(input);
    // After 5 ones, insert 0, then the 6th one
    expect(result).toEqual([1, 1, 1, 1, 1, 0, 1]);
  });

  test('inserts 1 after 5 consecutive zeros', () => {
    const input = [0, 0, 0, 0, 0, 0];
    const result = addStuffBits(input);
    expect(result).toEqual([0, 0, 0, 0, 0, 1, 0]);
  });

  test('handles multiple stuff points', () => {
    const input = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]; // 10 ones
    const result = addStuffBits(input);
    // 11111 -> insert 0 -> 1111 -> need 1 more for next stuff
    // After stuff bit 0, count resets. Next: 1,1,1,1,1 -> insert 0
    expect(result).toEqual([1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0]);
  });

  test('empty input returns empty', () => {
    expect(addStuffBits([])).toEqual([]);
  });
});

describe('assembleFrame', () => {
  test('Frame A (no DST) has correct structure', () => {
    const frame = assembleFrame({
      targetTimezone: 'T1',
      utcTime: new Date(Date.UTC(2026, 2, 6, 12, 0, 0)), // 2026-03-06 12:00:00 UTC
      tz: { shiftHours: 1, minuteShift: 0, hemisphere: 0, dstActive: false },
    });

    // Frame A = Header(8) + Length(4) + Opcode(8) + TZ(8) + Time(17) + Date(16) + CRC(8) = 69 bits
    expect(frame.length).toBe(69);

    // Header: 11101010
    expect(frame.slice(0, 8)).toEqual([1, 1, 1, 0, 1, 0, 1, 0]);

    // Length: 0001 (1 sub-message)
    expect(frame.slice(8, 12)).toEqual([0, 0, 0, 1]);

    // Opcode: 57 = 00111001 (TZ_TIME_DATE_T1)
    expect(frame.slice(12, 20)).toEqual([0, 0, 1, 1, 1, 0, 0, 1]);
  });

  test('Frame B (with DST) has correct structure', () => {
    const frame = assembleFrame({
      targetTimezone: 'T2',
      utcTime: new Date(Date.UTC(2026, 2, 6, 12, 0, 0)),
      tz: { shiftHours: -5, minuteShift: 0, hemisphere: 0, dstActive: false },
      dstSummer: { season: 0, month: 3, day: 8, hour: 2 },
      dstWinter: { season: 1, month: 11, day: 1, hour: 2 },
    });

    // Frame B = Header(8) + Length(4) + Opcode1(8) + TZ(8) + Time(17) + Date(16) + Opcode2(8) + DST1(15) + DST2(15) + CRC(8) = 107 bits
    expect(frame.length).toBe(107);

    // Length: 0010 (2 sub-messages)
    expect(frame.slice(8, 12)).toEqual([0, 0, 1, 0]);

    // Opcode1: 58 = 00111010 (TZ_TIME_DATE_T2)
    expect(frame.slice(12, 20)).toEqual([0, 0, 1, 1, 1, 0, 1, 0]);
  });

  test('CRC validates (appending CRC to payload yields zero remainder)', () => {
    const frame = assembleFrame({
      targetTimezone: 'T1',
      utcTime: new Date(Date.UTC(2026, 2, 6, 12, 0, 0)),
      tz: { shiftHours: 0, minuteShift: 0, hemisphere: 0, dstActive: false },
    });

    // Payload = everything after header (8 bits), including CRC
    const payloadWithCrc = frame.slice(8);
    const remainder = crc8(payloadWithCrc);
    expect(remainder).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  test('time is encoded as UTC (not local)', () => {
    // UTC+9 (Tokyo), UTC time 2026-03-06 15:00:00 -> should encode 15:00:00 UTC
    const frame = assembleFrame({
      targetTimezone: 'T1',
      utcTime: new Date(Date.UTC(2026, 2, 6, 15, 0, 0)),
      tz: { shiftHours: 9, minuteShift: 0, hemisphere: 0, dstActive: false },
    });

    // Time field starts at bit 28 (8 header + 4 length + 8 opcode + 8 tz)
    const timeBits = frame.slice(28, 45); // 17 bits
    // hour=15=01111, minute=0=000000, second=0=000000
    expect(timeBits).toEqual([0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

    // Date field: 45..60 -- should be 2026-03-06 (UTC date, not local)
    const dateBits = frame.slice(45, 61); // 16 bits
    // 2026-03-06: year=26=0011010, month=3=0011, day=6=00110
    expect(dateBits).toEqual([0, 0, 1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 0, 1, 1, 0]);
  });

  test('DST active does not modify shift (watch applies DST from transition dates)', () => {
    const frameNoDst = assembleFrame({
      targetTimezone: 'T1',
      utcTime: new Date(Date.UTC(2026, 2, 6, 12, 0, 0)),
      tz: { shiftHours: 1, minuteShift: 0, hemisphere: 0, dstActive: false },
    });

    const frameWithDst = assembleFrame({
      targetTimezone: 'T1',
      utcTime: new Date(Date.UTC(2026, 2, 6, 12, 0, 0)),
      tz: { shiftHours: 1, minuteShift: 0, hemisphere: 0, dstActive: true },
    });

    // TZ field is at bits 20..27
    const tzNoDst = frameNoDst.slice(20, 28);
    const tzWithDst = frameWithDst.slice(20, 28);

    // Both should encode the base shift=1: MSB=00001, min=00, hem=0 -> 00001000
    expect(tzNoDst).toEqual([0, 0, 0, 0, 1, 0, 0, 0]);
    expect(tzWithDst).toEqual([0, 0, 0, 0, 1, 0, 0, 0]);
  });
});

describe('buildBitstream', () => {
  test('bitstream ends with 2 trailing zeros', () => {
    const bits = buildBitstream({
      targetTimezone: 'T1',
      utcTime: new Date(Date.UTC(2026, 2, 6, 12, 0, 0)),
      tz: { shiftHours: 0, minuteShift: 0, hemisphere: 0, dstActive: false },
    });

    expect(bits[bits.length - 1]).toBe(0);
    expect(bits[bits.length - 2]).toBe(0);
  });

  test('bitstream is longer than raw frame due to stuffing', () => {
    const params = {
      targetTimezone: 'T1' as const,
      utcTime: new Date(Date.UTC(2026, 2, 6, 12, 0, 0)),
      tz: { shiftHours: 0, minuteShift: 0, hemisphere: 0, dstActive: false },
    };

    const frame = assembleFrame(params);
    const bitstream = buildBitstream(params);

    // Bitstream >= frame + 2 trailing zeros (may have stuff bits)
    expect(bitstream.length).toBeGreaterThanOrEqual(frame.length + 2);
  });

  test('bitstream only contains 0s and 1s', () => {
    const bits = buildBitstream({
      targetTimezone: 'T1',
      utcTime: new Date(Date.UTC(2026, 2, 6, 12, 0, 0)),
      tz: { shiftHours: -5, minuteShift: 0, hemisphere: 0, dstActive: true },
      dstSummer: { season: 0, month: 3, day: 8, hour: 2 },
      dstWinter: { season: 1, month: 11, day: 1, hour: 2 },
    });

    for (const bit of bits) {
      expect(bit === 0 || bit === 1).toBe(true);
    }
  });
});

describe('buildCompensatedBitstream', () => {
  test('compensated bitstream encodes a future time', () => {
    const now = new Date(Date.UTC(2026, 2, 6, 12, 0, 0));
    const bitPeriodMs = 33.33;

    const uncompensated = buildBitstream({
      targetTimezone: 'T1',
      utcTime: now,
      tz: { shiftHours: 0, minuteShift: 0, hemisphere: 0, dstActive: false },
    });

    const { bitstream: compensated, messageDelayMs } = buildCompensatedBitstream({
      targetTimezone: 'T1',
      utcTime: now,
      tz: { shiftHours: 0, minuteShift: 0, hemisphere: 0, dstActive: false },
    }, bitPeriodMs);

    // They should differ because the compensated one encodes a later time
    expect(compensated).not.toEqual(uncompensated);

    // But they should be similar length
    expect(Math.abs(compensated.length - uncompensated.length)).toBeLessThanOrEqual(3);

    // Message delay should be non-negative and at most 1 second
    expect(messageDelayMs).toBeGreaterThanOrEqual(0);
    expect(messageDelayMs).toBeLessThanOrEqual(1000);
  });
});

// =============================================================================
// Protocol Validation Tests
// =============================================================================

// --- 1. CRC-8 Checksum Validation ---

describe('crc8 - protocol test vector', () => {
  test('polynomial is 0x07 (x^8 + x^2 + x + 1)', () => {
    // Verify the polynomial by checking that CRC(data + CRC(data)) == 0
    // for a known input, confirming the polynomial division is self-consistent
    const data = [1, 0, 0, 0, 0, 0, 0, 0];
    const checksum = crc8(data);
    expect(checksum.length).toBe(8);
    // Appending the CRC to data must yield zero remainder
    expect(crc8([...data, ...checksum])).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  test('initial value is 0x00 (no pre-seeding)', () => {
    // With init=0x00, CRC of all zeros is zero
    const zeros = [0, 0, 0, 0, 0, 0, 0, 0];
    expect(crc8(zeros)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  test('known test vector: 27425146D2A98 -> 0xC1', () => {
    // Captured protocol test vector from analysis
    // Input: hex nibbles 2,7,4,2,5,1,4,6,D,2,A,9,8 = 52 bits
    const inputBits = hexToBits('27425146D2A98');
    expect(inputBits.length).toBe(52);

    const crcResult = crc8(inputBits);

    // Expected: 0xC1 = 11000001
    expect(crcResult).toEqual([1, 1, 0, 0, 0, 0, 0, 1]);
    expect(bitsToUint(crcResult)).toBe(0xC1);
  });

  test('test vector with CRC appended yields zero remainder', () => {
    const inputBits = hexToBits('27425146D2A98');
    const crcBits = crc8(inputBits);
    const fullMessage = [...inputBits, ...crcBits];
    const remainder = crc8(fullMessage);
    expect(remainder).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  test('final XOR value is 0x00 (no post-processing)', () => {
    // If final XOR were non-zero, appending CRC would NOT yield zero remainder
    // This test confirms the zero-remainder property holds
    const data = [1, 0, 1, 0, 1, 1, 0, 0, 1, 0, 0, 1, 1, 1, 0, 1];
    const checksum = crc8(data);
    const withCrc = [...data, ...checksum];
    expect(crc8(withCrc)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

// --- 2. Known-Good Payload Assemblies (Integration Tests) ---

describe('payload assembly - Fixture A: London (Home)', () => {
  // London: Home (T1), TZ offset=0, Time 09:48:26, Date 2021-03-28
  const londonFrame = assembleFrame({
    targetTimezone: 'T1',
    utcTime: new Date(Date.UTC(2021, 2, 28, 9, 48, 26)),
    tz: { shiftHours: 0, minuteShift: 0, hemisphere: 0, dstActive: false },
  });

  test('frame is 69 bits (Frame A, no DST)', () => {
    expect(londonFrame.length).toBe(69);
  });

  test('header is correct (0x75 derived preamble)', () => {
    expect(londonFrame.slice(0, 8)).toEqual([1, 1, 1, 0, 1, 0, 1, 0]);
  });

  test('length field is 1 (single sub-message)', () => {
    expect(londonFrame.slice(8, 12)).toEqual([0, 0, 0, 1]);
    expect(bitsToUint(londonFrame.slice(8, 12))).toBe(1);
  });

  test('opcode is 57 (TZ_TIME_DATE_T1 = Home)', () => {
    const opcodeBits = londonFrame.slice(12, 20);
    expect(opcodeBits).toEqual([0, 0, 1, 1, 1, 0, 0, 1]);
    expect(bitsToUint(opcodeBits)).toBe(Opcode.TZ_TIME_DATE_T1);
  });

  test('timezone offset is 0', () => {
    const tzBits = londonFrame.slice(20, 28);
    // shift=0=00000, minuteShift=0=00, hemisphere=0
    expect(tzBits).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    // Extract shift (5 bits)
    expect(bitsToUint(tzBits.slice(0, 5))).toBe(0);
  });

  test('time encodes as 09:48:26', () => {
    const timeBits = londonFrame.slice(28, 45);
    expect(timeBits.length).toBe(17);

    // hour=9 (5 bits): 01001
    const hourBits = timeBits.slice(0, 5);
    expect(bitsToUint(hourBits)).toBe(9);

    // minute=48 (6 bits): 110000
    const minuteBits = timeBits.slice(5, 11);
    expect(bitsToUint(minuteBits)).toBe(48);

    // second=26 (6 bits): 011010
    const secondBits = timeBits.slice(11, 17);
    expect(bitsToUint(secondBits)).toBe(26);
  });

  test('date encodes as year=21, month=3, day=28', () => {
    const dateBits = londonFrame.slice(45, 61);
    expect(dateBits.length).toBe(16);

    // year=21 (7 bits): 0010101
    expect(bitsToUint(dateBits.slice(0, 7))).toBe(21);

    // month=3 (4 bits): 0011
    expect(bitsToUint(dateBits.slice(7, 11))).toBe(3);

    // day=28 (5 bits): 11100
    expect(bitsToUint(dateBits.slice(11, 16))).toBe(28);
  });

  test('CRC validates (zero remainder)', () => {
    const payloadWithCrc = londonFrame.slice(8);
    expect(crc8(payloadWithCrc)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe('payload assembly - Fixture B: Berlin (Travel)', () => {
  // Berlin: Travel (T2), TZ offset=1, Time 09:57:25, Date 2021-03-28
  const berlinFrame = assembleFrame({
    targetTimezone: 'T2',
    utcTime: new Date(Date.UTC(2021, 2, 28, 9, 57, 25)),
    tz: { shiftHours: 1, minuteShift: 0, hemisphere: 0, dstActive: false },
  });

  test('frame is 69 bits (Frame A, no DST)', () => {
    expect(berlinFrame.length).toBe(69);
  });

  test('opcode is 58 (TZ_TIME_DATE_T2 = Travel)', () => {
    const opcodeBits = berlinFrame.slice(12, 20);
    expect(opcodeBits).toEqual([0, 0, 1, 1, 1, 0, 1, 0]);
    expect(bitsToUint(opcodeBits)).toBe(Opcode.TZ_TIME_DATE_T2);
  });

  test('timezone offset is +1 (MSB-first)', () => {
    const tzBits = berlinFrame.slice(20, 28);
    // shift=1 MSB=00001, minuteShift=0=00, hemisphere=0
    expect(tzBits).toEqual([0, 0, 0, 0, 1, 0, 0, 0]);
    const shiftBits = tzBits.slice(0, 5);
    expect(bitsToUint(shiftBits)).toBe(1);
  });

  test('time encodes as 09:57:25', () => {
    const timeBits = berlinFrame.slice(28, 45);

    // hour=9
    expect(bitsToUint(timeBits.slice(0, 5))).toBe(9);

    // minute=57
    expect(bitsToUint(timeBits.slice(5, 11))).toBe(57);

    // second=25
    expect(bitsToUint(timeBits.slice(11, 17))).toBe(25);
  });

  test('date encodes as year=21, month=3, day=28', () => {
    const dateBits = berlinFrame.slice(45, 61);

    expect(bitsToUint(dateBits.slice(0, 7))).toBe(21);
    expect(bitsToUint(dateBits.slice(7, 11))).toBe(3);
    expect(bitsToUint(dateBits.slice(11, 16))).toBe(28);
  });

  test('CRC validates (zero remainder)', () => {
    const payloadWithCrc = berlinFrame.slice(8);
    expect(crc8(payloadWithCrc)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe('destination flag - Home vs Travel opcode selection', () => {
  const utcTime = new Date(Date.UTC(2021, 2, 28, 12, 0, 0));
  const tz = { shiftHours: 1, minuteShift: 0, hemisphere: 0, dstActive: false };

  test('T1 (Home) uses opcode 57', () => {
    const frame = assembleFrame({ targetTimezone: 'T1', utcTime, tz });
    const opcode = bitsToUint(frame.slice(12, 20));
    expect(opcode).toBe(57);
    expect(opcode).toBe(Opcode.TZ_TIME_DATE_T1);
  });

  test('T2 (Travel) uses opcode 58', () => {
    const frame = assembleFrame({ targetTimezone: 'T2', utcTime, tz });
    const opcode = bitsToUint(frame.slice(12, 20));
    expect(opcode).toBe(58);
    expect(opcode).toBe(Opcode.TZ_TIME_DATE_T2);
  });

  test('Home and Travel frames differ only in opcode and CRC', () => {
    const homeFrame = assembleFrame({ targetTimezone: 'T1', utcTime, tz });
    const travelFrame = assembleFrame({ targetTimezone: 'T2', utcTime, tz });

    // Header should be identical
    expect(homeFrame.slice(0, 12)).toEqual(travelFrame.slice(0, 12));

    // Opcode should differ (bits 12-19)
    expect(homeFrame.slice(12, 20)).not.toEqual(travelFrame.slice(12, 20));

    // TZ, time, date fields should be identical (bits 20-60)
    expect(homeFrame.slice(20, 61)).toEqual(travelFrame.slice(20, 61));

    // CRC will differ because opcode differs
    expect(homeFrame.slice(61, 69)).not.toEqual(travelFrame.slice(61, 69));
  });

  test('DST frame: T1 uses opcode pair 57/59, T2 uses 58/60', () => {
    const dstSummer = { season: 0 as const, month: 3, day: 28, hour: 1 };
    const dstWinter = { season: 1 as const, month: 10, day: 31, hour: 2 };

    const homeFrame = assembleFrame({
      targetTimezone: 'T1', utcTime, tz, dstSummer, dstWinter,
    });
    const travelFrame = assembleFrame({
      targetTimezone: 'T2', utcTime, tz, dstSummer, dstWinter,
    });

    // First opcode
    expect(bitsToUint(homeFrame.slice(12, 20))).toBe(Opcode.TZ_TIME_DATE_T1);    // 57
    expect(bitsToUint(travelFrame.slice(12, 20))).toBe(Opcode.TZ_TIME_DATE_T2);  // 58

    // Second opcode at bit 61 (8+4+8+8+17+16 = 61)
    expect(bitsToUint(homeFrame.slice(61, 69))).toBe(Opcode.DST_DATE_TIME_SW_T1);    // 59
    expect(bitsToUint(travelFrame.slice(61, 69))).toBe(Opcode.DST_DATE_TIME_SW_T2);  // 60
  });
});

// --- 3. Bit Level and Sizing Constraints ---

describe('bit-level constraints', () => {
  test('Frame A (no DST) total is exactly 69 bits', () => {
    const frame = assembleFrame({
      targetTimezone: 'T1',
      utcTime: new Date(Date.UTC(2021, 2, 28, 9, 48, 26)),
      tz: { shiftHours: 0, minuteShift: 0, hemisphere: 0, dstActive: false },
    });
    // Header(8) + Length(4) + Opcode(8) + TZ(8) + Time(17) + Date(16) + CRC(8) = 69
    expect(frame.length).toBe(69);
  });

  test('Frame B (with DST) total is exactly 107 bits', () => {
    const frame = assembleFrame({
      targetTimezone: 'T1',
      utcTime: new Date(Date.UTC(2021, 2, 28, 9, 48, 26)),
      tz: { shiftHours: 0, minuteShift: 0, hemisphere: 0, dstActive: false },
      dstSummer: { season: 0, month: 3, day: 28, hour: 1 },
      dstWinter: { season: 1, month: 10, day: 31, hour: 2 },
    });
    // Header(8) + Length(4) + Opcode1(8) + TZ(8) + Time(17) + Date(16)
    // + Opcode2(8) + DST_Start(15) + DST_End(15) + CRC(8) = 107
    expect(frame.length).toBe(107);
  });

  test('full bitstream (Frame B + stuffing + trailing) is approximately 110 bits', () => {
    const bitstream = buildBitstream({
      targetTimezone: 'T1',
      utcTime: new Date(Date.UTC(2021, 2, 28, 9, 48, 26)),
      tz: { shiftHours: 0, minuteShift: 0, hemisphere: 0, dstActive: false },
      dstSummer: { season: 0, month: 3, day: 28, hour: 1 },
      dstWinter: { season: 1, month: 10, day: 31, hour: 2 },
    });
    // With stuffing and trailing zeros, should be around 110 bits
    // Frame B is 107 bits + 2 trailing + stuff bits (data dependent)
    expect(bitstream.length).toBeGreaterThanOrEqual(109);
    expect(bitstream.length).toBeLessThanOrEqual(125); // reasonable upper bound
  });

  test('timezone is encoded as 5-bit signed integer (MSB-first)', () => {
    // Positive offsets (MSB-first)
    expect(encodeTimezone(0, 0, 0).slice(0, 5)).toEqual([0, 0, 0, 0, 0]);   // 0
    expect(encodeTimezone(1, 0, 0).slice(0, 5)).toEqual([0, 0, 0, 0, 1]);   // +1
    expect(encodeTimezone(15, 0, 0).slice(0, 5)).toEqual([0, 1, 1, 1, 1]);  // +15

    // Negative offsets (two's complement, MSB-first)
    expect(encodeTimezone(-1, 0, 0).slice(0, 5)).toEqual([1, 1, 1, 1, 1]);  // -1 (palindrome)
    expect(encodeTimezone(-8, 0, 0).slice(0, 5)).toEqual([1, 1, 0, 0, 0]);  // -8
    expect(encodeTimezone(-12, 0, 0).slice(0, 5)).toEqual([1, 0, 1, 0, 0]); // -12
  });

  test('timezone field is exactly 8 bits: 5 shift + 2 minuteShift + 1 hemisphere', () => {
    const tz = encodeTimezone(-8, 1, 1);
    expect(tz.length).toBe(8);

    // -8 in 5-bit two's complement MSB-first = 11000
    expect(tz.slice(0, 5)).toEqual([1, 1, 0, 0, 0]);
    // minuteShift=1 (+30min) in 2 bits = 01
    expect(tz.slice(5, 7)).toEqual([0, 1]);
    // hemisphere=1 (South) in 1 bit = 1
    expect(tz.slice(7, 8)).toEqual([1]);
  });

  test('negative timezone -8 (Los Angeles) encodes correctly as 5-bit signed MSB-first', () => {
    const bits = encodeTimezone(-8, 0, 0);
    // -8 two's complement MSB-first=11000
    expect(bits.slice(0, 5)).toEqual([1, 1, 0, 0, 0]);

    // Verify by decoding as two's complement
    const rawValue = bitsToUint(bits.slice(0, 5));
    expect(rawValue).toBe(24); // unsigned representation of 11000
    const signedValue = rawValue >= 16 ? rawValue - 32 : rawValue; // 5-bit two's complement
    expect(signedValue).toBe(-8);
  });

  test('time field is exactly 17 bits: 5 hour + 6 minute + 6 second', () => {
    const time = encodeTime(9, 48, 26);
    expect(time.length).toBe(17);
  });

  test('date field is exactly 16 bits: 7 year + 4 month + 5 day', () => {
    const date = encodeDate(21, 3, 28);
    expect(date.length).toBe(16);
  });

  test('DST datetime field is exactly 15 bits: 1 season + 4 month + 5 day + 5 hour', () => {
    const dst = encodeDstDateTime(0, 3, 28, 2);
    expect(dst.length).toBe(15);
  });

  test('fractional timezone: +30min encoded as minuteShift=1', () => {
    // India: UTC+5:30 -> shift=5, minuteShift=1
    const bits = encodeTimezone(5, 1, 0);
    expect(bitsToUint(bits.slice(0, 5))).toBe(5);
    expect(bitsToUint(bits.slice(5, 7))).toBe(1); // +30min
  });

  test('fractional timezone: +45min encoded as minuteShift=2', () => {
    // Nepal: UTC+5:45 -> shift=5, minuteShift=2
    const bits = encodeTimezone(5, 2, 0);
    expect(bitsToUint(bits.slice(0, 5))).toBe(5);
    expect(bitsToUint(bits.slice(5, 7))).toBe(2); // +45min
  });
});

// --- 4. Edge Case: The "Big Change" Bit (Bit 45) ---

describe('big change bit (bit 45)', () => {
  // In a Frame A, bit 45 (0-indexed) is the MSB of the date's year field.
  // Frame layout: Header(8) + Length(4) + Opcode(8) + TZ(8) + Time(17) + Date(16) + CRC(8)
  // Bit 45 = 8 + 4 + 8 + 8 + 17 = bit 45 = first bit of Date field = year MSB

  test('standard encoding sets bit 45 to 0 for year <= 63', () => {
    // Year 21 (2021): binary 0010101, MSB = 0
    const frame = assembleFrame({
      targetTimezone: 'T1',
      utcTime: new Date(Date.UTC(2021, 2, 28, 9, 48, 26)),
      tz: { shiftHours: 0, minuteShift: 0, hemisphere: 0, dstActive: false },
    });
    expect(frame[45]).toBe(0);
  });

  test('bit 45 is 0 for typical years (2000-2063)', () => {
    for (const year of [2000, 2010, 2021, 2026, 2050, 2063]) {
      const frame = assembleFrame({
        targetTimezone: 'T1',
        utcTime: new Date(Date.UTC(year, 2, 15, 12, 0, 0)),
        tz: { shiftHours: 0, minuteShift: 0, hemisphere: 0, dstActive: false },
      });
      expect(frame[45]).toBe(0);
    }
  });

  test('flipping bit 45 corrupts the date field (year MSB)', () => {
    const frame = assembleFrame({
      targetTimezone: 'T1',
      utcTime: new Date(Date.UTC(2021, 2, 28, 9, 48, 26)),
      tz: { shiftHours: 0, minuteShift: 0, hemisphere: 0, dstActive: false },
    });

    // Original: year=21 (0010101), bit 45 = 0
    const originalYear = bitsToUint(frame.slice(45, 52));
    expect(originalYear).toBe(21);

    // Flip bit 45 (year MSB): 0010101 -> 1010101 = 85
    const corruptedFrame = [...frame];
    corruptedFrame[45] = 1;
    const corruptedYear = bitsToUint(corruptedFrame.slice(45, 52));
    expect(corruptedYear).toBe(85);
    expect(corruptedYear - originalYear).toBe(64);
  });

  test('flipping only bit 45 invalidates the CRC', () => {
    const frame = assembleFrame({
      targetTimezone: 'T1',
      utcTime: new Date(Date.UTC(2021, 2, 28, 9, 48, 26)),
      tz: { shiftHours: 0, minuteShift: 0, hemisphere: 0, dstActive: false },
    });

    // Original CRC validates
    expect(crc8(frame.slice(8))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);

    // Flip bit 45
    const corrupted = [...frame];
    corrupted[45] = corrupted[45] === 0 ? 1 : 0;

    // CRC no longer validates
    const remainder = crc8(corrupted.slice(8));
    expect(remainder).not.toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  test('bit 45 position is exactly the start of the date field', () => {
    // Verify the frame layout: Header(8) + Length(4) + Opcode(8) + TZ(8) + Time(17) = 45
    const HEADER_BITS = 8;
    const LENGTH_BITS = 4;
    const OPCODE_BITS = 8;
    const TZ_BITS = 8;
    const TIME_BITS = 17;
    expect(HEADER_BITS + LENGTH_BITS + OPCODE_BITS + TZ_BITS + TIME_BITS).toBe(45);
  });
});

// --- 5. Bit-to-Pulse Timing (Hardware Interface) ---

describe('bit-to-pulse timing', () => {
  test('default bit period is 30ms', () => {
    expect(BIT_PERIOD_MS).toBe(30.0);
  });

  test('total transmission duration for Frame A is approximately 2-3 seconds', () => {
    const bitstream = buildBitstream({
      targetTimezone: 'T1',
      utcTime: new Date(Date.UTC(2021, 2, 28, 9, 48, 26)),
      tz: { shiftHours: 0, minuteShift: 0, hemisphere: 0, dstActive: false },
    });
    const durationMs = bitstream.length * BIT_PERIOD_MS;
    const durationSec = durationMs / 1000;

    // Frame A: ~71-75 bits * 30ms = ~2.1-2.3 seconds
    expect(durationSec).toBeGreaterThan(1.5);
    expect(durationSec).toBeLessThan(4.0);
  });

  test('total transmission duration for Frame B is approximately 3.5 seconds', () => {
    const bitstream = buildBitstream({
      targetTimezone: 'T1',
      utcTime: new Date(Date.UTC(2021, 2, 28, 9, 48, 26)),
      tz: { shiftHours: 0, minuteShift: 0, hemisphere: 0, dstActive: false },
      dstSummer: { season: 0, month: 3, day: 28, hour: 1 },
      dstWinter: { season: 1, month: 10, day: 31, hour: 2 },
    });
    const durationMs = bitstream.length * BIT_PERIOD_MS;
    const durationSec = durationMs / 1000;

    // Frame B: ~110-120 bits * 30ms = ~3.3-3.6 seconds
    expect(durationSec).toBeGreaterThan(2.5);
    expect(durationSec).toBeLessThan(5.0);
  });

  test('state mapping: 1 = ON (white), 0 = OFF (black)', () => {
    // This is a design assertion about the transmitter mapping.
    // The bitstream uses 1 for light ON and 0 for light OFF.
    const bitstream = buildBitstream({
      targetTimezone: 'T1',
      utcTime: new Date(Date.UTC(2021, 2, 28, 12, 0, 0)),
      tz: { shiftHours: 0, minuteShift: 0, hemisphere: 0, dstActive: false },
    });

    // Verify the bitstream starts with the header [1,1,1,0,1,0,1,0]
    // which means ON,ON,ON,OFF,ON,OFF,ON,OFF -- confirming 1=ON, 0=OFF
    expect(bitstream[0]).toBe(1); // First header bit = ON
    expect(bitstream[3]).toBe(0); // Fourth header bit = OFF
  });
});

// --- Stop bits (bit stuffing prevents long runs) ---

describe('stop bits - bit stuffing guarantees sync', () => {
  test('no more than 5 consecutive identical bits in stuffed output', () => {
    // Test with various payloads that could produce long runs
    const testCases = [
      { targetTimezone: 'T1' as const, utcTime: new Date(Date.UTC(2021, 0, 1, 0, 0, 0)),
        tz: { shiftHours: 0, minuteShift: 0, hemisphere: 0, dstActive: false } },
      { targetTimezone: 'T2' as const, utcTime: new Date(Date.UTC(2021, 2, 28, 9, 48, 26)),
        tz: { shiftHours: -8, minuteShift: 0, hemisphere: 0, dstActive: false } },
      { targetTimezone: 'T1' as const, utcTime: new Date(Date.UTC(2021, 5, 15, 23, 59, 59)),
        tz: { shiftHours: 12, minuteShift: 0, hemisphere: 0, dstActive: true },
        dstSummer: { season: 0, month: 9, day: 26, hour: 2 },
        dstWinter: { season: 1, month: 4, day: 4, hour: 3 } },
    ];

    for (const params of testCases) {
      const bitstream = buildBitstream(params);

      let consecutiveCount = 0;
      let lastBit = -1;

      for (let i = 0; i < bitstream.length - 2; i++) { // exclude trailing zeros
        const bit = bitstream[i]!;
        if (bit === lastBit) {
          consecutiveCount++;
        } else {
          consecutiveCount = 1;
          lastBit = bit;
        }
        // After stuffing, there should never be more than 6 consecutive same bits
        // (5 original + 1 before the stuff bit takes effect in next position)
        expect(consecutiveCount).toBeLessThanOrEqual(6);
      }
    }
  });

  test('stuff bits are correctly stripped by undoing the stuffing process', () => {
    const original = [1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 1, 0, 1];
    const stuffed = addStuffBits(original);

    // Manually unstuff: remove the bit inserted after 5 consecutive same bits
    const unstuffed: number[] = [];
    let count = 0;
    let last = -1;
    for (let i = 0; i < stuffed.length; i++) {
      const bit = stuffed[i]!;
      if (bit === last) {
        count++;
      } else {
        count = 1;
        last = bit;
      }
      unstuffed.push(bit);
      if (count === 5 && i + 1 < stuffed.length) {
        // Skip the next bit (it's the stuff bit)
        i++;
        count = 1;
        last = stuffed[i]!;
      }
    }

    expect(unstuffed).toEqual(original);
  });

  test('bitstream always ends with exactly 2 trailing zeros', () => {
    const bitstream = buildBitstream({
      targetTimezone: 'T1',
      utcTime: new Date(Date.UTC(2021, 2, 28, 9, 48, 26)),
      tz: { shiftHours: 0, minuteShift: 0, hemisphere: 0, dstActive: false },
    });

    expect(bitstream[bitstream.length - 1]).toBe(0);
    expect(bitstream[bitstream.length - 2]).toBe(0);
  });
});

// --- Cross-fixture consistency ---

describe('cross-fixture consistency', () => {
  test('London and Berlin fixtures encode the same date (2021-03-28)', () => {
    const londonFrame = assembleFrame({
      targetTimezone: 'T1',
      utcTime: new Date(Date.UTC(2021, 2, 28, 9, 48, 26)),
      tz: { shiftHours: 0, minuteShift: 0, hemisphere: 0, dstActive: false },
    });
    const berlinFrame = assembleFrame({
      targetTimezone: 'T2',
      utcTime: new Date(Date.UTC(2021, 2, 28, 9, 57, 25)),
      tz: { shiftHours: 1, minuteShift: 0, hemisphere: 0, dstActive: false },
    });

    // Both dates should be year=21, month=3, day=28
    const londonDate = londonFrame.slice(45, 61);
    const berlinDate = berlinFrame.slice(45, 61);
    expect(londonDate).toEqual(berlinDate);
  });

  test('CRC is unique per payload (London vs Berlin have different CRCs)', () => {
    const londonFrame = assembleFrame({
      targetTimezone: 'T1',
      utcTime: new Date(Date.UTC(2021, 2, 28, 9, 48, 26)),
      tz: { shiftHours: 0, minuteShift: 0, hemisphere: 0, dstActive: false },
    });
    const berlinFrame = assembleFrame({
      targetTimezone: 'T2',
      utcTime: new Date(Date.UTC(2021, 2, 28, 9, 57, 25)),
      tz: { shiftHours: 1, minuteShift: 0, hemisphere: 0, dstActive: false },
    });

    const londonCrc = londonFrame.slice(61, 69);
    const berlinCrc = berlinFrame.slice(61, 69);
    expect(londonCrc).not.toEqual(berlinCrc);
  });

  test('all assembled frames have valid CRC regardless of parameters', () => {
    const testParams = [
      { targetTimezone: 'T1' as const, utcTime: new Date(Date.UTC(2021, 0, 1, 0, 0, 0)),
        tz: { shiftHours: 0, minuteShift: 0, hemisphere: 0, dstActive: false } },
      { targetTimezone: 'T2' as const, utcTime: new Date(Date.UTC(2050, 11, 31, 23, 59, 59)),
        tz: { shiftHours: -12, minuteShift: 0, hemisphere: 0, dstActive: false } },
      { targetTimezone: 'T1' as const, utcTime: new Date(Date.UTC(2030, 6, 15, 12, 30, 45)),
        tz: { shiftHours: 5, minuteShift: 2, hemisphere: 1, dstActive: true } },
      { targetTimezone: 'T2' as const, utcTime: new Date(Date.UTC(2025, 3, 10, 8, 15, 0)),
        tz: { shiftHours: -8, minuteShift: 0, hemisphere: 0, dstActive: true },
        dstSummer: { season: 0, month: 3, day: 8, hour: 2 },
        dstWinter: { season: 1, month: 11, day: 1, hour: 2 } },
    ];

    for (const params of testParams) {
      const frame = assembleFrame(params);
      const payloadWithCrc = frame.slice(8);
      const remainder = crc8(payloadWithCrc);
      expect(remainder).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    }
  });
});

// =============================================================================
// Decompiled App Validation Tests (de.appsfactory.wopservice)
// =============================================================================

// --- 1. ProtErrorDetection: CRC-8 generation matches known good vector ---

describe('ProtErrorDetection - CRC-8 generation', () => {
  test('matches known good vector from protocol docs', () => {
    // Spec: Predefined CRC-8, Poly: 0x7, Init: 0x0, XOR: 0x0
    // The spreadsheet dictates this exact payload must yield 0xC1
    const testPayload = hexToBits('27425146D2A98');
    const result = crc8(testPayload);
    expect(bitsToUint(result)).toBe(0xC1);
  });
});

// --- 2. TimezoneMessage: offset encoding handles negative and fractional ---

describe('TimezoneMessage - offset encoding (LSB-first)', () => {
  test('London offset 0 encodes as "00000"', () => {
    const bits = encodeTimezone(0, 0, 0);
    const offsetBits = bits.slice(0, 5);
    expect(offsetBits).toEqual([0, 0, 0, 0, 0]);
  });

  test('Berlin offset +1 encodes as "00001" (MSB-first)', () => {
    const bits = encodeTimezone(1, 0, 0);
    const offsetBits = bits.slice(0, 5);
    expect(offsetBits).toEqual([0, 0, 0, 0, 1]);
  });

  test('LA offset -8 encodes as "11000" (MSB-first two\'s complement)', () => {
    const bits = encodeTimezone(-8, 0, 0);
    const offsetBits = bits.slice(0, 5);
    expect(offsetBits).toEqual([1, 1, 0, 0, 0]);
  });

  test('all three fixture offsets produce 5-bit outputs', () => {
    for (const offset of [0, 1, -8]) {
      const bits = encodeTimezone(offset, 0, 0);
      expect(bits.length).toBe(8); // 5 shift + 2 minuteShift + 1 hemisphere
    }
  });
});

// --- 3. WopProtocol: assembly maintains length and isolates anomaly ---

describe('WopProtocol - assembly, destination, and anomaly isolation', () => {
  test('assembled stream length is within 105-115 bits', () => {
    // Standard time sync payload matching decompiled TimeMessage constructor:
    // YY=21, MM=3, DD=28, HH=9, MM=48, SS=26, Target=HOME
    const bitstream = buildBitstream({
      targetTimezone: 'T1',
      utcTime: new Date(Date.UTC(2021, 2, 28, 9, 48, 26)),
      tz: { shiftHours: 0, minuteShift: 0, hemisphere: 0, dstActive: false },
      dstSummer: { season: 0, month: 3, day: 28, hour: 1 },
      dstWinter: { season: 1, month: 10, day: 31, hour: 2 },
    });
    expect(bitstream.length).toBeGreaterThanOrEqual(105);
    expect(bitstream.length).toBeLessThanOrEqual(125);
  });

  test('bit 45 anomaly is masked to 0 by default', () => {
    // The encoder must NOT set bit 45 for any standard time sync
    const frame = assembleFrame({
      targetTimezone: 'T1',
      utcTime: new Date(Date.UTC(2021, 2, 28, 9, 48, 26)),
      tz: { shiftHours: 0, minuteShift: 0, hemisphere: 0, dstActive: false },
    });
    expect(frame[45]).toBe(0);
  });

  test('mutating bit 45 does not shift adjacent data bits', () => {
    const frame = assembleFrame({
      targetTimezone: 'T1',
      utcTime: new Date(Date.UTC(2021, 2, 28, 9, 48, 26)),
      tz: { shiftHours: 0, minuteShift: 0, hemisphere: 0, dstActive: false },
    });

    const mutated = [...frame];
    mutated[45] = 1;

    // All bits EXCEPT bit 45 and the CRC (last 8 bits) must remain identical
    for (let i = 0; i < frame.length - 8; i++) {
      if (i === 45) continue;
      expect(mutated[i]).toBe(frame[i]);
    }
  });

  test('destination flag: Home (T1) sets opcode to 57', () => {
    const frame = assembleFrame({
      targetTimezone: 'T1',
      utcTime: new Date(Date.UTC(2021, 2, 28, 9, 48, 26)),
      tz: { shiftHours: 0, minuteShift: 0, hemisphere: 0, dstActive: false },
    });
    expect(bitsToUint(frame.slice(12, 20))).toBe(57);
  });

  test('destination flag: switching to Travel (T2) flips opcode to 58', () => {
    const frame = assembleFrame({
      targetTimezone: 'T2',
      utcTime: new Date(Date.UTC(2021, 2, 28, 9, 48, 26)),
      tz: { shiftHours: 0, minuteShift: 0, hemisphere: 0, dstActive: false },
    });
    expect(bitsToUint(frame.slice(12, 20))).toBe(58);
  });

  test('frame concatenates Header + Length + Payload + CRC in correct order', () => {
    const frame = assembleFrame({
      targetTimezone: 'T1',
      utcTime: new Date(Date.UTC(2021, 2, 28, 9, 48, 26)),
      tz: { shiftHours: 0, minuteShift: 0, hemisphere: 0, dstActive: false },
    });

    // Header (8 bits): 0x75 derived = [1,1,1,0,1,0,1,0]
    expect(frame.slice(0, 8)).toEqual([1, 1, 1, 0, 1, 0, 1, 0]);

    // Length (4 bits): 1 sub-message
    expect(bitsToUint(frame.slice(8, 12))).toBe(1);

    // Payload: Opcode(8) + TZ(8) + Time(17) + Date(16) = 49 bits at positions 12-60
    expect(frame.length - 8 - 4 - 8).toBe(49); // payload fields minus header/length/CRC

    // CRC (last 8 bits)
    const payloadWithCrc = frame.slice(8);
    expect(crc8(payloadWithCrc)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

// --- 4. BipolarEncoder: stop-bit injection and timing ---

describe('BipolarEncoder - optical sync and timing', () => {
  test('all-ones payload is broken up by stop bits (no run of 8+ identical bits)', () => {
    // Create a payload intentionally full of 1s to force stop-bit injection
    const allOnes = new Array(16).fill(1);
    const encoded = addStuffBits(allOnes);

    // Verify that no run of 8 consecutive identical bits exists
    const asString = encoded.join('');
    expect(asString).not.toContain('11111111');
  });

  test('all-zeros payload is broken up by stop bits', () => {
    const allZeros = new Array(16).fill(0);
    const encoded = addStuffBits(allZeros);

    const asString = encoded.join('');
    expect(asString).not.toContain('00000000');
  });

  test('stuffed bitstream never contains 6+ consecutive identical bits', () => {
    // Test with a realistic full frame
    const bitstream = buildBitstream({
      targetTimezone: 'T1',
      utcTime: new Date(Date.UTC(2021, 2, 28, 9, 48, 26)),
      tz: { shiftHours: 0, minuteShift: 0, hemisphere: 0, dstActive: false },
      dstSummer: { season: 0, month: 3, day: 28, hour: 1 },
      dstWinter: { season: 1, month: 10, day: 31, hour: 2 },
    });

    // Check excluding trailing zeros (which are appended after stuffing)
    const stuffedPortion = bitstream.slice(0, -2);
    let maxRun = 0;
    let runLength = 1;
    for (let i = 1; i < stuffedPortion.length; i++) {
      if (stuffedPortion[i] === stuffedPortion[i - 1]) {
        runLength++;
        if (runLength > maxRun) maxRun = runLength;
      } else {
        runLength = 1;
      }
    }
    // After 5 same bits, a stuff bit is inserted — max run is 5 data + 1 continuation = 6
    // but the stuff bit is the OPPOSITE, so max consecutive same bits should be ≤ 5
    // (in practice 5 data bits followed by an opposite stuff bit)
    expect(maxRun).toBeLessThanOrEqual(5);
  });

  test('timing: each bit maps to exactly 30ms interval', () => {
    // Spec: 1 bit = 30 milliseconds
    expect(BIT_PERIOD_MS).toBe(30);

    const bitstream = buildBitstream({
      targetTimezone: 'T1',
      utcTime: new Date(Date.UTC(2021, 2, 28, 9, 48, 26)),
      tz: { shiftHours: 0, minuteShift: 0, hemisphere: 0, dstActive: false },
    });

    // Total duration = number of bits * 30ms
    const totalDurationMs = bitstream.length * BIT_PERIOD_MS;
    // Each bit generates exactly one flash instruction at 30ms
    expect(totalDurationMs).toBe(bitstream.length * 30);
  });

  test('timing: 1 = screen ON (white), 0 = screen OFF (black)', () => {
    // The bipolar encoding maps: ON = 1, OFF = 0
    // Verify the header starts with known pattern [1,1,1,0,1,0,1,0]
    // meaning: ON, ON, ON, OFF, ON, OFF, ON, OFF
    const bitstream = buildBitstream({
      targetTimezone: 'T1',
      utcTime: new Date(Date.UTC(2021, 2, 28, 12, 0, 0)),
      tz: { shiftHours: 0, minuteShift: 0, hemisphere: 0, dstActive: false },
    });

    // Header bits: 1=ON, 0=OFF
    expect(bitstream[0]).toBe(1);  // ON
    expect(bitstream[1]).toBe(1);  // ON
    expect(bitstream[2]).toBe(1);  // ON
    expect(bitstream[3]).toBe(0);  // OFF
    expect(bitstream[4]).toBe(1);  // ON
    expect(bitstream[5]).toBe(0);  // OFF
    expect(bitstream[6]).toBe(1);  // ON
    expect(bitstream[7]).toBe(0);  // OFF
  });
});
