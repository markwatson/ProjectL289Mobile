# Lab Test Rig: Optical Pulse Measurement

Measure and compare the optical pulses from the official Longines VHP app against ProjectL289Mobile to validate WOP protocol timing.

## Overview

The watch's photodetector sees light pulses at a 30ms bit period. We need to capture what the phone's LED flash (or screen) actually emits and compare it to known-good transmissions from the official app. A photodiode circuit converts light pulses into voltage transitions that an oscilloscope or Saleae logic analyzer can capture.

## Parts

### From Mouser order (invoice 89173259)

| Part | Mouser # | Purpose |
|------|----------|---------|
| BPW34 photodiode | 782-BPW34 | Light sensor — converts LED flash pulses to photocurrent. 430-1100nm range covers phone LED wavelengths. |
| LM393N/NOPB dual comparator | 926-LM393N/NOPB | Converts analog photodiode signal into clean digital edges for the logic analyzer. |
| 1µF MLCC capacitors (leaded) | 81-RCEC72A105K1M1H3A | Power supply decoupling. |
| 10K log potentiometer (15mm shaft) | 179-PTN091V10115K1A | Adjustable comparator threshold — tune for your specific phone's LED brightness. |

### From lab stock

| Part | Purpose |
|------|---------|
| 10kΩ resistor | Photodiode load resistor (sets sensitivity) |
| 100kΩ resistor | Pull-up for comparator open-collector output |
| 100nF ceramic capacitor | Additional decoupling |
| 5V bench supply or USB breakout | Power for comparator |
| Breadboard + jumper wires | Assembly |

## Circuit

```
                         +5V
                          │
                          ├──── 100nF ──── GND    (decoupling, close to LM393 pin 8)
                          │
                          ├──── 1µF ────── GND    (bulk decoupling)
                          │
                          │    LM393N (DIP-8)
                          │   ┌────────────┐
                          ├───┤ 8 (V+)     │
                          │   │            │
                     ┌────┼───┤ 3 (IN+)  1 ├───┬── OUT (to scope / Saleae CH0)
                     │    │   │    (non-inv)│   │
   BPW34             │    │   │            │   100kΩ  (pull-up, open-collector output)
  photodiode         │    │   │ 2 (IN-)    │   │
                     │    │   │  (inv)     │   │
  Cathode ─┤►├─ Anode┘    │   │   │        │   ├──── +5V
       (band)  │          │   │   │   4    │
               │          │   └───│───│────┘
             10kΩ         │       │   │
  (load R)   │          │       │  GND
               │          │       │
              GND         │      Wiper
                          │       │
                          │   ┌───┘
                          │   │
                          └───┤  10K pot
                              │  (threshold adjust)
                              │
                             GND
```

### Pin-by-pin wiring (LM393N DIP-8)

| Pin | Function | Connect to |
|-----|----------|------------|
| 1 | Output A | Scope/Saleae CH0, also pull up to +5V through 100kΩ |
| 2 | IN- (inverting) | Wiper of 10K potentiometer |
| 3 | IN+ (non-inverting) | Junction of BPW34 anode + 10kΩ load resistor |
| 4 | GND | Ground rail |
| 5 | IN+ B | Not used — tie to GND |
| 6 | IN- B | Not used — tie to +5V |
| 7 | Output B | Not used — leave floating |
| 8 | V+ | +5V rail |

### Photodiode wiring detail

The BPW34 runs in **photoconductive (reverse-biased)** mode for fast response:

```
+5V ──── Cathode ─┤►├─ Anode ──┬── to LM393 pin 3 (IN+)
         (marked          │
          band)         10kΩ
                          │
                         GND
```

- Light hits the BPW34 → photocurrent increases → voltage at anode rises
- No light → voltage drops toward 0V
- The 10kΩ load resistor converts photocurrent to voltage. If the LED is very bright and the signal saturates, increase to 4.7kΩ. If the signal is too weak (screen flash mode), increase to 47kΩ or 100kΩ.

