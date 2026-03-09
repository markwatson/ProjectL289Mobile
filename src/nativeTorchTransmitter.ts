import { transmitBitstream as nativeTransmit, type TransmitResult } from '../modules/native-torch-transmitter/src';

export type { TransmitResult };

export async function transmitViaTorch(
  bitstream: number[],
  bitPeriodMs: number,
  offsetMs: number,
): Promise<TransmitResult> {
  return nativeTransmit(bitstream, bitPeriodMs, offsetMs);
}
