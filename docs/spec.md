# L289.2 Watch Optical Protocol (WOP) Specification

**Status:** Specification Draft
**Target:** L289.2 Movement (Longines VHP GMT)

---

## 1. Architecture Overview

The L289.2 movement utilizes a specialized Watch Optical Protocol (WOP) to synchronize time, timezone, and Daylight Saving Time (DST) configuration via light pulses. The protocol follows a structured layered design:

* **Physical layer:** Optical transmission (e.g., LED or screen flash), utilizing bipolar encoding (ON=1, OFF=0) with a default 30ms bit period.
* **Link layer:** Data stream synchronization maintained via bit stuffing (inserting an opposite bit after 5 consecutive same-value bits), followed by 2 trailing zeros.
* **Framing:** Fixed 8-bit header + variable-length payload + error detection (CRC-8).
* **Application layer:** Strongly typed composite messages (Time, Date, Timezone, DST rules) assembled into a single transmission frame.

---

## 2. Protocol Specification

### 2.1 Bit Timing

| Parameter | Value | Notes |
| --- | --- | --- |
| Default bit period | **30 ms** | The standard transmission baud rate. |
| Valid period range | 10–100 ms | The theoretical tolerance range for the receiver. |
| Offset compensation | 0–30 ms | Optional parameter to shorten a `0` bit and lengthen a `1` bit, compensating for hardware LED rise-time latency. Default is 0. |
| Encoding | Bipolar | ON = 1, OFF = 0. |
| Trailing zeros | 2 bits | Appended to the very end of the transmission after bit stuffing is complete. |

### 2.2 Bit Stuffing

To prevent clock drift on the receiver end, the protocol enforces a strict bit-stuffing rule on the assembled payload (prior to physical transmission):

Scan the bit array and after **5 consecutive identical bits**, insert the **opposite bit**.

* The stuffed bit resets the sequence counter.
* For the bipolar encoding used here, the stuffed bit is always the logical negation of the preceding sequence (`b == 1 ? 0 : 1`).

*(Note: In physical signal captures, these dynamically inserted bits act as synchronization pulses but shift the absolute index of all subsequent payload bits.)*

### 2.3 Header

Every transmission begins with a fixed 8-bit preamble derived from the constant `0x75` (117 decimal, or `01110101` binary).

The header is extracted from bits 6 down to 0, with a trailing 0 appended:

```text
Bit position:    6  5  4  3  2  1  0
Extracted value: 1  1  1  0  1  0  1
Appended:                            0

Transmitted Header: [1, 1, 1, 0, 1, 0, 1, 0]

```

The header bits are **excluded** from the CRC computation.

### 2.4 Error Detection (CRC-8)

Frames are validated using an 8-bit Cyclic Redundancy Check (CRC-8) appended to the end of the payload.

* **Polynomial:** `0x07` (Full polynomial: `x^8 + x^2 + x + 1`, or `100000111`)
* **Scope:** Computed over all payload elements (Length + Opcodes + Payloads). The 8-bit Header is excluded.
* **Implementation Constraint:** The CRC algorithm must perform bitwise polynomial long division on an expanded bit array (where each index holds a single `1` or `0`). A standard byte-oriented CRC-8 table lookup will not yield the correct checksum unless specifically adapted to match this bit-level shift-and-XOR logic.

### 2.5 Opcodes (8 bits each)

The protocol relies on opcodes to define the payload structure. The `T1` / `T2` suffix distinguishes the Home (T1) versus Travel (T2) timezone context.

