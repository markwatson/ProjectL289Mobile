# ProjectL289Mobile

Mobile companion app for [Project L289](../ProjectL289/) — sets Longines VHP GMT (L289.2 movement) watches via the Watch Optical Protocol (WOP).

## Status

**Torch mode: Working on Pixel (Android).** Screen flash mode not yet functional.

### What works
- Native torch transmission using `CameraManager.setTorchMode()` on a max-priority busy-wait thread
- Asymmetric LED offset compensation (configurable 0-15ms) for device-specific rise-time latency
- Full WOP frame encoding: header, timezone, time, date, DST events, CRC-8, bit stuffing
- Time pre-compensation so the final bit lands on a UTC second boundary

### Progress log
- **2026-03-08:** First successful watch sync via native torch transmitter on Pixel. The key was replacing `requestAnimationFrame`-based torch toggling (JS layer, ~16ms granularity) with a native Kotlin module that busy-waits with `System.nanoTime()` for precise 30ms bit timing. Offset=0ms worked on Pixel — modern Android phones may have fast enough LED response that no compensation is needed.
- Screen flash mode transmits but the watch doesn't acknowledge — likely a brightness/contrast issue. Needs lab measurement to diagnose.

### Next steps
- Experiment with timing parameters across different Android devices
- Lab work: measure torch and screen flash signals with photodiode to characterize LED rise-time and screen brightness — see [Lab Test Rig Guide](docs/lab-test-rig.md)
- Investigate screen flash mode failure (brightness? timing? contrast ratio?)
- Build full UI once more transmission scenarios are validated
- ~~iOS support~~ ✓ (implemented, not yet lab-tested)

## Architecture

- **React Native / Expo** — cross-platform UI, timezone picker, transmission controls
- **Native Kotlin module** (`modules/native-torch-transmitter/`) — precision torch transmission on Android
- **JS transmitter** (`src/transmitter.ts`) — screen flash mode using `requestAnimationFrame`
- **Protocol encoder** (`src/encoder.ts`) — WOP frame assembly, CRC-8, bit stuffing

The native module is the critical piece for torch mode. It spawns a max-priority thread that:
1. Finds the back camera with flash via Camera2 API
2. Busy-waits with `System.nanoTime()` for each 30ms bit period
3. Applies asymmetric offset compensation (shortens 0-bits before rising edges, extends 1-bits after) matching the original Longines app's approach

## Development

### Prerequisites
- Node.js / Bun
- Android Studio (for native builds)

### Setup
```bash
bun install
```

### Commands
```bash
npx expo run:android   # Build and run on Android device/emulator
npx expo run:ios       # Build and run on iOS (torch module is Android-only for now)
npx expo start         # Start Metro dev server
```

Note: Changes to the native module (`modules/native-torch-transmitter/`) require a full native rebuild (`expo run:android`), not just a hot reload.

## Folder Structure

```
ProjectL289Mobile/
├── app/                          # Screens & navigation (Expo Router, file-based routing)
│   ├── (tabs)/
│   │   ├── index.tsx             # Main flash screen — timezone picker, offset selector, transmission UI
│   │   ├── explore.tsx           # Documentation / info screen
│   │   └── _layout.tsx           # Tab bar layout
│   ├── _layout.tsx               # Root layout (wraps everything)
│   └── modal.tsx                 # Modal screen
│
├── src/                          # Core logic (cross-platform TypeScript)
│   ├── encoder.ts                # WOP protocol: frame assembly, CRC-8, bit stuffing, time compensation
│   ├── timezones.ts              # Timezone database with DST rules and event computation
│   ├── transmitter.ts            # Screen flash transmitter (requestAnimationFrame-based)
│   └── nativeTorchTransmitter.ts # JS wrapper for the native torch module
│
├── modules/                      # Local Expo native modules (auto-detected by autolinking)
│   └── native-torch-transmitter/
│       ├── expo-module.config.json           # Tells Expo this is a module + which platforms
│       ├── src/
│       │   ├── index.ts                      # JS exports (transmitBitstream, TransmitResult type)
│       │   └── NativeTorchTransmitterModule.ts  # requireNativeModule bridge
│       └── android/
│           ├── build.gradle                  # Android library build config
│           ├── src/main/AndroidManifest.xml
│           └── src/main/java/expo/modules/nativetorchtransmitter/
│               └── NativeTorchTransmitterModule.kt  # THE KEY FILE — Kotlin torch transmitter
│
├── android/                      # Generated Android project (managed by Expo prebuild)
│   └── app/src/main/java/com/anonymous/ProjectL289Mobile/
│       ├── MainActivity.kt       # Android entry point (mostly boilerplate)
│       └── MainApplication.kt    # App initialization (mostly boilerplate)
│
├── ios/                          # Generated iOS project (managed by Expo prebuild)
│
├── components/                   # Reusable React Native UI components
├── constants/                    # Theme colors, etc.
├── hooks/                        # React hooks
├── assets/                       # Images, fonts, icons
├── docs/plans/                   # Design docs and implementation plans
│
├── app.json                      # Expo config (app name, plugins, permissions, build settings)
├── package.json                  # Dependencies and scripts
└── tsconfig.json                 # TypeScript config
```

**Key things to know:**
- `app/` uses file-based routing — the file path IS the route. `(tabs)` is a layout group, not a URL segment.
- `src/` is your code, `android/` and `ios/` are generated scaffolding — edit them rarely.
- `modules/` is where local native modules live. Expo auto-discovers them. Changes here need a full native rebuild.
- Hot reload (Metro) only applies to JS/TS changes. Native code changes (Kotlin/Swift) need `expo run:android` or `expo run:ios`.
