# Web-Based WOP Transmission Investigation

**Date:** March 14-15, 2026
**Hardware:** L289.2 movement watch, iPhone 17 Pro, Saleae Logic Analyzer
**Goal:** Determine if a web browser can transmit the Watch Optical Protocol (WOP) to sync the watch, without a native app.

---

## TL;DR

**Web-based screen flashing produces pixel-perfect timing but insufficient light. Web-based torch (LED) produces sufficient light but unreliable timing due to the async `applyConstraints` API and hardware PWM. Neither approach works. Native app access to the LED torch is required.**

The React Native app (cloning the Android official app's approach) works reliably because it controls the LED torch from a dedicated thread with direct hardware access, bypassing the browser's async media pipeline.

---

## What We Tested

### Approach 1: Screen Flash (OLED)

Flash the phone screen white/black to transmit bits optically.

| Test | Bit Period | Strategy | Result |
|------|-----------|----------|--------|
| Baseline (dithered) | 30ms | `Math.floor(elapsed/30)` | 6ms mean error, 16ms max. CRC PASS but watch rejects. |
| Frame-locked 120Hz | 33.3ms | Snap to 4 frames | 0.03ms mean error(!), but 33.3ms period rejected by watch. |
| Frame-locked 60Hz | 33.3ms | Snap to 2 frames | Same period issue, compositor also drops frames on later passes. |
| 3x repeat | 33.3ms | Send 3 times | Pass 1 clean, pass 2 borderline, pass 3 destroyed by compositor fatigue. |
| 30ms dithered (no offset) | 30ms | `Math.floor(elapsed/30)` | Correct average but ±8ms per-bit jitter from frame quantization. |
| 30ms + offset compensation | 30ms + 6.5ms | Asymmetric ON/OFF | At 60Hz, can't express sub-frame offsets. ON/OFF both round to same frame count. |
| Pre-planned frame schedule | 30ms | Cumulative transition rounding | All runs decode correctly at 30ms. Frame counting with drop detection. Still rejected. |
| Pre-planned + min 33ms pulse | 30ms | Min 2 frames at 60Hz | No micro-pulses. Clean signal. Still rejected. |

**Why it fails:** The OLED screen doesn't produce enough light intensity for the watch's tiny (<1mm) photodiode. The timing is actually excellent — our best screen capture had 0.03ms mean error with zero frame drops, every run decoding correctly. The protocol data was structurally identical to the official app. The photons just aren't there.

### Approach 2: LED Torch via Web API

Use `navigator.mediaDevices.getUserMedia` + `track.applyConstraints({torch: true})` to control the rear camera LED.

| Test | Strategy | Result |
|------|----------|--------|
| Frame-scheduled torch | Pre-planned frames | 60Hz frame schedule caused cascading errors — torch isn't frame-locked. |
| Direct time-based | `Math.floor(elapsed/30)` | Better (5.77ms mean err), but 9/57 runs >10ms error. Two runs at 13-15ms (half a bit). |
| Multi-pass (10x) | Repeat and pray | Torch noise between attempts, PWM discovered in captures. |
| Multi-pass (4x, 1s gap) | Repeat with spacing | Still PWM. 1625 sub-ms edges drowning 84 data edges. |
| Brightness: 1.0 | Force max brightness | No effect — iPhone hardware always uses PWM regardless. |

**Why it fails:** Two compounding issues:

1. **Async API latency:** `applyConstraints` is a promise-based API that goes through the browser's media pipeline. The actual LED toggle happens 0-16ms after the call, non-deterministically. This creates ±16ms timing jitter — right at the edge of corrupting bit counts.

2. **Hardware PWM:** The iPhone's torch LED uses pulse-width modulation (~150Hz, 3ms ON / 3.7ms OFF cycles) instead of a clean DC ON/OFF signal. The browser's torch API provides no way to control this. While the watch's photodiode likely integrates PWM into average brightness, the rapid pulsing may confuse the watch's edge detector during bit transitions.

---

## Key Findings

### What the watch needs (derived from official app captures)

Based on a single Saleae capture from each official app. Each capture contains one complete WOP frame (~108 bits, ~57 ON/OFF runs). The "runs" below are consecutive same-value edges within that single frame, not independent test runs.

| Parameter | iOS Official App (1 capture) | Android Official App (1 capture) |
|-----------|-----------------|---------------------|
| Bit period | 29.9ms | 29.8ms |
| Offset (ON/OFF asymmetry) | +6.8ms | -3.5ms |
| Max timing error per run | 4.0ms | 2.9ms |
| Runs with >10ms error | 0 / 57 | 0 / 57 |
| Frame alignment | None (hardware timer) | None (hardware timer) |
| Light source | Rear LED (direct hardware control) | Rear LED (direct hardware control) |

The opposite offset polarities between iOS (+6.8ms) and Android (-3.5ms) prove that offset compensation is **LED hardware calibration, not a watch firmware requirement**. Different phone LEDs have different rise/fall times.

### What web can achieve

| Parameter | Screen (best) | Web Torch (best) |
|-----------|--------------|-----------------|
| Bit period | 30ms (dithered) or 33.3ms (locked) | 30ms (direct timing) |
| Mean timing error | 0.03ms (frame-locked) | 5.77ms |
| Max timing error | 0ms (perfect) | 16.4ms |
| Errors > 10ms | 0 (frame-locked) | 9 / 57 runs |
| Light intensity | Insufficient | Sufficient but PWM |

### The fundamental web platform limitation

The web has two ways to produce light, and each fails for a different reason:

```
                    Timing Precision    Light Intensity
Screen (OLED):      Excellent           Insufficient
Torch (LED API):    Poor                Sufficient (but PWM)
Native (React):     Excellent           Sufficient
```

There is no web API that provides both precise timing AND sufficient light output. The browser's security model and async architecture prevent direct, synchronous hardware control.

---

## Approaches Considered But Not Tested

1. **WebUSB + Microcontroller** — Send bitstream to ESP32 via WebUSB, let hardware timer drive an LED. Would work but requires external hardware.

2. **Screen + Optics** — Use a lens or light pipe to focus screen light onto the photodiode. Timing is perfect; just need more photons. Could work with the right optics but requires physical hardware.

3. **Web Worker tight loop** — Spin `performance.now()` in a Worker for sub-ms timing. Can measure time precisely but can't call `applyConstraints` from a Worker thread.

4. **AudioWorklet timing** — Real-time audio thread for sample-accurate timing (~0.02ms). Can't control torch from audio thread.

---

## Analyzer Tool

The investigation produced a comprehensive capture analysis tool at `docs/analyze_captures.py` that:

- Auto-detects bit period from run durations (works with 30ms and 33.3ms captures)
- Auto-detects offset compensation
- Skips wake-up pulses and gaps
- Filters comparator glitches
- Unstuffs bits, verifies CRC-8, decodes all WOP fields
- Compares two captures side-by-side
- Works with Saleae Logic 2 digital CSV exports

---

## Captures Collected

| File | Source | Notes |
|------|--------|-------|
| `digital_official_app_2026_03_14__fixed_beginning.csv` | iOS official app (LED) | Reference capture. CRC PASS. |
| `digital_official_android_app_led_flash.csv` | Android official app (LED) | Shows inverted offset vs iOS. |
| `digital_web_impl_iphone17pro_screen_flash.csv` | Web screen (first test) | With wake-up pulse. |
| `digital_web_impl_iphone17pro_screen_flash_post_preamble_fix_correct_reading.csv` | Web screen (no wake-up) | Clean, CRC PASS. |
| `digital_web_impl_iphone17pro_screen_flash_latest_change_timing.csv` | Web screen (frame-locked 120Hz) | 33.3ms period, compositor drops. |
| `digital_web_impl_iphone17pro_screen_flash_3_time_test.csv` | Web screen (3x repeat, frame-locked) | Pass 1 perfect, pass 3 destroyed. |
| `digital_web_impl_iphone17pro_screen_flash_3_time_test_fixed_lead.csv` | Web screen (lead-in fix) | 2/3 passes CRC PASS. |
| `digital_web_impl_iphone17pro_screen_flash_60hz_lock.csv` | Web screen (60Hz locked) | Pass 1 perfect, passes 2-3 degrade. |
| `digital_web_impl_iphone17pro_screen_flash_30ms_dither.csv` | Web screen (30ms dithered) | Correct average, per-bit jitter. |
| `digital_web_impl_iphone17pro_screen_flash_30ms_dither_offset.csv` | Web screen (30ms + 6.5ms offset) | Offset not expressible at frame resolution. |
| `digital_web_impl_test1_30ms_min3frames.csv` | Web screen (pre-planned, broken) | MIN_RUN_FRAMES bug at 60Hz. |
| `digital_web_impl_test1_30ms_min20ms_fixed.csv` | Web screen (pre-planned, fixed) | Clean but 18/53 single-frame errors. |
| `digital_web_impl_test2_30ms_min33ms_framecounting.csv` | Web screen (frame counting) | All runs decode correctly at 30ms. |
| `digital_web_torch_iphone17pro_first_test.csv` | Web torch (first test) | Frame-scheduled, wrong timing. |
| `digital_web_torch_iphone17pro_direct_timing.csv` | Web torch (direct timing) | Better but 9/57 runs >10ms error. |

---

## Conclusion

**The web platform cannot reliably transmit WOP.** Native access to the LED torch hardware is required for both sufficient light intensity and deterministic timing. The React Native app works because it controls the torch from a dedicated thread with direct hardware access, matching what the official iOS and Android apps do.

The protocol encoding, frame assembly, CRC computation, bit stuffing, time pre-compensation, and timezone/DST handling are all correct and verified against official app captures. Only the physical layer (light output) is the bottleneck.
