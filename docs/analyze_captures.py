#!/usr/bin/env python3
"""
Decode and compare WOP optical captures from Saleae Logic 2 CSV exports.

Uses run-length decoding with offset compensation to recover bits from
edge transitions, then unstuffs, verifies CRC-8, and decodes WOP fields.

Usage:
    python analyze_captures.py capture.csv
    python analyze_captures.py official.csv project.csv   # compare two
"""

import csv
import sys
import statistics


# WOP protocol constants
HEADER = [1, 1, 1, 0, 1, 0, 1, 0]
BIT_PERIOD_MS = 30.0

# Set True if comparator output is inverted (LED ON = LOW, LED OFF = HIGH).
# Set False if output is direct (LED ON = HIGH, LED OFF = LOW).
INVERT = False

# Minimum edge duration to accept (filters comparator bounce / glitches).
GLITCH_THRESHOLD_MS = 1.0

# Known opcodes
OPCODE_NAMES = {
    0: "PARAMETER", 2: "DATE_T1", 3: "DATE_T2", 4: "TIME_T1", 5: "TIME_T2",
    6: "ALARM_0", 7: "ALARM_1", 8: "TIME_INC_DEC",
    9: "TZ_SHIFT_T1", 10: "TZ_SHIFT_T2", 11: "DST_CODE_T1", 12: "DST_CODE_T2",
    13: "DST_DATE_TIME_T1", 14: "DST_DATE_TIME_T2", 35: "DISTANCE",
    53: "TRAVEL_WORLD_T1", 54: "TRAVEL_WORLD_T2",
    55: "TIME_DATE_T1", 56: "TIME_DATE_T2",
    57: "TZ_TIME_DATE_T1", 58: "TZ_TIME_DATE_T2",
    59: "DST_DATE_TIME_SW_T1", 60: "DST_DATE_TIME_SW_T2",
    61: "TRAVEL_WORLD_2_T1", 62: "TRAVEL_WORLD_2_T2",
    63: "TRAVEL_WORLD_NE_T1", 64: "TRAVEL_WORLD_NE_T2",
}

# Payload sizes (bits) for opcodes we can decode
OPCODE_PAYLOAD_BITS = {
    57: 8 + 17 + 16,  # TZ(8) + Time(17) + Date(16) = 41
    58: 8 + 17 + 16,
    59: 15 + 15,       # DST_Start(15) + DST_End(15) = 30
    60: 15 + 15,
    55: 17 + 16,       # Time(17) + Date(16) = 33
    56: 17 + 16,
    2: 16,             # Date(16)
    3: 16,
    4: 17,             # Time(17)
    5: 17,
    9: 8,              # TZ(8)
    10: 8,
    13: 15,            # DST_DateTime(15)
    14: 15,
}

DST_REGIONS = {
    0: "No DST", 1: "EU (CET/CEST)", 2: "Greenland", 3: "Iran", 4: "Israel",
    5: "Jordan", 6: "Lebanon", 7: "Syria", 8: "Brazil (south)",
    9: "North America", 10: "Mexico (central)", 11: "Cuba", 12: "Paraguay",
    13: "Chile", 14: "Australia (south)", 15: "Fiji", 16: "New Zealand",
    17: "Samoa", 18: "Easter Island", 19: "Palestine", 20: "UK/Ireland",
    21: "EET (Eastern Europe)",
}


def load_edges(path: str) -> list[tuple[float, int]]:
    """Load Saleae Logic 2 digital CSV and filter glitch edges."""
    raw = []
    with open(path) as f:
        reader = csv.reader(f)
        next(reader)  # skip header
        for row in reader:
            t = float(row[0])
            v = int(row[1])
            if INVERT:
                v = 1 - v
            raw.append((t, v))

    # Merge glitch edges (sub-ms transitions from comparator bounce)
    filtered = [raw[0]]
    for i in range(1, len(raw)):
        dur_ms = (raw[i][0] - filtered[-1][0]) * 1000
        if dur_ms < GLITCH_THRESHOLD_MS:
            # Drop this edge and the previous one (revert to state before glitch)
            filtered.pop()
        else:
            filtered.append(raw[i])

    return filtered