| Opcode | Value | Description |
| --- | --- | --- |
| `PARAMETER` | 0 | Protocol parameters (type, phone, version, timing) |
| `DATE_T1` / `DATE_T2` | 2 / 3 | Date for timezone 1 (home) / 2 (travel) |
| `TIME_T1` / `TIME_T2` | 4 / 5 | Time for timezone 1 / 2 |
| `ALARM_0` / `ALARM_1` | 6 / 7 | Alarm settings |
| `TIME_INC_DEC` | 8 | Time increment/decrement |
| `TIME_ZONES_SHIFT_T1` / `T2` | 9 / 10 | Timezone offset for home / travel |
| `DST_CODE_T1` / `T2` | 11 / 12 | DST country code for home / travel |
| `DST_DATE_TIME_T1` / `T2` | 13 / 14 | DST event datetime |
| `DISTANCE` | 35 | Distance (golf feature) |
| `TRAVEL_WORLD_T1` / `T2` | 53 / 54 | TZ + DST code |
| `TIME_DATE_T1` / `T2` | 55 / 56 | Time + Date |
| `TZ_TIME_DATE_T1` / `T2` | 57 / 58 | Timezone + Time + Date |
| `DST_DATE_TIME_SW_T1` / `T2` | 59 / 60 | DST summer + winter events |
| `TRAVEL_WORLD_2_T1` / `T2` | 61 / 62 | TZ + DST summer/winter dates |
| `TRAVEL_WORLD_NE_T1` / `T2` | 63 / 64 | TZ + next DST event |

### 2.6 Payload Field Definitions

All fields are packed MSB-first. Values are converted into binary arrays and concatenated in the exact order listed. For signed values (e.g., timezone shifts), standard two's complement binary representation is used, trimmed to the specified bit width.

#### TimeMessage (17 bits)

| Field | Bits | Range | Notes |
| --- | --- | --- | --- |
| Hour | 5 | 0–23 | 24-hour format |
| Minute | 6 | 0–59 |  |
| Second | 6 | 0–59 |  |

#### DateMessage (16 bits)

| Field | Bits | Range | Notes |
| --- | --- | --- | --- |
| Year | 7 | 0–99 | Offset from the year 2000 |
| Month | 4 | 1–12 |  |
| Day | 5 | 1–31 |  |

#### TimezoneMessage (8 bits)

