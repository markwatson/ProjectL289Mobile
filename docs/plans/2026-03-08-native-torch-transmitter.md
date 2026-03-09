# Native Torch Transmitter Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the JS-based requestAnimationFrame torch transmission with a native Kotlin module that uses a max-priority busy-wait thread for precise 30ms bit timing, matching the original Longines app's approach.

**Architecture:** A local Expo module (`modules/native-torch-transmitter/`) provides a single async function `transmitBitstream(bitstream, bitPeriodMs, offsetMs)` that runs the entire torch transmission on a dedicated high-priority thread using `CameraManager.setTorchMode()` with `System.nanoTime()` busy-wait loops. The offset implements asymmetric timing compensation (shortening 0-bits before rising edges, lengthening 1-bits after rising edges) to compensate for LED rise-time latency. A thin JS wrapper (`src/nativeTorchTransmitter.ts`) imports the native module. The UI adds a torch offset slider visible only in torch mode.

**Tech Stack:** Expo Modules API (Kotlin), React Native, CameraManager (Camera2 API)

---

### Task 1: Create the native Kotlin Expo module

**Files:**
- Create: `modules/native-torch-transmitter/expo-module.config.json`
- Create: `modules/native-torch-transmitter/android/build.gradle`
- Create: `modules/native-torch-transmitter/android/src/main/AndroidManifest.xml`
- Create: `modules/native-torch-transmitter/android/src/main/java/expo/modules/nativetorchtransmitter/NativeTorchTransmitterModule.kt`
- Create: `modules/native-torch-transmitter/src/NativeTorchTransmitterModule.ts`
- Create: `modules/native-torch-transmitter/src/index.ts`

**Step 1: Create `modules/native-torch-transmitter/expo-module.config.json`**

```json
{
  "platforms": ["android"],
  "android": {
    "modules": ["expo.modules.nativetorchtransmitter.NativeTorchTransmitterModule"]
  }
}
```

**Step 2: Create `modules/native-torch-transmitter/android/build.gradle`**

```groovy
apply plugin: 'com.android.library'
apply plugin: 'kotlin-android'

group = 'expo.modules.nativetorchtransmitter'
version = '0.1.0'

buildscript {
  def expoModulesCorePlugin = new File(project(":expo-modules-core").projectDir.absolutePath, "ExpoModulesCorePlugin.gradle")
  if (expoModulesCorePlugin.exists()) {
    apply from: expoModulesCorePlugin
    applyKotlinExpoModulesCorePlugin()
  }

  ext.safeExtGet = { prop, fallback ->
    rootProject.ext.has(prop) ? rootProject.ext.get(prop) : fallback
  }

  ext.getKotlinVersion = {
    if (ext.has("kotlinVersion")) {
      ext.kotlinVersion()
    } else {
      ext.safeExtGet("kotlinVersion", "1.8.10")
    }
  }

  repositories {
    mavenCentral()
  }

  dependencies {
    classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:${getKotlinVersion()}")
  }
}

android {
  compileSdkVersion safeExtGet("compileSdkVersion", 34)

  def agpVersion = com.android.Version.ANDROID_GRADLE_PLUGIN_VERSION
  if (agpVersion.tokenize('.')[0].toInteger() < 8) {
    compileOptions {
      sourceCompatibility JavaVersion.VERSION_11
      targetCompatibility JavaVersion.VERSION_11
    }
    kotlinOptions {
      jvmTarget = JavaVersion.VERSION_11.majorVersion
    }
  }

  namespace "expo.modules.nativetorchtransmitter"
  defaultConfig {
    minSdkVersion safeExtGet("minSdkVersion", 21)
    targetSdkVersion safeExtGet("targetSdkVersion", 34)
    versionCode 1
    versionName "0.1.0"
  }
  lintOptions {
    abortOnError false
  }
}

repositories {
  mavenCentral()
}

dependencies {
  implementation project(':expo-modules-core')
  implementation "org.jetbrains.kotlin:kotlin-stdlib-jdk7:${getKotlinVersion()}"
}
```

