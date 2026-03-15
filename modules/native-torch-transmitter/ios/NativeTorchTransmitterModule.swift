import ExpoModulesCore
import AVFoundation

public class NativeTorchTransmitterModule: Module {
  public func definition() -> ModuleDefinition {
    Name("NativeTorchTransmitter")

    AsyncFunction("transmitBitstream") { (bitstream: [Int], bitPeriodMs: Double, offsetMs: Double, promise: Promise) in
      // Request camera permission first (torch requires camera access on iOS)
      let status = AVCaptureDevice.authorizationStatus(for: .video)
      switch status {
      case .notDetermined:
        AVCaptureDevice.requestAccess(for: .video) { granted in
          if granted {
            self.doTransmit(bitstream: bitstream, bitPeriodMs: bitPeriodMs, offsetMs: offsetMs, promise: promise)
          } else {
            promise.reject("E_NO_PERMISSION", "Camera permission denied — required for torch access")
          }
        }
      case .authorized:
        self.doTransmit(bitstream: bitstream, bitPeriodMs: bitPeriodMs, offsetMs: offsetMs, promise: promise)
      default:
        promise.reject("E_NO_PERMISSION", "Camera permission denied — required for torch access")
      }
    }
  }

  private func doTransmit(bitstream: [Int], bitPeriodMs: Double, offsetMs: Double, promise: Promise) {
    guard let device = AVCaptureDevice.default(for: .video), device.hasTorch else {
      promise.reject("E_NO_FLASH", "No torch available on this device")
      return
    }

    let bits = bitstream
    let periodNs = UInt64(bitPeriodMs * 1_000_000)
    let offsetNs = UInt64(offsetMs * 1_000_000)

    let thread = Thread {
      var periods: [UInt64] = []
      var locked = false

      do {
        try device.lockForConfiguration()
        locked = true

        func torchOn() {
          try? device.setTorchModeOn(level: AVCaptureDevice.maxAvailableTorchLevel)
        }
        func torchOff() {
          device.torchMode = .off
        }

        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        let numer = UInt64(info.numer)
        let denom = UInt64(info.denom)

        func nanosToAbs(_ ns: UInt64) -> UInt64 {
          return ns * denom / numer
        }

        func absToNanos(_ abs: UInt64) -> UInt64 {
          return abs * numer / denom
        }

        let periodAbs = nanosToAbs(periodNs)
        let offsetAbs = nanosToAbs(offsetNs)

        // === Wake-up pulse: 200ms ON, 50ms OFF ===
        let wakeOnAbs = nanosToAbs(200_000_000)
        let wakeGapAbs = nanosToAbs(50_000_000)

        torchOn()
        let wakeStart = mach_absolute_time()
        while mach_absolute_time() < wakeStart + wakeOnAbs { /* spin */ }

        torchOff()
        let gapStart = mach_absolute_time()
        while mach_absolute_time() < gapStart + wakeGapAbs { /* spin */ }

        // === Payload transmission ===
        var nextDeadline = mach_absolute_time() + periodAbs

        // Handle first bit
        if !bits.isEmpty {
          if bits[0] == 1 {
            torchOn()
            nextDeadline += offsetAbs
          } else {
            torchOff()
          }
        }

        for i in 1..<bits.count {
          // Busy-wait until deadline
          while mach_absolute_time() < nextDeadline {
            // spin
          }

          let actualTime = mach_absolute_time()
          periods.append(absToNanos(actualTime - (nextDeadline - periodAbs)))

          let currentBit = bits[i]
          let prevBit = bits[i - 1]
          let nextBit = (i < bits.count - 1) ? bits[i + 1] : 0

          if currentBit == 1 {
            torchOn()
          } else {
            torchOff()
          }

          // Calculate next deadline with offset compensation
          nextDeadline = actualTime + periodAbs

          // Rising edge: prev=0, current=1 — extend this 1-bit
          if prevBit == 0 && currentBit == 1 {
            nextDeadline += offsetAbs
          }
          // About to rise: current=0, next=1 — shorten this 0-bit
          if currentBit == 0 && nextBit == 1 {
            nextDeadline -= offsetAbs
          }
        }

        // Wait for last bit to complete
        while mach_absolute_time() < nextDeadline {
          // spin
        }

        // Ensure torch is off
        torchOff()
        device.unlockForConfiguration()
        locked = false

        // Calculate timing stats
        let periodMs = periods.map { Double($0) / 1_000_000.0 }
        let mean = periodMs.isEmpty ? 0.0 : periodMs.reduce(0, +) / Double(periodMs.count)
        let variance = periodMs.count > 1
          ? periodMs.map { ($0 - mean) * ($0 - mean) }.reduce(0, +) / Double(periodMs.count)
          : 0.0
        let stdDev = variance.squareRoot()
        let minP = periodMs.min() ?? 0.0
        let maxP = periodMs.max() ?? 0.0

        let result: [String: Any] = [
          "meanPeriodMs": mean,
          "stdDevMs": stdDev,
          "minPeriodMs": minP,
          "maxPeriodMs": maxP,
          "totalBits": bits.count,
        ]

        promise.resolve(result)
      } catch {
        if locked {
          device.torchMode = .off
          device.unlockForConfiguration()
        }
        promise.reject("E_TRANSMIT_FAILED", "Transmission failed: \(error.localizedDescription)")
      }
    }

    thread.qualityOfService = .userInteractive
    thread.name = "WOP-TorchTransmitter"
    thread.start()
  }
}