### Threshold potentiometer

The 10K pot sets the comparator's switching threshold on pin 2 (IN-):

- **Start position:** Wiper at midpoint (~2.5V)
- **Tuning:** With the phone LED on steady, adjust until the comparator output just goes LOW (active). Then back off slightly so it triggers cleanly on pulses but ignores ambient light.
- The pot creates a simple voltage divider from +5V to GND.

### Why a comparator instead of just a resistor and scope?

You could connect the photodiode + load resistor directly to the scope and skip the comparator entirely. That works fine for the oscilloscope. But for the **Saleae logic analyzer**, you need clean digital edges — the comparator with adjustable threshold gives you:

1. Sharp 0V / 5V transitions regardless of ambient light level
2. A clean digital signal Saleae can decode without glitches
3. Adjustable sensitivity via the threshold pot

If you're only using the oscilloscope, you can skip the comparator and just probe the photodiode/resistor junction directly.

## How it works

1. **Phone emits light pulses.** The LED flash (torch mode) or screen (screen flash mode) turns on/off at 30ms intervals per the WOP bit encoding.

2. **Photodiode converts light to current.** The BPW34 generates photocurrent proportional to incident light intensity. In reverse-biased mode, response time is ~20ns — far faster than our 30ms bit period.

3. **Load resistor converts current to voltage.** The 10kΩ resistor creates a measurable voltage swing at the photodiode anode.

4. **Comparator digitizes the signal.** The LM393 compares the photodiode voltage (pin 3) against the pot threshold (pin 2). When light > threshold → output LOW (comparator sinks current). When light < threshold → output HIGH (pulled up by 100kΩ). Note: output polarity is inverted — LED ON = output LOW.

5. **Scope or logic analyzer captures the waveform.** You see the exact pulse timing the watch's photodetector would receive.

## Connecting the oscilloscope

### Equipment
- 100MHz oscilloscope (more than sufficient — our signal is ~33Hz fundamental)
- Standard 10x passive probe

### Setup
1. Connect scope probe to the **photodiode/resistor junction** (LM393 pin 3) for analog view, or to **comparator output** (LM393 pin 1) for digitized view.
2. Probe ground clip to circuit ground rail.
3. **Timebase:** 10ms/div gives you a good view of individual bits (3 divisions per bit period). For the full frame, use 100ms/div.
4. **Trigger:** Rising edge, single-shot mode. Set trigger level to ~50% of your signal amplitude.
5. **Vertical:** 1V/div for analog photodiode signal, 2V/div for comparator output.

### What to look for
- **Bit period:** Measure time between consecutive rising edges. Should be 30ms ±1ms.
- **Wake-up pulse:** 200ms solid ON followed by 50ms OFF gap.
- **Rise/fall time of LED:** Zoom in (1µs/div) on edges. This is the asymmetric offset the app compensates for. The official app's offset tells you how much the LED lags.
- **Header pattern:** After the wake-up gap, the first 8 bits should be `11101010` (0xEA) → 30ms ON, 30ms ON, 30ms ON, 30ms OFF, 30ms ON, 30ms OFF, 30ms ON, 30ms OFF.

## Connecting the Saleae logic analyzer

### Setup
1. Connect **CH0** to comparator output (LM393 pin 1).
2. Connect **GND** to circuit ground.
3. Optional: Connect **CH1** to photodiode/resistor junction for simultaneous analog view (Saleae Pro models).
4. **Sample rate:** 1 MHz is plenty (gives 30,000 samples per bit period). Even 100 kHz works.
5. **Trigger:** Rising edge on CH0.

### Capture settings in Logic 2
- Duration: 5 seconds (covers a full WOP frame transmission with margin)
- Voltage threshold: 3.3V (for the 0/5V comparator output)

## Validating and comparing: official app vs. ProjectL289Mobile

### Method 1: Oscilloscope overlay (quick visual check)

