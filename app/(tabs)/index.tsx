import React, { useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  AppState,
  type AppStateStatus,
} from 'react-native';
import { Picker } from '@react-native-picker/picker';

import { buildCompensatedBitstream, type TransmitParams } from '@/src/encoder';
import { TIMEZONE_DB, isDstActive, computeDstEvents, type TimezoneEntry } from '@/src/timezones';
import {
  BIT_PERIOD_MS,
  PRE_TRANSMIT_OVERHEAD_MS,
  type TransmitterState,
} from '@/src/transmitter';

import { transmitViaTorch } from '@/src/nativeTorchTransmitter';

function detectTimezoneId(): string {
  try {
    const iana = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const match = TIMEZONE_DB.find(t => t.id === iana);
    if (match) return match.id;
  } catch {}
  return 'America/New_York';
}

export default function FlashScreen() {
  const [selectedTzId, setSelectedTzId] = useState(detectTimezoneId);
  const [targetTimezone, setTargetTimezone] = useState<'T1' | 'T2'>('T1');
  const [transmitterState, setTransmitterState] = useState<TransmitterState>('idle');
  const [statusText, setStatusText] = useState('');
  const [progressText, setProgressText] = useState('');
  const [timingText, setTimingText] = useState('');
  const [showOverlay, setShowOverlay] = useState(false);
  const [torchOffsetMs, setTorchOffsetMs] = useState(8);
  const abortRef = useRef({ aborted: false });

  const getSelectedTz = useCallback((): TimezoneEntry | undefined => {
    return TIMEZONE_DB.find(t => t.id === selectedTzId);
  }, [selectedTzId]);

  const getTzInfoText = useCallback((): string => {
    const tz = getSelectedTz();
    if (!tz) return '';

    const now = new Date();
    const dstActive = isDstActive(tz, now);
    const offsetHours = tz.shiftHours + (dstActive ? 1 : 0);
    const minuteExtra = [0, 30, 45][tz.minuteShift]!;
    const sign = offsetHours >= 0 ? '+' : '';
    const offsetStr = minuteExtra > 0
      ? `UTC${sign}${offsetHours}:${minuteExtra.toString().padStart(2, '0')}`
      : `UTC${sign}${offsetHours}`;

    const dstStr = tz.dstCode > 0
      ? (dstActive ? 'DST active' : 'Standard time')
      : 'No DST';

    return `${offsetStr} | ${dstStr} | ${tz.hemisphere === 0 ? 'Northern' : 'Southern'} hemisphere`;
  }, [getSelectedTz]);

  const cleanup = useCallback(() => {
    setShowOverlay(false);
    setTransmitterState('idle');
  }, []);

  const startFlash = useCallback(async () => {
    if (transmitterState === 'transmitting') return;

    const tz = getSelectedTz();
    if (!tz) {
      setStatusText('Please select a timezone.');
      return;
    }

    abortRef.current = { aborted: false };

    const now = new Date();
    const dstActive = isDstActive(tz, now);
    const dstEvents = computeDstEvents(tz, now);

    const params: TransmitParams = {
      targetTimezone,
      utcTime: now,
      tz: {
        shiftHours: tz.shiftHours,
        minuteShift: tz.minuteShift,
        hemisphere: tz.hemisphere,
        dstActive,
      },
      dstSummer: dstEvents?.summer,
      dstWinter: dstEvents?.winter,
    };

    setShowOverlay(true);

    // Listen for app going to background
    const handleAppState = (nextState: AppStateStatus) => {
      if (nextState !== 'active') {
        abortRef.current.aborted = true;
      }
    };
    const appStateSub = AppState.addEventListener('change', handleAppState);

    setStatusText('Positioning...');
    setProgressText('Point LED at watch sensor... Transmitting in 3 seconds');

    await new Promise(resolve => setTimeout(resolve, 3000));

    if (abortRef.current.aborted) {
      cleanup();
      appStateSub.remove();
      return;
    }

    // Build compensated bitstream right before transmission
    params.utcTime = new Date();
    const { bitstream, messageDelayMs } = buildCompensatedBitstream(params, BIT_PERIOD_MS, PRE_TRANSMIT_OVERHEAD_MS);

    // Wait the computed delay so transmission ends on a second boundary
    if (messageDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, messageDelayMs));
    }

    if (abortRef.current.aborted) {
      cleanup();
      appStateSub.remove();
      return;
    }

    const estimatedDurationSec = ((bitstream.length * BIT_PERIOD_MS + PRE_TRANSMIT_OVERHEAD_MS) / 1000).toFixed(1);
    setStatusText(`Transmitting ${bitstream.length} bits (~${estimatedDurationSec}s)...`);

    setTransmitterState('transmitting');

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
      const msg = e instanceof Error ? e.message : String(e);
      setStatusText(`Error: ${msg}`);
      setProgressText('');
      setTimeout(() => cleanup(), 4000);
    }

    appStateSub.remove();
  }, [transmitterState, targetTimezone, torchOffsetMs, getSelectedTz, cleanup]);

  const cancelFlash = useCallback(() => {
    abortRef.current.aborted = true;
    cleanup();
    setStatusText('Transmission cancelled.');
  }, [cleanup]);

  if (showOverlay) {
    return (
      <View style={styles.torchOverlay}>
        <Text style={styles.torchOverlayTitle}>LED Transmitting</Text>
        <Text style={styles.torchOverlayStatus}>{statusText}</Text>
        <Text style={styles.torchOverlayProgress}>{progressText}</Text>
        <TouchableOpacity style={styles.cancelButton} onPress={cancelFlash}>
          <Text style={styles.cancelButtonText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.label}>Timezone</Text>
      <View style={styles.pickerContainer}>
        <Picker
          selectedValue={selectedTzId}
          onValueChange={setSelectedTzId}
          style={styles.picker}
          dropdownIconColor="#fff"
        >
          {TIMEZONE_DB.map(tz => (
            <Picker.Item key={tz.id} label={tz.label} value={tz.id} />
          ))}
        </Picker>
      </View>

      <Text style={styles.label}>Target</Text>
      <View style={styles.targetRow}>
        <TouchableOpacity
          style={[styles.targetButton, targetTimezone === 'T1' && styles.targetButtonActive]}
          onPress={() => setTargetTimezone('T1')}
        >
          <Text style={[styles.targetButtonText, targetTimezone === 'T1' && styles.targetButtonTextActive]}>
            Home (T1)
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.targetButton, targetTimezone === 'T2' && styles.targetButtonActive]}
          onPress={() => setTargetTimezone('T2')}
        >
          <Text style={[styles.targetButtonText, targetTimezone === 'T2' && styles.targetButtonTextActive]}>
            Travel (T2)
          </Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.tzInfo}>{getTzInfoText()}</Text>

      <TouchableOpacity
        style={styles.flashButton}
        onPress={startFlash}
        disabled={transmitterState === 'transmitting'}
      >
        <Text style={styles.flashButtonText}>Flash</Text>
      </TouchableOpacity>

      {statusText ? <Text style={styles.status}>{statusText}</Text> : null}
      {timingText ? <Text style={styles.timing}>{timingText}</Text> : null}

      <View style={styles.instructions}>
        <Text style={styles.instructionsTitle}>Instructions</Text>
        <Text style={styles.instructionStep}>1. Select your timezone and target (Home/Travel)</Text>
        <Text style={styles.instructionStep}>{"2. Push the crown briefly, then hold for ~2 seconds until all hands jump to 12 o'clock"}</Text>
        <Text style={styles.instructionStep}>{"3. Align the LED on the back of your phone with 12 o'clock on the watch (hold about 1 inch / 3cm above)"}</Text>
        <Text style={styles.instructionStep}>{"4. Press \"Flash\" and hold steady until complete"}</Text>
        <Text style={styles.instructionStep}>5. The hands will briefly jump to acknowledge reception</Text>
        <Text style={styles.instructionStep}>{"6. If the watch doesn't respond, try adjusting the alignment or changing the LED timing offset below"}</Text>
      </View>

      <Text style={styles.label}>LED Timing Offset ({torchOffsetMs}ms)</Text>
      <Text style={styles.offsetHint}>{"Compensates for LED response time. Increase if transmissions aren't received."}</Text>
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
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a2e',
  },
  content: {
    padding: 20,
    paddingTop: 60,
    paddingBottom: 40,
  },
  label: {
    fontSize: 14,
    color: '#aaa',
    marginBottom: 6,
    marginTop: 16,
  },
  pickerContainer: {
    backgroundColor: '#16213e',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#333',
    overflow: 'hidden',
  },
  picker: {
    color: '#fff',
    backgroundColor: '#16213e',
  },
  targetRow: {
    flexDirection: 'row',
    gap: 12,
  },
  targetButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#333',
    backgroundColor: '#16213e',
    alignItems: 'center',
  },
  targetButtonActive: {
    borderColor: '#0a7ea4',
    backgroundColor: '#0a3d5c',
  },
  targetButtonText: {
    color: '#888',
    fontSize: 15,
  },
  targetButtonTextActive: {
    color: '#fff',
    fontWeight: '600',
  },
  tzInfo: {
    color: '#ccc',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 12,
    marginBottom: 20,
  },
  flashButton: {
    backgroundColor: '#0a7ea4',
    paddingVertical: 16,
    borderRadius: 10,
    alignItems: 'center',
  },
  flashButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
  },
  status: {
    color: '#ccc',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 12,
  },
  timing: {
    color: '#888',
    fontSize: 11,
    textAlign: 'center',
    marginTop: 8,
    fontFamily: 'monospace',
  },
  instructions: {
    marginTop: 24,
    backgroundColor: '#16213e',
    borderRadius: 10,
    padding: 16,
  },
  instructionsTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#fff',
    marginBottom: 12,
  },
  instructionStep: {
    fontSize: 13,
    color: '#bbb',
    marginBottom: 8,
    lineHeight: 18,
  },
  cancelButton: {
    backgroundColor: 'rgba(255,255,255,0.15)',
    paddingHorizontal: 32,
    paddingVertical: 12,
    borderRadius: 8,
  },
  cancelButtonText: {
    color: '#fff',
    fontSize: 16,
  },
  torchOverlay: {
    flex: 1,
    backgroundColor: '#1a1a2e',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 30,
    gap: 16,
  },
  torchOverlayTitle: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#fff',
  },
  torchOverlayStatus: {
    fontSize: 14,
    color: '#ccc',
    textAlign: 'center',
  },
  torchOverlayProgress: {
    fontSize: 16,
    color: '#fff',
    textAlign: 'center',
  },
  offsetHint: {
    color: '#777',
    fontSize: 12,
    marginBottom: 8,
  },
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
});
