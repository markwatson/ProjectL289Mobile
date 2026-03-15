package expo.modules.nativetorchtransmitter

import android.content.Context
import android.hardware.camera2.CameraAccessException
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise

class NativeTorchTransmitterModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("NativeTorchTransmitter")

    AsyncFunction("transmitBitstream") {
        bitstream: List<Int>, bitPeriodMs: Double, offsetMs: Double, promise: Promise ->

      val cameraManager = context.getSystemService(Context.CAMERA_SERVICE) as? CameraManager
      if (cameraManager == null) {
        promise.reject("E_NO_CAMERA", "CameraManager unavailable", null)
        return@AsyncFunction
      }

      // Find back camera with flash
      var cameraId: String? = null
      try {
        for (id in cameraManager.cameraIdList) {
          val chars = cameraManager.getCameraCharacteristics(id)
          val hasFlash = chars.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) ?: false
          val isBack = chars.get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK
          if (hasFlash && isBack) {
            cameraId = id
            break
          }
        }
      } catch (e: CameraAccessException) {
        promise.reject("E_CAMERA_ACCESS", "Failed to access camera: ${e.message}", e)
        return@AsyncFunction
      }

      if (cameraId == null) {
        promise.reject("E_NO_FLASH", "No back camera with flash found", null)
        return@AsyncFunction
      }

      val camId = cameraId
      val bits = bitstream.toIntArray()
      val periodNs = (bitPeriodMs * 1_000_000).toLong()
      val offsetNs = (offsetMs * 1_000_000).toLong()

      val thread = Thread {
        val periods = mutableListOf<Long>()
        try {
          // Pre-compute expected durations using the offset compensation algorithm
          val expectedDurations = OffsetCompensation.computeBitDurations(bits, periodNs, offsetNs)

          var nextDeadline = System.nanoTime() + expectedDurations[0]

          // Handle first bit
          if (bits.isNotEmpty()) {
            cameraManager.setTorchMode(camId, bits[0] == 1)
          }

          for (i in 1 until bits.size) {
            // Busy-wait until deadline
            while (System.nanoTime() < nextDeadline) {
              // spin
            }

            val actualTime = System.nanoTime()
            periods.add(actualTime - (nextDeadline - expectedDurations[i - 1]))

            cameraManager.setTorchMode(camId, bits[i] == 1)

            nextDeadline = actualTime + expectedDurations[i]
          }

          // Wait for last bit to complete
          while (System.nanoTime() < nextDeadline) {
            // spin
          }

          // Ensure torch is off
          cameraManager.setTorchMode(camId, false)

          // Calculate timing stats
          val periodMs = periods.map { it / 1_000_000.0 }
          val mean = if (periodMs.isNotEmpty()) periodMs.average() else 0.0
          val variance = if (periodMs.size > 1) {
            periodMs.map { (it - mean) * (it - mean) }.average()
          } else 0.0
          val stdDev = Math.sqrt(variance)
          val minP = periodMs.minOrNull() ?: 0.0
          val maxP = periodMs.maxOrNull() ?: 0.0

          val result = mapOf(
            "meanPeriodMs" to mean,
            "stdDevMs" to stdDev,
            "minPeriodMs" to minP,
            "maxPeriodMs" to maxP,
            "totalBits" to bits.size
          )

          promise.resolve(result)
        } catch (e: Exception) {
          try { cameraManager.setTorchMode(camId, false) } catch (_: Exception) {}
          promise.reject("E_TRANSMIT_FAILED", "Transmission failed: ${e.message}", e)
        }
      }

      thread.priority = Thread.MAX_PRIORITY
      thread.name = "WOP-TorchTransmitter"
      thread.start()
    }
  }

  private val context
    get() = requireNotNull(appContext.reactContext) { "Context is not available." }
}