def edges_to_runs(edges: list[tuple[float, int]]) -> list[tuple[int, float]]:
    """Convert edges to (value, duration_ms) runs."""
    runs = []
    for i in range(len(edges) - 1):
        v = edges[i][1]
        dur = (edges[i + 1][0] - edges[i][0]) * 1000
        runs.append((v, dur))
    return runs


def estimate_timing(runs: list[tuple[int, float]]) -> tuple[float, float]:
    """Estimate the actual bit period and offset compensation from run durations.

    Single-bit ON runs cluster around (period + offset), single-bit OFF runs
    around (period - offset). The bit period may differ from the 30ms spec
    target if the transmitter snaps to display frame boundaries.

    Returns (bit_period_ms, offset_ms).
    """
    on_singles = []
    off_singles = []
    for v, dur in runs:
        if 20 < dur < 45:  # likely single-bit runs
            if v == 1:
                on_singles.append(dur)
            else:
                off_singles.append(dur)

    if on_singles and off_singles:
        on_med = statistics.median(on_singles)
        off_med = statistics.median(off_singles)
        period = (on_med + off_med) / 2
        offset = (on_med - off_med) / 2
        return period, offset

    # Fallback: use all short runs to estimate period, assume no offset
    all_singles = [dur for _, dur in runs if 20 < dur < 45]
    if all_singles:
        return statistics.median(all_singles), 0.0
    return BIT_PERIOD_MS, 0.0


def runs_to_bits(runs: list[tuple[int, float]], bit_period: float, offset: float) -> tuple[list[int], list[dict]]:
    """Convert runs to a bitstream using run-length decoding.

    ON run of N bits: duration ~ N * bit_period + offset
    OFF run of N bits: duration ~ N * bit_period - offset

    Returns (bitstream, run_details) where run_details has per-run info.
    """
    bits = []
    details = []

    for v, dur in runs:
        if v == 1:
            n = max(1, round((dur - offset) / bit_period))
        else:
            n = max(1, round((dur + offset) / bit_period))

        expected = n * bit_period + (offset if v == 1 else -offset)
        err = dur - expected

        details.append({"value": v, "duration": dur, "bits": n, "error": err})
        bits.extend([v] * n)

    return bits, details


def find_header(bits: list[int]) -> int | None:
    """Find the WOP header pattern in the bitstream. Returns start index."""
    for i in range(len(bits) - len(HEADER)):
        if bits[i : i + len(HEADER)] == HEADER:
            return i
    return None


def unstuff_bits(bits: list[int]) -> tuple[list[int], list[int]]:
    """Remove bit-stuffed bits (inserted after 5 consecutive identical bits).

    Returns (unstuffed_bits, list of stuffed bit positions).
    """
    result = []
    stuffed_positions = []
    run_count = 0
    last_bit = None

    i = 0
    while i < len(bits):
        b = bits[i]
        result.append(b)

        if b == last_bit:
            run_count += 1
        else:
            run_count = 1
            last_bit = b

        if run_count == 5 and i + 1 < len(bits):
            # Next bit should be the opposite (stuffed bit) — skip it
            stuffed_positions.append(i + 1)
            i += 2  # skip the stuffed bit
            run_count = 0
            last_bit = None
        else:
            i += 1

    return result, stuffed_positions


def compute_crc8(bits: list[int]) -> int:
    """Compute CRC-8 over a bit array using polynomial 0x07."""
    crc = 0
    for bit in bits:
        crc ^= (bit << 7)
        if crc & 0x80:
            crc = ((crc << 1) ^ 0x07) & 0xFF
        else:
            crc = (crc << 1) & 0xFF
    return crc


def bits_to_int(bits: list[int]) -> int:
    """Convert a list of bits (MSB first) to an integer."""
    val = 0
    for b in bits:
        val = (val << 1) | b
    return val


