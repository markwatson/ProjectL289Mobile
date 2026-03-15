package expo.modules.nativetorchtransmitter

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Unit tests for the offset compensation algorithm.
 * Mirrors the TypeScript tests in src/__tests__/offsetCompensation.test.ts.
 */
class OffsetCompensationTest {

  private val periodNs = 30_000_000L  // 30ms
  private val offsetNs = 8_000_000L   // 8ms

  private fun ms(value: Long) = value * 1_000_000L

  @Test
  fun zeroOffsetProducesUniformDurations() {
    val bits = intArrayOf(1, 1, 0, 1, 0, 0, 1, 0)
    val durations = OffsetCompensation.computeBitDurations(bits, periodNs, 0)
    for (d in durations) {
      assertEquals(periodNs, d)
    }
  }

  @Test
  fun offset8msAltersDurationsAroundRisingEdges() {
    val bits = intArrayOf(0, 1, 0, 1)
    val durations = OffsetCompensation.computeBitDurations(bits, periodNs, offsetNs)

    // bit 0: first bit, value=0 → no adjustment
    assertEquals(ms(30), durations[0])
    // bit 1: rising edge (0→1) → extended
    assertEquals(ms(38), durations[1])
    // bit 2: value=0, next=1 → shortened
    assertEquals(ms(22), durations[2])
    // bit 3: rising edge (0→1) → extended
    assertEquals(ms(38), durations[3])
  }

  @Test
  fun fallingEdgesAreNotCompensated() {
    val bits = intArrayOf(1, 0, 1, 0)
    val durations = OffsetCompensation.computeBitDurations(bits, periodNs, offsetNs)

    // bit 0: first bit is 1 (rising from implicit off) → extended
    assertEquals(ms(38), durations[0])
    // bit 1: value=0, next=1 → shortened
    assertEquals(ms(22), durations[1])
    // bit 2: rising edge (0→1) → extended
    assertEquals(ms(38), durations[2])
    // bit 3: value=0, next=0 (implicit) → no adjustment
    assertEquals(ms(30), durations[3])
  }

  @Test
  fun consecutiveSameValueBitsAreNotAdjusted() {
    val bits = intArrayOf(0, 0, 0, 1, 1, 1, 0, 0)
    val durations = OffsetCompensation.computeBitDurations(bits, periodNs, offsetNs)

    assertEquals(ms(30), durations[0])
    assertEquals(ms(30), durations[1])
    assertEquals(ms(22), durations[2]) // about to rise
    assertEquals(ms(38), durations[3]) // rising edge
    assertEquals(ms(30), durations[4])
    assertEquals(ms(30), durations[5])
    assertEquals(ms(30), durations[6])
    assertEquals(ms(30), durations[7])
  }

  @Test
  fun firstBitOneIsTreatedAsRisingEdge() {
    val bits = intArrayOf(1, 0, 0)
    val durations = OffsetCompensation.computeBitDurations(bits, periodNs, ms(10))

    assertEquals(ms(40), durations[0]) // rising from off → extended
    assertEquals(ms(30), durations[1])
    assertEquals(ms(30), durations[2])
  }

  @Test
  fun firstBitZeroIsNotAdjusted() {
    val bits = intArrayOf(0, 0, 1)
    val durations = OffsetCompensation.computeBitDurations(bits, periodNs, ms(10))

    assertEquals(ms(30), durations[0]) // first bit, no adjustment
    assertEquals(ms(20), durations[1]) // about to rise
    assertEquals(ms(40), durations[2]) // rising edge
  }

  @Test
  fun realisticWopHeader() {
    val header = intArrayOf(1, 1, 1, 0, 1, 0, 1, 0)
    val durations = OffsetCompensation.computeBitDurations(header, periodNs, offsetNs)

    assertEquals(ms(38), durations[0]) // first 1, rising from off
    assertEquals(ms(30), durations[1]) // 1→1
    assertEquals(ms(30), durations[2]) // 1→1
    assertEquals(ms(22), durations[3]) // 0, next=1
    assertEquals(ms(38), durations[4]) // rising edge
    assertEquals(ms(22), durations[5]) // 0, next=1
    assertEquals(ms(38), durations[6]) // rising edge
    assertEquals(ms(30), durations[7]) // 0, end
  }

  @Test
  fun emptyBitstream() {
    val durations = OffsetCompensation.computeBitDurations(intArrayOf(), periodNs, offsetNs)
    assertEquals(0, durations.size)
  }

  @Test
  fun singleBitBitstream() {
    val d0 = OffsetCompensation.computeBitDurations(intArrayOf(0), periodNs, offsetNs)
    assertEquals(1, d0.size)
    assertEquals(ms(30), d0[0])

    val d1 = OffsetCompensation.computeBitDurations(intArrayOf(1), periodNs, offsetNs)
    assertEquals(1, d1.size)
    assertEquals(ms(38), d1[0])
  }
}