| Field | Bits | Range | Notes |
| --- | --- | --- | --- |
| Shift | 5 | -12 to +15 | Signed, hours from UTC (Two's complement) |
| MinuteShift | 2 | 0–2 | 0=none, 1=+30min, 2=+45min |
| Hemisphere | 1 | 0–1 | 0=North, 1=South |

*Note: If DST is currently active, the base `Shift` value must be incremented by 1 prior to encoding.*

#### DstDateTimeMessage (15 bits)

| Field | Bits | Range | Notes |
| --- | --- | --- | --- |
| Season | 1 | 0–1 | 0=Summer (DST start), 1=Winter (DST end) |
| Month | 4 | 0–12 | 0 = no DST event |
| Day | 5 | 0–31 |  |
| Hour | 5 | 0–23 | Local hour of the transition |

### 2.7 Composite Message Formatting (MultiMessage)

Standard sync transmissions use a composite "MultiMessage" frame format, structured as follows:

```text
[Header 8b] [Length 4b] [Opcode1 8b] [Payload1] [Opcode2 8b] [Payload2] ... [CRC-8 8b]

```

The `Length` field (4 bits) declares the number of sub-messages contained in the frame. A standard GMT sync utilizes one of two frame compositions depending on the target timezone's DST rules:

**Frame A — No DST (1 sub-message, Length = `0001`):**

```text
Header(8) + Length(4) + Opcode(8) + TZ(8) + Time(17) + Date(16) + CRC(8) = 69 bits

```

* **Opcode:** 57 (`00111001`) for Home, 58 (`00111010`) for Travel

**Frame B — With DST (2 sub-messages, Length = `0010`):**

```text
Header(8) + Length(4) + Opcode1(8) + TZ(8) + Time(17) + Date(16) + Opcode2(8) + DST_Start(15) + DST_End(15) + CRC(8) = 107 bits

```

* **Opcode1:** 57 or 58 (TZ_TIME_DATE)
* **Opcode2:** 59 or 60 (DST_DATE_TIME_SUMMER_WINTER)

*Note: No `ParameterMessage` is required for standard operations. The watch defaults to expecting the 30ms bipolar bitstream.*

### 2.8 Time Pre-Compensation (Auto-Adjustment)

To achieve the "Very High Precision" sync, the payload time must be mathematically projected into the future. The transmitter must calculate the total time required to physically emit the optical sequence (including all overhead from bit-stuffing). The `TimeMessage` payload must encode the UTC time corresponding to the exact millisecond the *final bit* of the frame will be detected by the watch.

---

## 3. DST Rule Database & Timezones

For autonomous DST changes, the watch relies on a predefined set of rule patterns. Transmitters must map IANA timezones to these rule codes.

### 3.1 Rule Patterns

There are 22 recognized rule groups encoding transition behaviors (e.g., "last Sunday of March" to "last Sunday of October"). Certain highly irregular transitions (e.g., specific years in Jordan, Brazil, Chile, Fiji, and Palestine) require hardcoded year-specific overrides in the transmitter's data layer to ensure the watch shifts on the correct local date.

### 3.2 Southern Hemisphere Inversion

When mapping zones in the Southern Hemisphere, transmitters must ensure the hemisphere bit is correctly flipped, which inherently treats the start of Summer time as a "stop" event logically.

---

## 4. Signal Analysis & Verification Context

When observing raw optical captures of the L289.2 sync sequence, certain artifacts appear that must be accounted for:

* **Apparent "Stop Bits":** The dynamically inserted bits from the 5-bit stuffing rule appear as visual synchronization pulses in physical captures. Because their position depends entirely on the payload data, analyzing raw signals without first running a bit-unstuffing pass will result in misaligned field boundaries.
* **"Travel" vs "Home" Flags:** Physical analysis might suggest discrete flags denoting the active timezone. In the protocol, this distinction is handled strictly by the Opcode value (e.g., Opcode 57 vs 58).
* **Boundary Artifacts (e.g., 41-Hour Shifts):** Flipping raw bits in a captured sequence without recalculating the CRC and unstuffing the frame can cause the watch firmware to parse boundaries incorrectly, resulting in unexpected shifts (like a 41-hour jump). Transmitters only need to adhere to the strict field definitions outlined in Section 2.6.

---

## 5. Implementation Guide

A reference transmitter implementation requires three primary components:

1. **Timezone Database Mapping:** A lookup table matching modern IANA timezone strings to the specific UTC offset, hemisphere, and DST rule code expected by the protocol.
2. **Frame Assembler & Encoder:** A routine that constructs the `MultiMessage` frame, calculates the bitwise CRC-8, applies the 5-bit stuffing rule, and appends the 2 trailing zeros.
3. **Physical Emitter:** A hardware or software mechanism capable of emitting the final bit array as light pulses at a deterministic 30ms interval.
* *Web/Screen Based:* Rendering timed white/black frames. At 60Hz, 30ms equals roughly ~2 frames per bit.
* *Hardware:* Microcontroller (e.g., ESP32) toggling a high-intensity LED via precise hardware timers.



---

## Appendix A: DST Country Codes

| Code | Regions | Rule Pattern |
| --- | --- | --- |
| 0 | No DST | — |
| 1 | EU (CET/CEST) | Last Sun Mar → Last Sun Oct |
| 2 | Greenland | Last Sat Mar → Last Sat Oct |
| 3 | Iran | Equinox-based (leap year dependent) |
| 4 | Israel | Last Fri-2 Mar → Last Sun Oct |
| 5 | Jordan | Last Fri Mar → Last Fri Oct |
| 6 | Lebanon | Last Sun Mar → Last Sun Oct |
| 7 | Syria | Last Fri Mar → Last Fri Oct |
| 8 | Brazil (south) | 1st Sun Nov → 3rd Sun Feb |
| 9 | North America | 2nd Sun Mar → 1st Sun Nov |
| 10 | Mexico (central) | 1st Sun Apr → Last Sun Oct |
| 11 | Cuba | 2nd Sun Mar → 1st Sun Nov |
| 12 | Paraguay | 1st Sun Oct → 4th Sun Mar |
| 13 | Chile | 2nd Sat+1 Aug → 2nd Sat+1 May |
| 14 | Australia (south) | 1st Sun Oct → 1st Sun Apr |
| 15 | Fiji | 1st Sun Nov → 3rd Sun Jan |
| 16 | New Zealand | Last Sun Sep → 1st Sun Apr |
| 17 | Samoa | Last Sun Sep → 1st Sun Apr |
| 18 | Easter Island | 2nd Sat Aug → 2nd Sat May |
| 19 | Palestine | Last Fri Mar → Last Fri Oct |
| 20 | UK/Ireland (WET/WEST) | Last Sun Mar → Last Sun Oct |
| 21 | EET (Eastern Europe) | Last Sun Mar → Last Sun Oct |