def twos_complement(val: int, width: int) -> int:
    """Interpret an unsigned int as two's complement signed."""
    if val >= (1 << (width - 1)):
        val -= (1 << width)
    return val


def decode_timezone(bits: list[int]) -> dict:
    """Decode TimezoneMessage (8 bits): shift(5) + minuteShift(2) + hemisphere(1)."""
    shift_raw = bits_to_int(bits[0:5])
    shift = twos_complement(shift_raw, 5)
    minute_shift = bits_to_int(bits[5:7])
    hemisphere = bits[7]
    minute_str = {0: ":00", 1: ":30", 2: ":45"}.get(minute_shift, f":?{minute_shift}")
    return {
        "shift": shift,
        "minute_shift": minute_shift,
        "hemisphere": "South" if hemisphere else "North",
        "display": f"UTC{shift:+d}{minute_str} {'S' if hemisphere else 'N'}",
    }


def decode_time(bits: list[int]) -> dict:
    """Decode TimeMessage (17 bits): hour(5) + minute(6) + second(6)."""
    hour = bits_to_int(bits[0:5])
    minute = bits_to_int(bits[5:11])
    second = bits_to_int(bits[11:17])
    return {"hour": hour, "minute": minute, "second": second,
            "display": f"{hour:02d}:{minute:02d}:{second:02d}"}


def decode_date(bits: list[int]) -> dict:
    """Decode DateMessage (16 bits): year(7) + month(4) + day(5)."""
    year = bits_to_int(bits[0:7])
    month = bits_to_int(bits[7:11])
    day = bits_to_int(bits[11:16])
    return {"year": 2000 + year, "month": month, "day": day,
            "display": f"20{year:02d}-{month:02d}-{day:02d}"}


def decode_dst_datetime(bits: list[int]) -> dict:
    """Decode DstDateTimeMessage (15 bits): season(1) + month(4) + day(5) + hour(5)."""
    season = bits[0]
    month = bits_to_int(bits[1:5])
    day = bits_to_int(bits[5:10])
    hour = bits_to_int(bits[10:15])
    season_str = "Winter (DST end)" if season else "Summer (DST start)"
    if month == 0:
        return {"season": season_str, "month": 0, "day": 0, "hour": 0,
                "display": "No DST event"}
    return {"season": season_str, "month": month, "day": day, "hour": hour,
            "display": f"{season_str}: month={month} day={day} hour={hour:02d}"}


def decode_submessage(opcode: int, payload_bits: list[int]) -> dict | None:
    """Decode a sub-message payload based on its opcode."""
    result = {"opcode": opcode, "opcode_name": OPCODE_NAMES.get(opcode, f"UNKNOWN({opcode})")}

    if opcode in (57, 58):  # TZ_TIME_DATE
        if len(payload_bits) < 41:
            result["error"] = f"need 41 bits, got {len(payload_bits)}"
            return result
        result["timezone"] = decode_timezone(payload_bits[0:8])
        result["time"] = decode_time(payload_bits[8:25])
        result["date"] = decode_date(payload_bits[25:41])
        result["tz_slot"] = "Home (T1)" if opcode == 57 else "Travel (T2)"
    elif opcode in (59, 60):  # DST_DATE_TIME_SW
        if len(payload_bits) < 30:
            result["error"] = f"need 30 bits, got {len(payload_bits)}"
            return result
        result["dst_start"] = decode_dst_datetime(payload_bits[0:15])
        result["dst_end"] = decode_dst_datetime(payload_bits[15:30])
        result["tz_slot"] = "Home (T1)" if opcode == 59 else "Travel (T2)"
    elif opcode in (55, 56):  # TIME_DATE
        if len(payload_bits) < 33:
            result["error"] = f"need 33 bits, got {len(payload_bits)}"
            return result
        result["time"] = decode_time(payload_bits[0:17])
        result["date"] = decode_date(payload_bits[17:33])
    elif opcode in (2, 3):  # DATE
        if len(payload_bits) < 16:
            result["error"] = f"need 16 bits, got {len(payload_bits)}"
            return result
        result["date"] = decode_date(payload_bits[0:16])
    elif opcode in (4, 5):  # TIME
        if len(payload_bits) < 17:
            result["error"] = f"need 17 bits, got {len(payload_bits)}"
            return result
        result["time"] = decode_time(payload_bits[0:17])
    elif opcode in (9, 10):  # TZ_SHIFT
        if len(payload_bits) < 8:
            result["error"] = f"need 8 bits, got {len(payload_bits)}"
            return result
        result["timezone"] = decode_timezone(payload_bits[0:8])
    elif opcode in (13, 14):  # DST_DATE_TIME
        if len(payload_bits) < 15:
            result["error"] = f"need 15 bits, got {len(payload_bits)}"
            return result
        result["dst_event"] = decode_dst_datetime(payload_bits[0:15])
    else:
        result["raw_bits"] = "".join(str(b) for b in payload_bits)

    return result


