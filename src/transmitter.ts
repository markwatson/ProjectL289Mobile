// React Native screen-based transmitter using requestAnimationFrame with absolute time modulation

export type TransmitterState = 'idle' | 'preparing' | 'transmitting' | 'done' | 'error';

export interface TransmitterCallbacks {
  onStateChange: (state: TransmitterState) => void;
  onProgress: (bitIndex: number, totalBits: number) => void;
  onColorChange: (color: string) => void;
  onComplete: () => void;
  onError: (msg: string) => void;
}

export interface TransmitTimingLog {
  bitIndex: number;
  timestamp: number;
}

/** The target bit period in milliseconds per the WOP spec (~30ms). */
export const BIT_PERIOD_MS = 30.0;

/** Duration of the wake-up pulse in milliseconds (solid white before preamble). */
export const WAKE_UP_PULSE_MS = 200;

/** Duration of the black gap after wake-up pulse to guarantee an edge transition into the header. */
export const WAKE_UP_GAP_MS = 50;

/** Total overhead before payload transmission begins (wake-up + gap). */
export const PRE_TRANSMIT_OVERHEAD_MS = WAKE_UP_PULSE_MS + WAKE_UP_GAP_MS;

/**
 * Transmit a bitstream by flashing a screen region between white (1) and black (0).
 * Uses absolute time-based modulation via requestAnimationFrame.
 *
 * Instead of manipulating DOM elements, calls onColorChange with '#ffffff' or '#000000'.
 * The React component should use this to set the background color of a full-screen View.
 */
export function transmit(
  bitstream: number[],
  bitPeriodMs: number,
  callbacks: TransmitterCallbacks,
  abortSignal?: { aborted: boolean },
): Promise<TransmitTimingLog[]> {
  callbacks.onStateChange('preparing');

  const timingLog: TransmitTimingLog[] = [];

  callbacks.onStateChange('transmitting');

  return new Promise<TransmitTimingLog[]>(resolve => {
    let startTime: number | null = null;
    let lastBitIndex = -1;
    let phase: 'wake' | 'gap' | 'payload' = 'wake';

    function onFrame(timestamp: number) {
      if (abortSignal?.aborted) {
        callbacks.onError('Transmission aborted.');
        callbacks.onStateChange('error');
        callbacks.onColorChange('#000000');
        resolve(timingLog);
        return;
      }

      if (startTime === null) {
        startTime = timestamp;
        // Begin wake-up pulse: solid white
        callbacks.onColorChange('#ffffff');
      }

      const elapsedMs = timestamp - startTime;

      // Phase 1: Wake-up pulse (solid white for WAKE_UP_PULSE_MS)
      if (phase === 'wake') {
        if (elapsedMs < WAKE_UP_PULSE_MS) {
          requestAnimationFrame(onFrame);
          return;
        }
        // Transition to black gap
        phase = 'gap';
        callbacks.onColorChange('#000000');
      }

      // Phase 2: Black gap (ensures rising edge when header starts with 1)
      if (phase === 'gap') {
        if (elapsedMs < WAKE_UP_PULSE_MS + WAKE_UP_GAP_MS) {
          requestAnimationFrame(onFrame);
          return;
        }
        // Gap complete, begin payload
        phase = 'payload';
        startTime = timestamp;
        lastBitIndex = -1;
      }

      // Phase 3: Payload transmission using absolute time
      const payloadElapsedMs = timestamp - startTime;
      const bitIndex = Math.floor(payloadElapsedMs / bitPeriodMs);

      if (bitIndex >= bitstream.length) {
        // Transmission complete — hold black
        callbacks.onColorChange('#000000');
        callbacks.onProgress(bitstream.length, bitstream.length);
        callbacks.onStateChange('done');
        callbacks.onComplete();
        resolve(timingLog);
        return;
      }

      // Only fire callbacks when the bit index actually changes
      if (bitIndex !== lastBitIndex) {
        lastBitIndex = bitIndex;
        const bit = bitstream[bitIndex]!;
        callbacks.onColorChange(bit === 1 ? '#ffffff' : '#000000');
        callbacks.onProgress(bitIndex, bitstream.length);
        timingLog.push({ bitIndex, timestamp: performance.now() });
      }

      requestAnimationFrame(onFrame);
    }

    requestAnimationFrame(onFrame);
  });
}

/** Analyze timing log for jitter statistics. */
export function analyzeTimingLog(log: TransmitTimingLog[]): {
  meanPeriodMs: number;
  stdDevMs: number;
  maxPeriodMs: number;
  minPeriodMs: number;
} {
  if (log.length < 2) {
    return { meanPeriodMs: 0, stdDevMs: 0, maxPeriodMs: 0, minPeriodMs: 0 };
  }

  const periods: number[] = [];
  for (let i = 1; i < log.length; i++) {
    periods.push(log[i]!.timestamp - log[i - 1]!.timestamp);
  }

  const mean = periods.reduce((a, b) => a + b, 0) / periods.length;
  const variance = periods.reduce((a, p) => a + (p - mean) ** 2, 0) / periods.length;
  const stdDev = Math.sqrt(variance);
  const max = Math.max(...periods);
  const min = Math.min(...periods);

  return { meanPeriodMs: mean, stdDevMs: stdDev, maxPeriodMs: max, minPeriodMs: min };
}