1. Capture the official app's transmission — use single-shot trigger, save screenshot or waveform to USB.
2. Capture ProjectL289Mobile's transmission with the same timezone/time settings.
3. Compare: bit periods, wake-up timing, header pattern, overall frame structure.
4. Key metric: **bit period jitter.** The official app presumably has tight timing. Measure stddev across 10+ consecutive bit periods for each app.

### Method 2: Saleae + Python analysis (recommended)

Export captures from Logic 2 and use the script below to decode and compare.

#### Export from Saleae Logic 2
1. After capture, go to **File → Export Raw Data**
2. Export CH0 as CSV with timestamps
3. Save as `official_capture.csv` and `project_capture.csv`

#### Analysis script

Save as `docs/analyze_captures.py`:

```python
#!/usr/bin/env python3
"""
Decode and compare WOP optical captures from Saleae Logic 2 CSV exports.

Usage:
    python analyze_captures.py official_capture.csv project_capture.csv
    python analyze_captures.py project_capture.csv  # single capture analysis
"""

import csv
import sys
import statistics


# WOP protocol constants
HEADER = [1, 1, 1, 0, 1, 0, 1, 0]  # 0xEA
BIT_PERIOD_MS = 30.0
WAKE_UP_MS = 200.0
GAP_MS = 50.0

# Comparator output is inverted: LED ON = LOW, LED OFF = HIGH.
# Flip so 1 = light on, 0 = light off.
INVERT = True


def load_saleae_csv(path: str) -> list[tuple[float, int]]:
    """Load Saleae Logic 2 digital CSV export.

    Expects columns: Time [s], Channel 0
    Returns list of (timestamp_seconds, value) tuples.
    """
    edges = []
    with open(path) as f:
        reader = csv.reader(f)
        header = next(reader)
        for row in reader:
            t = float(row[0])
            v = int(row[1])
            if INVERT:
                v = 1 - v
            edges.append((t, v))
    return edges


def extract_bit_periods(edges: list[tuple[float, int]]) -> list[float]:
    """Find all rising-edge-to-rising-edge intervals in ms."""
    rising = [t for t, v in edges if v == 1]
    return [(rising[i + 1] - rising[i]) * 1000 for i in range(len(rising) - 1)]


def find_wakeup(edges: list[tuple[float, int]]) -> int | None:
    """Find the wake-up pulse (long ON period ~200ms) and return the edge index."""
    for i in range(len(edges) - 1):
        t_now, v_now = edges[i]
        t_next, _ = edges[i + 1]
        duration_ms = (t_next - t_now) * 1000
        if v_now == 1 and duration_ms > 150:  # wake-up pulse: >150ms ON
            return i
    return None


def decode_bits(edges: list[tuple[float, int]], start_idx: int) -> list[int]:
    """Decode bits from edges starting after the wake-up gap.

    After the wake-up pulse + gap, sample the signal at each bit-period
    midpoint to recover the bitstream.
    """
    # Find the gap end (rising edge after the ~50ms OFF gap)
    gap_start_t = edges[start_idx + 1][0]  # falling edge after wake-up
    bits_start_t = None
    for i in range(start_idx + 2, len(edges)):
        t, v = edges[i]
        gap_duration = (t - gap_start_t) * 1000
        if v == 1 and gap_duration > 30:
            bits_start_t = t
            break

    if bits_start_t is None:
        return []

    # Sample at midpoints of each bit period
    bits = []
    max_bits = 200  # WOP frames are well under 200 bits
    last_edge_t = edges[-1][0]

    for bit_idx in range(max_bits):
        sample_t = bits_start_t + (bit_idx * BIT_PERIOD_MS / 1000) + (BIT_PERIOD_MS / 2000)
        if sample_t > last_edge_t:
            break

        # Find the signal value at sample_t
        val = 0
        for j in range(len(edges) - 1):
            if edges[j][0] <= sample_t < edges[j + 1][0]:
                val = edges[j][1]
                break
        else:
            val = edges[-1][1]

        bits.append(val)

    return bits


def check_header(bits: list[int]) -> bool:
    """Verify the 0xEA header."""
    if len(bits) < 8:
        return False
    return bits[:8] == HEADER


def analyze_capture(path: str) -> dict:
    """Full analysis of a single capture file."""
    edges = load_saleae_csv(path)
    periods = extract_bit_periods(edges)

    # Filter to bit-period-sized intervals (ignore wake-up pulse)
    bit_periods = [p for p in periods if 15 < p < 60]

    result = {
        "file": path,
        "total_edges": len(edges),
        "bit_periods": bit_periods,
    }

    if bit_periods:
        result["mean_period_ms"] = statistics.mean(bit_periods)
        result["stddev_ms"] = statistics.stdev(bit_periods) if len(bit_periods) > 1 else 0
        result["min_ms"] = min(bit_periods)
        result["max_ms"] = max(bit_periods)
        result["jitter_ms"] = max(bit_periods) - min(bit_periods)

    wakeup_idx = find_wakeup(edges)
    if wakeup_idx is not None:
        wakeup_duration = (edges[wakeup_idx + 1][0] - edges[wakeup_idx][0]) * 1000
        result["wakeup_duration_ms"] = wakeup_duration

        bits = decode_bits(edges, wakeup_idx)
        result["decoded_bits"] = bits
        result["header_valid"] = check_header(bits)
        result["total_bits"] = len(bits)

    return result


def print_analysis(result: dict):
    """Pretty-print analysis results."""
    print(f"\n{'=' * 60}")
    print(f"  Capture: {result['file']}")
    print(f"{'=' * 60}")
    print(f"  Total edges:      {result['total_edges']}")

    if "mean_period_ms" in result:
        print(f"  Bit periods:      {len(result['bit_periods'])} intervals measured")
        print(f"  Mean period:      {result['mean_period_ms']:.3f} ms  (target: {BIT_PERIOD_MS} ms)")
        print(f"  Std deviation:    {result['stddev_ms']:.3f} ms")
        print(f"  Min period:       {result['min_ms']:.3f} ms")
        print(f"  Max period:       {result['max_ms']:.3f} ms")
        print(f"  Jitter (p-p):     {result['jitter_ms']:.3f} ms")

        deviation = abs(result["mean_period_ms"] - BIT_PERIOD_MS)
        if deviation > 1.0:
            print(f"  *** WARNING: Mean deviates from {BIT_PERIOD_MS}ms by {deviation:.3f}ms ***")

    if "wakeup_duration_ms" in result:
        print(f"  Wake-up pulse:    {result['wakeup_duration_ms']:.1f} ms  (target: {WAKE_UP_MS} ms)")

    if "header_valid" in result:
        status = "PASS" if result["header_valid"] else "FAIL"
        print(f"  Header (0xEA):    {status}")
        if result["decoded_bits"]:
            header_str = "".join(str(b) for b in result["decoded_bits"][:8])
            print(f"  First 8 bits:     {header_str}  (expect 11101010)")
        print(f"  Total bits:       {result['total_bits']}")

    if "decoded_bits" in result and result["decoded_bits"]:
        bits = result["decoded_bits"]
        print(f"\n  Decoded bitstream ({len(bits)} bits):")
        for i in range(0, len(bits), 8):
            chunk = bits[i : i + 8]
            bit_str = "".join(str(b) for b in chunk)
            byte_val = sum(b << (7 - j) for j, b in enumerate(chunk)) if len(chunk) == 8 else None
            hex_str = f"  (0x{byte_val:02X})" if byte_val is not None else ""
            print(f"    [{i:3d}-{i + len(chunk) - 1:3d}]  {bit_str}{hex_str}")


def compare_captures(a: dict, b: dict):
    """Compare two captures side-by-side."""
    print(f"\n{'=' * 60}")
    print("  COMPARISON")
    print(f"{'=' * 60}")

    if "mean_period_ms" in a and "mean_period_ms" in b:
        diff = abs(a["mean_period_ms"] - b["mean_period_ms"])
        print(f"  Mean period diff:  {diff:.3f} ms")
        print(f"    Official:        {a['mean_period_ms']:.3f} ms")
        print(f"    Project:         {b['mean_period_ms']:.3f} ms")

        print(f"  Jitter comparison:")
        print(f"    Official:        {a.get('stddev_ms', 0):.3f} ms stddev")
        print(f"    Project:         {b.get('stddev_ms', 0):.3f} ms stddev")

    if "decoded_bits" in a and "decoded_bits" in b:
        bits_a = a["decoded_bits"]
        bits_b = b["decoded_bits"]
        min_len = min(len(bits_a), len(bits_b))

        mismatches = sum(1 for i in range(min_len) if bits_a[i] != bits_b[i])
        len_diff = abs(len(bits_a) - len(bits_b))

        print(f"  Bit comparison:")
        print(f"    Official bits:   {len(bits_a)}")
        print(f"    Project bits:    {len(bits_b)}")
        print(f"    Mismatches:      {mismatches} / {min_len}")
        if len_diff:
            print(f"    Length diff:     {len_diff} bits")

        if mismatches == 0 and len_diff == 0:
            print(f"\n  *** BITSTREAMS MATCH ***")
        elif mismatches > 0:
            print(f"\n  Mismatch positions:")
            for i in range(min_len):
                if bits_a[i] != bits_b[i]:
                    print(f"    Bit {i}: official={bits_a[i]}  project={bits_b[i]}")


def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <capture.csv> [reference_capture.csv]")
        print(f"  Single file:  analyze one capture")
        print(f"  Two files:    analyze both and compare")
        sys.exit(1)

    result1 = analyze_capture(sys.argv[1])
    print_analysis(result1)

    if len(sys.argv) >= 3:
        result2 = analyze_capture(sys.argv[2])
        print_analysis(result2)
        compare_captures(result1, result2)


if __name__ == "__main__":
    main()
```