def analyze_capture(path: str) -> dict:
    """Full analysis of a single capture file."""
    edges = load_edges(path)
    runs = edges_to_runs(edges)

    # Skip idle, wake-up pulse, and gap to find actual data start.
    # Wake-up pulse: long ON (>150ms), gap: OFF after wake-up (~50ms).
    # Data runs are all <150ms (max ~5 bits × 30ms = 150ms).
    data_start = 0
    i = 0
    while i < len(runs):
        v, dur = runs[i]
        if v == 0 and dur > 200:  # long idle OFF
            data_start = i + 1
            i += 1
            continue
        if v == 1 and dur > 150:  # wake-up pulse — skip it and the following gap
            data_start = i + 1
            # Also skip the gap (OFF run after wake-up)
            if i + 1 < len(runs) and runs[i + 1][0] == 0 and runs[i + 1][1] < 100:
                data_start = i + 2
            i = data_start
            continue
        if v == 1 and dur > 5:  # first real data ON run
            data_start = i
            break
        i += 1

    # Detect wake-up pulse in pre-data runs
    wakeup_ms = None
    gap_ms = None
    for j in range(data_start):
        v, dur = runs[j]
        if v == 1 and dur > 150:
            wakeup_ms = dur
            # Check for gap after wake-up
            if j + 1 < len(runs) and runs[j + 1][0] == 0 and runs[j + 1][1] < 100:
                gap_ms = runs[j + 1][1]

    data_runs = runs[data_start:]
    bit_period, offset = estimate_timing(data_runs)
    raw_bits, run_details = runs_to_bits(data_runs, bit_period, offset)

    # Collect timing stats from data runs
    errors = [abs(d["error"]) for d in run_details if d["duration"] < 200]

    result = {
        "file": path,
        "total_edges": len(edges),
        "bit_period_ms": bit_period,
        "offset_ms": offset,
        "raw_bit_count": len(raw_bits),
    }

    if wakeup_ms is not None:
        result["wakeup_ms"] = wakeup_ms
        if gap_ms is not None:
            result["gap_ms"] = gap_ms

    if errors:
        result["mean_timing_error_ms"] = statistics.mean(errors)
        result["max_timing_error_ms"] = max(errors)

    # Find header
    header_idx = find_header(raw_bits)
    if header_idx is None:
        result["header_found"] = False
        result["raw_bits"] = raw_bits
        return result

    result["header_found"] = True
    result["header_offset"] = header_idx

    # Everything after the header
    frame_bits = raw_bits[header_idx + 8 :]

    # Strip trailing idle (long OFF runs decode as many 0s at the end)
    # We look for the actual frame end by working backwards
    while len(frame_bits) > 2 and frame_bits[-1] == 0:
        frame_bits.pop()
    # Add back exactly 2 trailing zeros (protocol requires them)
    frame_bits.extend([0, 0])

    # Unstuff
    unstuffed, stuffed_positions = unstuff_bits(frame_bits)
    result["stuffed_bit_count"] = len(stuffed_positions)
    result["stuffed_positions"] = stuffed_positions

    # Remove 2 trailing zeros
    if len(unstuffed) >= 2:
        unstuffed = unstuffed[:-2]

    result["payload_bit_count"] = len(unstuffed)

    # Parse frame: Length(4) + [Opcode(8) + Payload]×N + CRC(8)
    if len(unstuffed) < 20:  # minimum: 4 + 8 + 0 + 8
        result["error"] = "frame too short"
        result["unstuffed_bits"] = unstuffed
        return result

    length = bits_to_int(unstuffed[0:4])
    result["submessage_count"] = length

    # CRC check: computed over everything (length + opcodes + payloads), last 8 bits are CRC
    payload_data = unstuffed[:-8]
    crc_bits = unstuffed[-8:]
    crc_received = bits_to_int(crc_bits)
    crc_computed = compute_crc8(payload_data)
    result["crc_received"] = crc_received
    result["crc_computed"] = crc_computed
    result["crc_valid"] = crc_received == crc_computed

    # Decode sub-messages
    pos = 4  # after length field
    submessages = []
    remaining = unstuffed[:-8]  # exclude CRC

    for msg_idx in range(length):
        if pos + 8 > len(remaining):
            submessages.append({"error": f"truncated at sub-message {msg_idx}"})
            break

        opcode = bits_to_int(remaining[pos : pos + 8])
        pos += 8

        payload_size = OPCODE_PAYLOAD_BITS.get(opcode)
        if payload_size is not None:
            if pos + payload_size > len(remaining):
                submessages.append({"error": f"truncated payload for opcode {opcode}"})
                break
            payload = remaining[pos : pos + payload_size]
            pos += payload_size
        else:
            # Unknown payload size — consume remaining bits before CRC
            payload = remaining[pos:]
            pos = len(remaining)

        decoded = decode_submessage(opcode, payload)
        submessages.append(decoded)

    result["submessages"] = submessages

    # Store full bitstreams for comparison
    result["raw_bits"] = raw_bits
    result["unstuffed_bits"] = unstuffed

    # Store run details for timing analysis
    result["run_details"] = run_details

    return result


