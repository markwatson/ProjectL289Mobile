import NativeTorchTransmitterModule from "./NativeTorchTransmitterModule";

export interface TransmitResult {
  meanPeriodMs: number;
  stdDevMs: number;
  minPeriodMs: number;
  maxPeriodMs: number;
  totalBits: number;
}

export const isAvailable = NativeTorchTransmitterModule != null;

export async function transmitBitstream(
  bitstream: number[],
  bitPeriodMs: number,
  offsetMs: number,
): Promise<TransmitResult> {
  if (!NativeTorchTransmitterModule) {
    throw new Error("NativeTorchTransmitter is not available on this platform");
  }
  return NativeTorchTransmitterModule.transmitBitstream(bitstream, bitPeriodMs, offsetMs);
}