## Quick-start procedure

1. **Build the circuit** on a breadboard per the diagram above.
2. **Power it up** with 5V. Verify LM393 pin 8 = 5V, pin 4 = 0V.
3. **Position the BPW34** so it faces the phone's LED flash, ~1-2cm away. Use a small tube or shrink-wrap sleeve around the photodiode to block ambient light.
4. **Set the threshold pot** to midpoint. Turn on the phone flashlight steady. Adjust the pot until the comparator output just goes LOW. Back off slightly.
5. **Capture the official app:**
   - Set scope to single-shot trigger or start Saleae capture.
   - Run the official Longines VHP app and transmit.
   - Save the capture.
6. **Capture ProjectL289Mobile:**
   - Same physical setup — don't move the photodiode.
   - Same timezone and time settings.
   - Transmit and capture.
7. **Compare** using the oscilloscope overlay or the Python analysis script.

## Troubleshooting

| Problem | Likely cause | Fix |
|---------|-------------|-----|
| No signal at all | Photodiode backwards, or no power | Check BPW34 orientation (band = cathode toward +5V), verify 5V rail |
| Signal never goes LOW | Threshold too high | Turn pot to reduce threshold voltage |
| Signal stuck LOW | Threshold too low or saturated | Turn pot to increase threshold, or reduce load R to 4.7kΩ |
| Noisy edges / glitching | Ambient light, or missing decoupling | Shield the photodiode, add decoupling caps close to LM393 |
| Bit period reads ~16ms | Capturing screen refresh, not data | Make sure you're capturing torch mode, not screen flash mode (screen flash is unreliable) |
| Scope shows signal but Saleae doesn't trigger | Voltage below Saleae threshold | Verify comparator output swings to 5V (check pull-up resistor) |