def print_analysis(result: dict):
    """Pretty-print analysis results."""
    print(f"\n{'=' * 64}")
    print(f"  Capture: {result['file']}")
    print(f"{'=' * 64}")
    print(f"  Total edges:        {result['total_edges']}")
    if "wakeup_ms" in result:
        gap_str = f" + {result['gap_ms']:.1f}ms gap" if "gap_ms" in result else ""
        print(f"  Wake-up pulse:      {result['wakeup_ms']:.1f} ms{gap_str}")
    else:
        print(f"  Wake-up pulse:      not detected")
    print(f"  Bit period (detected): {result['bit_period_ms']:.1f} ms  (spec: {BIT_PERIOD_MS} ms)")
    print(f"  Offset compensation: {result['offset_ms']:.1f} ms")
    print(f"  Raw bits decoded:   {result['raw_bit_count']}")

    if "mean_timing_error_ms" in result:
        print(f"  Mean timing error:  {result['mean_timing_error_ms']:.2f} ms")
        print(f"  Max timing error:   {result['max_timing_error_ms']:.2f} ms")

    if not result.get("header_found"):
        print(f"\n  *** HEADER NOT FOUND ***")
        if "raw_bits" in result:
            bs = "".join(str(b) for b in result["raw_bits"][:80])
            print(f"  First 80 raw bits: {bs}")
        return

    print(f"\n  Header:             FOUND at bit {result['header_offset']}")
    print(f"  Stuffed bits:       {result['stuffed_bit_count']}  (positions: {result.get('stuffed_positions', [])})")
    print(f"  Payload bits:       {result['payload_bit_count']} (after unstuffing, excl trailing zeros)")

    if "error" in result:
        print(f"  *** ERROR: {result['error']} ***")
        return

    print(f"  Sub-messages:       {result['submessage_count']}")

    crc_status = "PASS" if result["crc_valid"] else "FAIL"
    print(f"  CRC-8:              {crc_status}  (rx=0x{result['crc_received']:02X}, calc=0x{result['crc_computed']:02X})")

    for i, msg in enumerate(result.get("submessages", [])):
        print(f"\n  --- Sub-message {i + 1} ---")
        if "error" in msg:
            print(f"    Error: {msg['error']}")
            continue

        print(f"    Opcode: {msg['opcode']} ({msg['opcode_name']})")
        if "tz_slot" in msg:
            print(f"    Slot:   {msg['tz_slot']}")

        if "timezone" in msg:
            tz = msg["timezone"]
            print(f"    TZ:     {tz['display']}  (shift={tz['shift']}, min={tz['minute_shift']}, hem={tz['hemisphere']})")

        if "time" in msg:
            print(f"    Time:   {msg['time']['display']}")

        if "date" in msg:
            print(f"    Date:   {msg['date']['display']}")

        if "dst_start" in msg:
            print(f"    DST ->  {msg['dst_start']['display']}")
            print(f"    DST <-  {msg['dst_end']['display']}")

        if "dst_event" in msg:
            print(f"    DST:    {msg['dst_event']['display']}")

        if "raw_bits" in msg:
            print(f"    Raw:    {msg['raw_bits']}")

    # Print raw bitstream
    unstuffed = result.get("unstuffed_bits", [])
    if unstuffed:
        print(f"\n  Unstuffed bitstream ({len(unstuffed)} bits):")
        for i in range(0, len(unstuffed), 8):
            chunk = unstuffed[i : i + 8]
            bit_str = "".join(str(b) for b in chunk)
            byte_val = sum(b << (7 - j) for j, b in enumerate(chunk)) if len(chunk) == 8 else None
            hex_str = f"  (0x{byte_val:02X})" if byte_val is not None else ""
            print(f"    [{i:3d}-{i + len(chunk) - 1:3d}]  {bit_str}{hex_str}")


