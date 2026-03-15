import XCTest
@testable import OffsetCompensation

/// Unit tests for the offset compensation algorithm.
/// Mirrors the TypeScript tests in src/__tests__/offsetCompensation.test.ts
/// and the Kotlin tests in OffsetCompensationTest.kt.
final class OffsetCompensationTests: XCTestCase {

  let periodNs: UInt64 = 30_000_000  // 30ms
  let offsetNs: UInt64 = 8_000_000   // 8ms

  func ms(_ value: UInt64) -> UInt64 { value * 1_000_000 }

  func testZeroOffsetProducesUniformDurations() {
    let bits = [1, 1, 0, 1, 0, 0, 1, 0]
    let durations = OffsetCompensation.computeBitDurations(bits: bits, periodNs: periodNs, offsetNs: 0)
    for d in durations {
      XCTAssertEqual(d, periodNs)
    }
  }

  func testOffset8msAltersDurationsAroundRisingEdges() {
    let bits = [0, 1, 0, 1]
    let durations = OffsetCompensation.computeBitDurations(bits: bits, periodNs: periodNs, offsetNs: offsetNs)

    XCTAssertEqual(durations[0], ms(30))  // first bit, no adjustment
    XCTAssertEqual(durations[1], ms(38))  // rising edge → extended
    XCTAssertEqual(durations[2], ms(22))  // about to rise → shortened
    XCTAssertEqual(durations[3], ms(38))  // rising edge → extended
  }

  func testFallingEdgesAreNotCompensated() {
    let bits = [1, 0, 1, 0]
    let durations = OffsetCompensation.computeBitDurations(bits: bits, periodNs: periodNs, offsetNs: offsetNs)

    XCTAssertEqual(durations[0], ms(38))  // first 1, rising from off
    XCTAssertEqual(durations[1], ms(22))  // 0, next=1 → shortened
    XCTAssertEqual(durations[2], ms(38))  // rising edge
    XCTAssertEqual(durations[3], ms(30))  // 0, end → normal
  }

  func testConsecutiveSameValueBitsAreNotAdjusted() {
    let bits = [0, 0, 0, 1, 1, 1, 0, 0]
    let durations = OffsetCompensation.computeBitDurations(bits: bits, periodNs: periodNs, offsetNs: offsetNs)

    XCTAssertEqual(durations[0], ms(30))
    XCTAssertEqual(durations[1], ms(30))
    XCTAssertEqual(durations[2], ms(22))  // about to rise
    XCTAssertEqual(durations[3], ms(38))  // rising edge
    XCTAssertEqual(durations[4], ms(30))
    XCTAssertEqual(durations[5], ms(30))
    XCTAssertEqual(durations[6], ms(30))
    XCTAssertEqual(durations[7], ms(30))
  }

  func testFirstBitOneIsTreatedAsRisingEdge() {
    let bits = [1, 0, 0]
    let durations = OffsetCompensation.computeBitDurations(bits: bits, periodNs: periodNs, offsetNs: ms(10))

    XCTAssertEqual(durations[0], ms(40))
    XCTAssertEqual(durations[1], ms(30))
    XCTAssertEqual(durations[2], ms(30))
  }

  func testFirstBitZeroIsNotAdjusted() {
    let bits = [0, 0, 1]
    let durations = OffsetCompensation.computeBitDurations(bits: bits, periodNs: periodNs, offsetNs: ms(10))

    XCTAssertEqual(durations[0], ms(30))
    XCTAssertEqual(durations[1], ms(20))
    XCTAssertEqual(durations[2], ms(40))
  }

  func testRealisticWopHeader() {
    let header = [1, 1, 1, 0, 1, 0, 1, 0]
    let durations = OffsetCompensation.computeBitDurations(bits: header, periodNs: periodNs, offsetNs: offsetNs)

    XCTAssertEqual(durations[0], ms(38))  // first 1, rising from off
    XCTAssertEqual(durations[1], ms(30))  // 1→1
    XCTAssertEqual(durations[2], ms(30))  // 1→1
    XCTAssertEqual(durations[3], ms(22))  // 0, next=1
    XCTAssertEqual(durations[4], ms(38))  // rising edge
    XCTAssertEqual(durations[5], ms(22))  // 0, next=1
    XCTAssertEqual(durations[6], ms(38))  // rising edge
    XCTAssertEqual(durations[7], ms(30))  // 0, end
  }

  func testEmptyBitstream() {
    let durations = OffsetCompensation.computeBitDurations(bits: [], periodNs: periodNs, offsetNs: offsetNs)
    XCTAssertEqual(durations.count, 0)
  }

  func testSingleBitBitstream() {
    let d0 = OffsetCompensation.computeBitDurations(bits: [0], periodNs: periodNs, offsetNs: offsetNs)
    XCTAssertEqual(d0.count, 1)
    XCTAssertEqual(d0[0], ms(30))

    let d1 = OffsetCompensation.computeBitDurations(bits: [1], periodNs: periodNs, offsetNs: offsetNs)
    XCTAssertEqual(d1.count, 1)
    XCTAssertEqual(d1[0], ms(38))
  }
}
