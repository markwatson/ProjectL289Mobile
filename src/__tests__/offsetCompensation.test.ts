/**
 * Tests for the LED offset compensation algorithm.
 *
 * The native torch transmitter (Kotlin) applies asymmetric timing compensation
 * to account for LED rise-time latency. This test file models the algorithm in
 * TypeScript to verify its behavior and serve as a reference specification for
 * anyone porting to another platform (e.g., iOS Swift).
 *
 * Algorithm summary:
 *   - 0-bits immediately before a rising edge (0→1) are shortened by offsetMs
 *   - 1-bits immediately after a rising edge (0→1) are lengthened by offsetMs
 *   - This causes the "on" command to fire earlier and hold longer, so the
 *     physical light output aligns with the intended bit boundaries.
 */

const DEFAULT_BIT_PERIOD = 30; // ms

/**
 * Pure TypeScript model of the Kotlin offset compensation algorithm.
 * Returns the duration (in ms) of each bit in the transmitted signal.
 *
 * This mirrors NativeTorchTransmitterModule.kt's deadline logic exactly.
 */
function computeBitDurations(
  bitstream: number[],
  bitPeriodMs: number,
  offsetMs: number,
): number[] {
  if (bitstream.length === 0) return [];

  const durations: number[] = [];

  // First bit is handled outside the main loop (matches Kotlin).
  // Only adjustment: if first bit is 1, it's a rising edge from implicit
  // off state → extend. No "about to rise" shortening for the first bit.
  let currentDuration = bitPeriodMs;
  if (bitstream[0] === 1) {
    currentDuration += offsetMs;
  }

  for (let i = 1; i < bitstream.length; i++) {
    durations.push(currentDuration);

    const prevBit = bitstream[i - 1]!;
    const currentBit = bitstream[i]!;
    const nextBit = i < bitstream.length - 1 ? bitstream[i + 1]! : 0;

    currentDuration = bitPeriodMs;

    // Rising edge: prev=0, current=1 → extend this 1-bit
    if (prevBit === 0 && currentBit === 1) {
      currentDuration += offsetMs;
    }
    // About to rise: current=0, next=1 → shorten this 0-bit
    if (currentBit === 0 && nextBit === 1) {
      currentDuration -= offsetMs;
    }
  }

  durations.push(currentDuration);

  return durations;
}

// =============================================================================
// Tests
// =============================================================================