def compare_captures(a: dict, b: dict):
    """Compare two captures side-by-side."""
    print(f"\n{'=' * 64}")
    print("  COMPARISON")
    print(f"{'=' * 64}")

    print(f"  Bit period (detected):")
    print(f"    Capture A:  {a['bit_period_ms']:.1f} ms")
    print(f"    Capture B:  {b['bit_period_ms']:.1f} ms")
    print(f"  Offset compensation:")
    print(f"    Capture A:  {a['offset_ms']:.1f} ms")
    print(f"    Capture B:  {b['offset_ms']:.1f} ms")

    if "mean_timing_error_ms" in a and "mean_timing_error_ms" in b:
        print(f"  Timing error (mean):")
        print(f"    Capture A:  {a['mean_timing_error_ms']:.2f} ms")
        print(f"    Capture B:  {b['mean_timing_error_ms']:.2f} ms")

    bits_a = a.get("unstuffed_bits", [])
    bits_b = b.get("unstuffed_bits", [])
    if bits_a and bits_b:
        min_len = min(len(bits_a), len(bits_b))
        mismatches = sum(1 for i in range(min_len) if bits_a[i] != bits_b[i])
        len_diff = abs(len(bits_a) - len(bits_b))

        print(f"  Bit comparison (unstuffed payload):")
        print(f"    Capture A:   {len(bits_a)} bits")
        print(f"    Capture B:   {len(bits_b)} bits")
        print(f"    Mismatches:  {mismatches} / {min_len}")
        if len_diff:
            print(f"    Length diff:  {len_diff} bits")

        if mismatches == 0 and len_diff == 0:
            print(f"\n  *** BITSTREAMS MATCH ***")
        elif mismatches > 0:
            print(f"\n  Mismatch positions:")
            for i in range(min_len):
                if bits_a[i] != bits_b[i]:
                    print(f"    Bit {i}: A={bits_a[i]}  B={bits_b[i]}")

    # Compare decoded values
    for label, r in [("A", a), ("B", b)]:
        msgs = r.get("submessages", [])
        for msg in msgs:
            if "time" in msg:
                print(f"  Time ({label}): {msg['time']['display']}")
            if "date" in msg:
                print(f"  Date ({label}): {msg['date']['display']}")


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
