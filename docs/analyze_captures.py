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
