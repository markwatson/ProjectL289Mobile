import ExpoModulesCore
import AVFoundation

public class NativeTorchTransmitterModule: Module {
  public func definition() -> ModuleDefinition {
    Name("NativeTorchTransmitter")

    AsyncFunction("transmitBitstream") { (bitstream: [Int], bitPeriodMs: Double, offsetMs: Double, promise: Promise) in
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
      case .denied:
        promise.reject("E_NO_PERMISSION", "Camera permission denied — enable in Settings > Privacy > Camera")
      case .restricted:
        promise.reject("E_NO_PERMISSION", "Camera access is restricted on this device")
      @unknown default:
        promise.reject("E_NO_PERMISSION", "Camera permission unavailable (unknown status)")
      }
    }
  }

  private func doTransmit(bitstream: [Int], bitPeriodMs: Double, offsetMs: Double, promise: Promise) {
    guard let device = AVCaptureDevice.default(for: .video) else {
      promise.reject("E_NO_DEVICE", "No video capture device found")
      return
    }
    guard device.hasTorch else {
      promise.reject("E_NO_FLASH", "This device does not have a torch")
      return
    }
    guard device.isTorchAvailable else {
      promise.reject("E_TORCH_UNAVAILABLE", "Torch is temporarily unavailable (device may be overheating)")
      return
    }

    let bits = bitstream
    let periodNs = UInt64(bitPeriodMs * 1_000_000)
    let offsetNs = UInt64(offsetMs * 1_000_000)

    let thread = Thread {
      var periods: [UInt64] = []
      var locked = false
      var torchError: Error? = nil

      do {
        try device.lockForConfiguration()
        locked = true

        func torchOn() throws {
          try device.setTorchModeOn(level: AVCaptureDevice.maxAvailableTorchLevel)
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

        try torchOn()
        let wakeStart = mach_absolute_time()
        while mach_absolute_time() < wakeStart + wakeOnAbs { /* spin */ }

        torchOff()
        let gapStart = mach_absolute_time()
        while mach_absolute_time() < gapStart + wakeGapAbs { /* spin */ }

        // === Payload transmission ===
        // Pre-compute expected durations using the offset compensation algorithm
        let expectedDurations = OffsetCompensation.computeBitDurations(
          bits: bits, periodNs: periodNs, offsetNs: offsetNs
        ).map { nanosToAbs($0) }

        var nextDeadline = mach_absolute_time() + expectedDurations[0]

        if !bits.isEmpty {
          if bits[0] == 1 {
            try torchOn()
          } else {
            torchOff()
          }
        }

        for i in 1..<bits.count {
          while mach_absolute_time() < nextDeadline { /* spin */ }

          let actualTime = mach_absolute_time()
          periods.append(absToNanos(actualTime - (nextDeadline - expectedDurations[i - 1])))

          if bits[i] == 1 {
            try torchOn()
          } else {
            torchOff()
          }

          nextDeadline = actualTime + expectedDurations[i]
        }

        while mach_absolute_time() < nextDeadline { /* spin */ }

        torchOff()
        device.unlockForConfiguration()
        locked = false

        // Timing stats
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
        promise.reject("E_TRANSMIT_FAILED", "Torch transmission failed: \(error.localizedDescription)")
      }
    }

    thread.qualityOfService = .userInteractive
    thread.name = "WOP-TorchTransmitter"
    thread.start()
  }
}