describe('offset compensation algorithm', () => {
  test('zero offset produces uniform bit durations', () => {
    const bits = [1, 1, 0, 1, 0, 0, 1, 0];
    const durations = computeBitDurations(bits, DEFAULT_BIT_PERIOD, 0);

    expect(durations).toEqual(Array(bits.length).fill(DEFAULT_BIT_PERIOD));
  });

  test('offset=8ms alters durations around rising edges', () => {
    //                  0    1    0    1
    // Rising edges at:      ^         ^
    const bits = [0, 1, 0, 1];
    const durations = computeBitDurations(bits, DEFAULT_BIT_PERIOD, 8);

    // bit 0: first bit, value=0 → no adjustment (30ms)
    //   (first bit shortening doesn't happen — only handled in main loop)
    expect(durations[0]).toBe(30);
    // bit 1: rising edge (0→1) → extended (30+8 = 38ms)
    expect(durations[1]).toBe(38);
    // bit 2: value=0, next=1 → shortened (30-8 = 22ms)
    expect(durations[2]).toBe(22);
    // bit 3: rising edge (0→1) → extended (30+8 = 38ms)
    expect(durations[3]).toBe(38);
  });

  test('falling edges (1→0) are not compensated', () => {
    const bits = [1, 0, 1, 0];
    const durations = computeBitDurations(bits, DEFAULT_BIT_PERIOD, 8);

    // bit 0: first bit is 1 (rising from implicit off) → extended
    expect(durations[0]).toBe(38);
    // bit 1: value=0, next=1 → shortened
    expect(durations[1]).toBe(22);
    // bit 2: rising edge (0→1) → extended
    expect(durations[2]).toBe(38);
    // bit 3: value=0, next=0 (implicit) → no adjustment
    expect(durations[3]).toBe(30);
  });

  test('consecutive same-value bits are not adjusted', () => {
    const bits = [0, 0, 0, 1, 1, 1, 0, 0];
    const durations = computeBitDurations(bits, DEFAULT_BIT_PERIOD, 8);

    // bits 0-1: 0→0, not before a rising edge → normal
    expect(durations[0]).toBe(30);
    expect(durations[1]).toBe(30);
    // bit 2: 0, next=1 → shortened
    expect(durations[2]).toBe(22);
    // bit 3: rising edge (0→1) → extended
    expect(durations[3]).toBe(38);
    // bits 4-5: 1→1 and 1→0, no rising edge → normal
    expect(durations[4]).toBe(30);
    expect(durations[5]).toBe(30);
    // bits 6-7: 0→0 → normal
    expect(durations[6]).toBe(30);
    expect(durations[7]).toBe(30);
  });

  test('first bit = 1 is treated as rising edge from implicit off', () => {
    const bits = [1, 0, 0];
    const durations = computeBitDurations(bits, DEFAULT_BIT_PERIOD, 10);

    // bit 0: first bit is 1 → rising from off → extended
    expect(durations[0]).toBe(40);
    // bit 1: 1→0 falling edge, next=0 → normal
    expect(durations[1]).toBe(30);
    // bit 2: normal
    expect(durations[2]).toBe(30);
  });

  test('first bit = 0 is not adjusted', () => {
    const bits = [0, 0, 1];
    const durations = computeBitDurations(bits, DEFAULT_BIT_PERIOD, 10);

    // bit 0: value=0, next=0 → normal
    expect(durations[0]).toBe(30);
    // bit 1: value=0, next=1 → shortened
    expect(durations[1]).toBe(20);
    // bit 2: rising edge → extended
    expect(durations[2]).toBe(40);
  });

  test('total transmission time: first-bit asymmetry adds offsetMs', () => {
    // When the first bit is 0, the shortening for it doesn't happen (only in
    // the main loop), but the extension on the next 1-bit does. So there are
    // 3 extensions (+8 each = +24) but only 2 shortenings (-8 each = -16).
    // Net: +8ms (one offset not cancelled out due to first-bit handling).
    const bits = [0, 1, 0, 1, 0, 1, 0]; // 3 rising edges
    const offset = 8;
    const durations = computeBitDurations(bits, DEFAULT_BIT_PERIOD, offset);
    const totalDuration = durations.reduce((a, b) => a + b, 0);
    const nominalDuration = bits.length * DEFAULT_BIT_PERIOD;

    // First 0-bit is not shortened, so one offset is unbalanced
    expect(totalDuration).toBe(nominalDuration + offset);
  });

  test('realistic WOP header [1,1,1,0,1,0,1,0] with offset=8ms', () => {
    const header = [1, 1, 1, 0, 1, 0, 1, 0];
    const durations = computeBitDurations(header, DEFAULT_BIT_PERIOD, 8);

    // bit 0: 1, first bit → rising from off → extended (38)
    expect(durations[0]).toBe(38);
    // bit 1: 1→1, no edge → normal (30)
    expect(durations[1]).toBe(30);
    // bit 2: 1→1, no edge → normal (30)
    expect(durations[2]).toBe(30);
    // bit 3: 0, next=1 → shortened (22)
    expect(durations[3]).toBe(22);
    // bit 4: rising edge (0→1) → extended (38)
    expect(durations[4]).toBe(38);
    // bit 5: 0, next=1 → shortened (22)
    expect(durations[5]).toBe(22);
    // bit 6: rising edge (0→1) → extended (38)
    expect(durations[6]).toBe(38);
    // bit 7: 0, next=0 (implicit end) → normal (30)
    expect(durations[7]).toBe(30);
  });

  test('large offset (15ms) does not produce negative durations', () => {
    const bits = [0, 1, 0, 1];
    const durations = computeBitDurations(bits, DEFAULT_BIT_PERIOD, 15);

    for (const d of durations) {
      expect(d).toBeGreaterThanOrEqual(0);
    }
    // First 0-bit: no adjustment (first bit handled outside loop)
    expect(durations[0]).toBe(30);
    // Shortened 0-bit (bit 2, in loop): 30 - 15 = 15ms
    expect(durations[2]).toBe(15);
  });

  test('offset at boundary (30ms = full bit period) produces zero-length 0-bits in loop', () => {
    // Two 0-bits then a 1: only the second 0 (in-loop) gets shortened
    const bits = [0, 0, 1];
    const durations = computeBitDurations(bits, DEFAULT_BIT_PERIOD, 30);

    // bit 0: first bit, no shortening
    expect(durations[0]).toBe(30);
    // bit 1: in loop, 0 before rising edge → 30-30 = 0ms
    expect(durations[1]).toBe(0);
    // bit 2: rising edge → 30+30 = 60ms
    expect(durations[2]).toBe(60);
  });

  test('different bit periods work correctly', () => {
    const bits = [0, 0, 1, 0];
    const durations = computeBitDurations(bits, 50, 10);

    expect(durations[0]).toBe(50); // first bit, no adjustment
    expect(durations[1]).toBe(40); // 50 - 10 (about to rise)
    expect(durations[2]).toBe(60); // 50 + 10 (rising edge)
    expect(durations[3]).toBe(50); // no adjustment
  });

  test('single bit bitstream', () => {
    expect(computeBitDurations([0], 30, 8)).toEqual([30]);
    expect(computeBitDurations([1], 30, 8)).toEqual([38]); // rising from off
  });

  test('empty bitstream', () => {
    expect(computeBitDurations([], 30, 8)).toEqual([]);
  });
});
