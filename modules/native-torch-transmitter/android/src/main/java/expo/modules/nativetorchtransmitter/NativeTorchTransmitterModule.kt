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
          // Asymmetric offset compensation, matching the original manufacturer's app:
          //
          // The offset shortens 0-bits immediately before a rising edge (0→1 transition)
          // and lengthens 1-bits immediately after a rising edge.
          //
          // This compensates for LED rise-time latency: the "on" command is sent
          // earlier (0-bit shortened) and held longer (1-bit extended) so the
          // physical light output aligns with the intended bit boundaries.

          var nextDeadline = System.nanoTime() + periodNs
          var offsetApplied = false

          // Handle first bit
          if (bits.isNotEmpty()) {
            cameraManager.setTorchMode(camId, bits[0] == 1)
            // If first bit is 1, it's a rising edge from implicit off state
            if (bits[0] == 1) {
              nextDeadline += offsetNs
              offsetApplied = true
            }
          }

          for (i in 1 until bits.size) {
            // Busy-wait until deadline
            while (System.nanoTime() < nextDeadline) {
              // spin
            }

            val actualTime = System.nanoTime()
            periods.add(actualTime - (nextDeadline - periodNs))

            val currentBit = bits[i]
            val prevBit = bits[i - 1]
            val nextBit = if (i < bits.size - 1) bits[i + 1] else 0

            cameraManager.setTorchMode(camId, currentBit == 1)

            // Calculate next deadline with offset compensation
            nextDeadline = actualTime + periodNs

            offsetApplied = false
            // Rising edge: prev=0, current=1 — extend this 1-bit
            if (prevBit == 0 && currentBit == 1) {
              nextDeadline += offsetNs
              offsetApplied = true
            }
            // About to rise: current=0, next=1 — shorten this 0-bit
            if (currentBit == 0 && nextBit == 1) {
              nextDeadline -= offsetNs
            }
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