**Step 3: Create `modules/native-torch-transmitter/android/src/main/AndroidManifest.xml`**

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android"/>
```

**Step 4: Create the Kotlin module**

File: `modules/native-torch-transmitter/android/src/main/java/expo/modules/nativetorchtransmitter/NativeTorchTransmitterModule.kt`

This is the core of the feature. The `transmitBitstream` function:
- Receives `bitstream: List<Int>`, `bitPeriodMs: Double`, `offsetMs: Double`
- Finds the back-facing camera with flash
- Spawns a max-priority thread
- Busy-waits with `System.nanoTime()` for precise timing
- Implements asymmetric offset compensation matching the original app's `Encoder.encode()`:
  - When transitioning 0→1 (rising edge): shorten the preceding 0-bit by `offsetMs`
  - When transitioning 1→0 (falling edge): the preceding 1-bit was already lengthened by `offsetMs`
- Returns timing stats as a Map

```kotlin
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
          // Asymmetric offset compensation, matching the original Longines Encoder.encode():
          //
          // The offset shortens 0-bits immediately before a rising edge (0→1 transition)
          // and lengthens 1-bits immediately after a rising edge.
          //
          // This compensates for LED rise-time latency: the "on" command is sent
          // earlier (0-bit shortened) and held longer (1-bit extended) so the
          // physical light output aligns with the intended bit boundaries.
          //
          // Variables:
          //   nextDeadline: absolute nanoTime when the current bit period ends
          //   offsetApplied: whether the current 1-bit was extended (after a rising edge)

          var nextDeadline = System.nanoTime() + periodNs
          var offsetApplied = false

          // Handle first bit
          if (bits.isNotEmpty()) {
            cameraManager.setTorchMode(camId, bits[0] == 1)
            // Check if the second bit is a 1 (rising edge from implicit 0 start)
            if (bits[0] == 1 && bits.size > 1 && bits[1] == 1) {
              // First bit is 1, apply offset extension
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
            periods.add(actualTime - (nextDeadline - periodNs - (if (offsetApplied) offsetNs else 0L)))

            val currentBit = bits[i]
            val prevBit = bits[i - 1]
            val nextBit = if (i < bits.size - 1) bits[i + 1] else 0

            cameraManager.setTorchMode(camId, currentBit == 1)

            // Calculate next deadline with offset compensation
            nextDeadline = actualTime + periodNs

            // If this is a rising edge transition (prev=0, current=1):
            // The previous 0-bit was shortened. Now extend this 1-bit.
            offsetApplied = false
            if (prevBit == 0 && currentBit == 1) {
              nextDeadline += offsetNs
              offsetApplied = true
            }
            // If this is a 0-bit and next is a 1-bit (about to rise):
            // Shorten this 0-bit so we send the ON command earlier.
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
```

**Step 5: Create JS bindings**

File: `modules/native-torch-transmitter/src/NativeTorchTransmitterModule.ts`

```typescript
import { requireNativeModule } from "expo-modules-core";

export default requireNativeModule("NativeTorchTransmitter");
```

File: `modules/native-torch-transmitter/src/index.ts`

```typescript
import NativeTorchTransmitterModule from "./NativeTorchTransmitterModule";

export interface TransmitResult {
  meanPeriodMs: number;
  stdDevMs: number;
  minPeriodMs: number;
  maxPeriodMs: number;
  totalBits: number;
}

export async function transmitBitstream(
  bitstream: number[],
  bitPeriodMs: number,
  offsetMs: number,
): Promise<TransmitResult> {
  return NativeTorchTransmitterModule.transmitBitstream(bitstream, bitPeriodMs, offsetMs);
}
```

**Step 6: Commit**

```bash
git add modules/native-torch-transmitter/
git commit -m "feat: add native torch transmitter Expo module

Kotlin module using CameraManager.setTorchMode() on a max-priority
busy-wait thread with asymmetric offset compensation for LED rise-time."
```

---

### Task 2: Create the JS wrapper in src/

**Files:**
- Create: `src/nativeTorchTransmitter.ts`

**Step 1: Create `src/nativeTorchTransmitter.ts`**

This wraps the native module and handles the wake-up pulse + gap natively, plus provides a fallback error if the module isn't available (web/iOS).

```typescript
import { transmitBitstream as nativeTransmit, type TransmitResult } from '../modules/native-torch-transmitter/src';

export type { TransmitResult };

/**
 * Transmit a WOP bitstream via the native torch transmitter.
 * Uses a max-priority thread with busy-wait timing and asymmetric
 * LED offset compensation.
 *
 * The wake-up pulse and gap are handled by the JS layer (same as before)
 * since they don't need sub-millisecond precision.
 */
export async function transmitViaTorch(
  bitstream: number[],
  bitPeriodMs: number,
  offsetMs: number,
): Promise<TransmitResult> {
  return nativeTransmit(bitstream, bitPeriodMs, offsetMs);
}
```

**Step 2: Commit**

```bash
git add src/nativeTorchTransmitter.ts
git commit -m "feat: add JS wrapper for native torch transmitter"
```

---

### Task 3: Wire up the UI — torch offset slider and native transmitter

**Files:**
- Modify: `app/(tabs)/index.tsx`

**Step 1: Add torchOffsetMs state and slider UI**

In `app/(tabs)/index.tsx`, add:
- Import `Slider` from `@react-native-community/slider` (already available via RN) — actually, use a simple TextInput or a custom stepper since we want to avoid adding dependencies. Use a row of preset buttons (0, 2, 5, 8, 10, 13, 15ms) for simplicity.
- `torchOffsetMs` state (default 0)
- Show the offset selector only when `flashMode === 'torch'`
- Replace the `expo-torch`-based transmission with `transmitViaTorch` from the native module
- The wake-up pulse/gap stays in JS (same setTimeout approach) since it doesn't need precision
- After wake-up, call `transmitViaTorch(bitstream, BIT_PERIOD_MS, torchOffsetMs)` instead of `transmit()`

Changes to `startFlash`:
- When `flashMode === 'torch'`: after the positioning delay, build compensated bitstream, wait the messageDelay, do the wake-up pulse (torch on 200ms, off 50ms via expo-torch since those are coarse timings), then call `transmitViaTorch()` for the payload
- When `flashMode === 'screen'`: keep existing behavior unchanged

**Step 2: Implement the changes**

Replace the torch path in `startFlash` to:
1. Build compensated bitstream
2. Wait messageDelay
3. Torch ON (wake-up, 200ms) via expo-torch
4. Torch OFF (gap, 50ms) via expo-torch
5. Call `transmitViaTorch(bitstream, BIT_PERIOD_MS, torchOffsetMs)` — native module handles all payload timing
6. Display timing stats from the native result

Add the offset UI: a row of preset buttons below the flash mode selector, only visible when torch mode is selected.

Add `import { transmitViaTorch, type TransmitResult } from '@/src/nativeTorchTransmitter';` at top.

Add state: `const [torchOffsetMs, setTorchOffsetMs] = useState(0);`

Add UI between flash mode selector and timezone picker:

```tsx
{flashMode === 'torch' && (
  <>
    <Text style={styles.label}>LED Offset ({torchOffsetMs}ms)</Text>
    <View style={styles.offsetRow}>
      {[0, 2, 5, 8, 10, 13, 15].map(v => (
        <TouchableOpacity
          key={v}
          style={[styles.offsetButton, torchOffsetMs === v && styles.offsetButtonActive]}
          onPress={() => setTorchOffsetMs(v)}
        >
          <Text style={[styles.offsetButtonText, torchOffsetMs === v && styles.offsetButtonTextActive]}>
            {v}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  </>
)}
```

Add styles:

```typescript
offsetRow: {
  flexDirection: 'row',
  gap: 8,
  flexWrap: 'wrap',
},
offsetButton: {
  paddingVertical: 8,
  paddingHorizontal: 12,
  borderRadius: 6,
  borderWidth: 1,
  borderColor: '#333',
  backgroundColor: '#16213e',
  minWidth: 38,
  alignItems: 'center',
},
offsetButtonActive: {
  borderColor: '#0a7ea4',
  backgroundColor: '#0a3d5c',
},
offsetButtonText: {
  color: '#888',
  fontSize: 13,
},
offsetButtonTextActive: {
  color: '#fff',
  fontWeight: '600',
},
```

For the torch transmission path in `startFlash`, replace the current `transmit()` call (when `flashMode === 'torch'`) with:

```typescript
if (flashMode === 'torch') {
  // Wake-up pulse via expo-torch (coarse timing is fine here)
  await ExpoTorch?.setStateAsync(ExpoTorch.ON);
  await new Promise(resolve => setTimeout(resolve, 200));
  await ExpoTorch?.setStateAsync(ExpoTorch.OFF);
  await new Promise(resolve => setTimeout(resolve, 50));

  // Native high-precision payload transmission
  try {
    const result = await transmitViaTorch(bitstream, BIT_PERIOD_MS, torchOffsetMs);
    setTransmitterState('done');
    setProgressText('Transmission complete! Check your watch.');
    setTimingText(
      `Timing: mean=${result.meanPeriodMs.toFixed(1)}ms, ` +
      `stddev=${result.stdDevMs.toFixed(1)}ms, ` +
      `min=${result.minPeriodMs.toFixed(1)}ms, ` +
      `max=${result.maxPeriodMs.toFixed(1)}ms`
    );
    setTimeout(() => cleanup(), 2000);
  } catch (e) {
    setTransmitterState('error');
    setStatusText(`Error: ${e}`);
    cleanup();
  }
} else {
  // Screen mode — existing transmit() call, unchanged
  // ... (keep all existing screen transmit code)
}
```

**Step 3: Commit**

```bash
git add app/(tabs)/index.tsx
git commit -m "feat: wire native torch transmitter and offset UI

Torch mode now uses native busy-wait transmission instead of
requestAnimationFrame. Offset selector (0-15ms) visible in torch mode."
```

---

### Task 4: Rebuild and verify

**Step 1: Rebuild the Android app**

The local module in `modules/` is auto-detected by Expo's autolinking. A full native rebuild is needed since we added a new native module:

```bash
cd ProjectL289Mobile
npx expo run:android
```

**Step 2: Verify on device**

- Open app on Pixel
- Select torch mode — offset buttons should appear
- Select a timezone, press Flash
- Verify LED flashes with wake-up pulse, then rapid payload
- Check timing stats displayed after transmission
- Try different offset values (0, 5, 8ms) and test against the watch

**Step 3: Commit any fixes if needed**
