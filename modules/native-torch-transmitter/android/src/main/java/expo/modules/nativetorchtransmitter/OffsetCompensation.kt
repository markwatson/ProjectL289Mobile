package expo.modules.nativetorchtransmitter

/**
 * Pure computation of bit durations with asymmetric offset compensation.
 *
 * The offset shortens 0-bits immediately before a rising edge (0→1 transition)
 * and lengthens 1-bits immediately after a rising edge. This compensates for
 * LED rise-time latency so the physical light output aligns with intended
 * bit boundaries.
 *
 * This file has no Android dependencies and can be unit-tested with JUnit.
 */
object OffsetCompensation {

  /**
   * Compute the duration (in nanoseconds) of each bit in the transmitted signal.
   *
   * @param bits      The bitstream to transmit (0s and 1s)
   * @param periodNs  Nominal bit period in nanoseconds
   * @param offsetNs  Offset compensation in nanoseconds
   * @return Array of durations, one per bit
   */
  fun computeBitDurations(bits: IntArray, periodNs: Long, offsetNs: Long): LongArray {
    if (bits.isEmpty()) return LongArray(0)

    val durations = LongArray(bits.size)

    // First bit: only extended if it's a 1 (rising edge from implicit off).
    // No "about to rise" shortening — that only happens in the main loop.
    durations[0] = periodNs + if (bits[0] == 1) offsetNs else 0L

    for (i in 1 until bits.size) {
      val prevBit = bits[i - 1]
      val currentBit = bits[i]
      val nextBit = if (i < bits.size - 1) bits[i + 1] else 0

      var duration = periodNs

      // Rising edge: prev=0, current=1 → extend this 1-bit
      if (prevBit == 0 && currentBit == 1) {
        duration += offsetNs
      }
      // About to rise: current=0, next=1 → shorten this 0-bit
      if (currentBit == 0 && nextBit == 1) {
        duration -= offsetNs
      }

      durations[i] = duration
    }

    return durations
  }
}
