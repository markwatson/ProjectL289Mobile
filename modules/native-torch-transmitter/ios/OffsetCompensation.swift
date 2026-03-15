import Foundation

/// Pure computation of bit durations with asymmetric offset compensation.
///
/// The offset shortens 0-bits immediately before a rising edge (0→1 transition)
/// and lengthens 1-bits immediately after a rising edge. This compensates for
/// LED rise-time latency so the physical light output aligns with intended
/// bit boundaries.
///
/// This file has no AVFoundation/UIKit dependencies and can be unit-tested.
enum OffsetCompensation {

  /// Compute the duration (in nanoseconds) of each bit in the transmitted signal.
  ///
  /// - Parameters:
  ///   - bits: The bitstream to transmit (0s and 1s)
  ///   - periodNs: Nominal bit period in nanoseconds
  ///   - offsetNs: Offset compensation in nanoseconds
  /// - Returns: Array of durations, one per bit
  static func computeBitDurations(bits: [Int], periodNs: UInt64, offsetNs: UInt64) -> [UInt64] {
    if bits.isEmpty { return [] }

    var durations = [UInt64](repeating: 0, count: bits.count)

    // First bit: only extended if it's a 1 (rising edge from implicit off).
    // No "about to rise" shortening — that only happens in the main loop.
    durations[0] = periodNs + (bits[0] == 1 ? offsetNs : 0)

    for i in 1..<bits.count {
      let prevBit = bits[i - 1]
      let currentBit = bits[i]
      let nextBit = (i < bits.count - 1) ? bits[i + 1] : 0

      var duration = periodNs

      // Rising edge: prev=0, current=1 → extend this 1-bit
      if prevBit == 0 && currentBit == 1 {
        duration += offsetNs
      }
      // About to rise: current=0, next=1 → shorten this 0-bit
      if currentBit == 0 && nextBit == 1 {
        duration -= offsetNs
      }

      durations[i] = duration
    }

    return durations
  }
}
