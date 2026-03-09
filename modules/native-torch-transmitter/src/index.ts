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
