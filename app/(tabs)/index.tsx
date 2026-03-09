import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
  AppState,
  type AppStateStatus,
} from 'react-native';
import { Picker } from '@react-native-picker/picker';

import { buildCompensatedBitstream, type TransmitParams } from '@/src/encoder';
import { TIMEZONE_DB, isDstActive, computeDstEvents, type TimezoneEntry } from '@/src/timezones';
import {
  BIT_PERIOD_MS,
  PRE_TRANSMIT_OVERHEAD_MS,
  transmit,
  analyzeTimingLog,
  type TransmitterState,
} from '@/src/transmitter';

// Try to load expo-torch module
let ExpoTorch: { setStateAsync: (state: number) => Promise<void>; ON: number; OFF: number } | null = null;
try {
  ExpoTorch = require('expo-torch');
} catch (e) {
  console.warn('expo-torch not available:', e);
}

type FlashMode = 'screen' | 'torch';

export default function FlashScreen() {
  const [selectedTzId, setSelectedTzId] = useState('America/New_York');
  const [targetTimezone, setTargetTimezone] = useState<'T1' | 'T2'>('T1');
  const [flashMode, setFlashMode] = useState<FlashMode>('screen');
  const [transmitterState, setTransmitterState] = useState<TransmitterState>('idle');
  const [flashColor, setFlashColor] = useState('#000000');
  const [statusText, setStatusText] = useState('');
  const [progressText, setProgressText] = useState('');
  const [timingText, setTimingText] = useState('');
  const [showOverlay, setShowOverlay] = useState(false);
  const [torchError, setTorchError] = useState<string | null>(null);
  const abortRef = useRef({ aborted: false });

  const torchAvailable = ExpoTorch != null;

  const torchOn = useCallback(() => {
    ExpoTorch?.setStateAsync(ExpoTorch.ON).catch(e => setTorchError(String(e)));
  }, []);

  const torchOff = useCallback(() => {
    ExpoTorch?.setStateAsync(ExpoTorch.OFF).catch(() => {});
  }, []);

  // Ensure torch is off on unmount
  useEffect(() => {
    return () => { torchOff(); };
  }, [torchOff]);

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

  const startFlash = useCallback(async () => {
    if (transmitterState === 'transmitting') return;

    const tz = getSelectedTz();
    if (!tz) {
      setStatusText('Please select a timezone.');
      return;
    }

    abortRef.current = { aborted: false };
    setTorchError(null);

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

    // Show overlay (for screen mode) or status (for torch mode)
    if (flashMode === 'screen') {
      setShowOverlay(true);
      setFlashColor('#000000');
      StatusBar.setHidden(true);
    } else {
      setShowOverlay(true);
    }

    // Listen for app going to background
    const handleAppState = (nextState: AppStateStatus) => {
      if (nextState !== 'active') {
        abortRef.current.aborted = true;
      }
    };
    const appStateSub = AppState.addEventListener('change', handleAppState);

    // Brief delay to let user position watch
    setStatusText('Positioning...');
    const positionMsg = flashMode === 'torch'
      ? 'Point LED at watch sensor... Transmitting in 3 seconds'
      : 'Position watch on screen now... Transmitting in 3 seconds';
    setProgressText(positionMsg);

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

    // Track last torch state to avoid redundant calls
    let lastTorchState: boolean | null = null;

    const timingLog = await transmit(bitstream, BIT_PERIOD_MS, {
      onStateChange: (state) => {
        setTransmitterState(state);
        if (state === 'done') {
          setProgressText('Transmission complete! Check your watch.');
          if (flashMode === 'torch') torchOff();
          setTimeout(() => cleanup(), 2000);
        } else if (state === 'error') {
          if (flashMode === 'torch') torchOff();
          setTimeout(() => cleanup(), 1500);
        }
      },
      onProgress: (bitIdx, total) => {
        const pct = Math.round((bitIdx / total) * 100);
        setProgressText(`${pct}% (${bitIdx}/${total} bits)`);
      },
      onColorChange: (color) => {
        if (flashMode === 'screen') {
          setFlashColor(color);
        } else {
          // Torch mode: white = on, black = off
          const shouldBeOn = color === '#ffffff';
          if (shouldBeOn !== lastTorchState) {
            lastTorchState = shouldBeOn;
            if (shouldBeOn) {
              torchOn();
            } else {
              torchOff();
            }
          }
        }
      },
      onComplete: () => {},
      onError: (msg) => {
        setStatusText(`Error: ${msg}`);
        if (flashMode === 'torch') torchOff();
      },
    }, abortRef.current);

    // Show timing analysis
    if (timingLog.length > 1) {
      const stats = analyzeTimingLog(timingLog);
      setTimingText(
        `Timing: mean=${stats.meanPeriodMs.toFixed(1)}ms, ` +
        `stddev=${stats.stdDevMs.toFixed(1)}ms, ` +
        `min=${stats.minPeriodMs.toFixed(1)}ms, ` +
        `max=${stats.maxPeriodMs.toFixed(1)}ms`
      );
    }

    appStateSub.remove();
  }, [transmitterState, targetTimezone, flashMode, getSelectedTz, torchOn, torchOff]);

  const cleanup = useCallback(() => {
    setShowOverlay(false);
    setFlashColor('#000000');
    setTransmitterState('idle');
    StatusBar.setHidden(false);
    torchOff();
  }, [torchOff]);

  const cancelFlash = useCallback(() => {
    abortRef.current.aborted = true;
    cleanup();
    setStatusText('Transmission cancelled.');
  }, [cleanup]);

  // Flash overlay - full screen color flashing (screen mode) or status display (torch mode)
  if (showOverlay) {
    if (flashMode === 'torch') {
      return (
        <View style={styles.torchOverlay}>
          <Text style={styles.torchOverlayTitle}>LED Transmitting</Text>
          <Text style={styles.torchOverlayStatus}>{statusText}</Text>
          <Text style={styles.torchOverlayProgress}>{progressText}</Text>
          {torchError ? <Text style={styles.torchOverlayError}>{torchError}</Text> : null}
          <TouchableOpacity style={styles.cancelButton} onPress={cancelFlash}>
            <Text style={styles.cancelButtonText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      );
    }

    return (
      <View style={[styles.overlay, { backgroundColor: flashColor }]}>
        <View style={styles.overlayInfo}>
          <Text style={styles.overlayProgress}>{progressText}</Text>
        </View>
        <TouchableOpacity style={styles.cancelButton} onPress={cancelFlash}>
          <Text style={styles.cancelButtonText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>VHP GMT Flash</Text>
      <Text style={styles.subtitle}>Watch optical synchronization</Text>

      <Text style={styles.label}>Flash Mode</Text>
      <View style={styles.targetRow}>
        <TouchableOpacity
          style={[styles.targetButton, flashMode === 'screen' && styles.targetButtonActive]}
          onPress={() => setFlashMode('screen')}
        >
          <Text style={[styles.targetButtonText, flashMode === 'screen' && styles.targetButtonTextActive]}>
            Screen
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.targetButton, flashMode === 'torch' && styles.targetButtonActive, !torchAvailable && styles.targetButtonDisabled]}
          onPress={() => torchAvailable && setFlashMode('torch')}
          disabled={!torchAvailable}
        >
          <Text style={[styles.targetButtonText, flashMode === 'torch' && styles.targetButtonTextActive, !torchAvailable && styles.targetButtonTextDisabled]}>
            LED Flash{!torchAvailable ? ' (dev build)' : ''}
          </Text>
        </TouchableOpacity>
      </View>

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
        {flashMode === 'screen' ? (
          <>
            <Text style={styles.instructionStep}>1. Set screen brightness to maximum and dim room lights</Text>
            <Text style={styles.instructionStep}>2. Select your timezone and target (Home/Travel)</Text>
            <Text style={styles.instructionStep}>3. Push the crown briefly, then hold for ~2 seconds until all hands jump to 12 o'clock</Text>
            <Text style={styles.instructionStep}>4. Place the watch face-down on the screen with the photodetector centered on the flash area</Text>
            <Text style={styles.instructionStep}>5. Press "Flash" and keep the watch still until complete</Text>
            <Text style={styles.instructionStep}>6. The hands will briefly jump to acknowledge reception</Text>
          </>
        ) : (
          <>
            <Text style={styles.instructionStep}>1. Select your timezone and target (Home/Travel)</Text>
            <Text style={styles.instructionStep}>2. Push the crown briefly, then hold for ~2 seconds until all hands jump to 12 o'clock</Text>
            <Text style={styles.instructionStep}>3. Position the phone's LED flash directly over the watch's photodetector (small window near 12 o'clock)</Text>
            <Text style={styles.instructionStep}>4. Press "Flash" and hold the phone steady until complete</Text>
            <Text style={styles.instructionStep}>5. The hands will briefly jump to acknowledge reception</Text>
          </>
        )}
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
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#fff',
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 14,
    color: '#888',
    textAlign: 'center',
    marginBottom: 24,
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
  targetButtonDisabled: {
    opacity: 0.4,
  },
  targetButtonTextDisabled: {
    color: '#555',
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
  // Screen flash overlay
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingBottom: 60,
  },
  overlayInfo: {
    position: 'absolute',
    bottom: 120,
    left: 20,
    right: 20,
    alignItems: 'center',
  },
  overlayProgress: {
    color: '#666',
    fontSize: 14,
    textAlign: 'center',
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
  // Torch overlay
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
  torchOverlayError: {
    fontSize: 13,
    color: '#ff6b6b',
    textAlign: 'center',
  },
});
