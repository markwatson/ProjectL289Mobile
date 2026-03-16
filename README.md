# ProjectL289Mobile

Mobile app for setting L289.2 movement watches via the [Watch Optical Protocol (WOP)](docs/spec.md).

The L289.2 movement is found in high-precision quartz GMT watches. As official apps are removed from app stores or drop support for older OS versions, this project ensures owners can continue to sync their watches — a right-to-repair tool.

## Status

**Working on Android (tested on Pixel).** and **iOS (tested on iPhone 17 Pro)**.

A screen flash mode was attempted as well, which would allow the app to be hosted on any website, but the timing never worked right. Full [details here](https://github.com/markwatson/ProjectL289Mobile/blob/main/docs/web_transmission_investigation.md).

Unfortunately I won't publish this to the app store just in case it would upset the folks that made the original watch. You can build from source, or sideload the app if you with though (on Android only). On iOS there is a native version of the app still, so I recommend you use that. Just make sure to align the watch with the LED on the back of your phone, not using the camera in the app.

**NOTE:** This app was primarily "vibe-coded". I just didn't want to spend the time to hand write the code since I just needed it for one of my watches.

### What works
- Native torch transmission using `CameraManager.setTorchMode()` on a max-priority busy-wait thread
- Asymmetric LED offset compensation (configurable 0-15ms) for device-specific rise-time latency
- Full WOP frame encoding: header, timezone, time, date, DST events, CRC-8, bit stuffing
- Time pre-compensation so the final bit lands on a UTC second boundary
- CI/CD with GitHub Actions: lint, build, and release APK/IPA on tag push

### Progress log
- **2026-03-15:** Wrapped up the iOS version, and cleaned up the app visuals. This now works on both platforms, and was tested against a real watch + analyzed at the lab. I probably won't work on this much more - it's good enough for me right now.

- **2026-03-08:** First successful watch sync via native torch transmitter on Pixel. The key was replacing `requestAnimationFrame`-based torch toggling (JS layer, ~16ms granularity) with a native Kotlin module that busy-waits with `System.nanoTime()` for precise 30ms bit timing. Offset=0ms worked on Pixel — modern Android phones may have fast enough LED response that no compensation is needed.
- Screen flash mode transmits but the watch doesn't acknowledge — likely a brightness/contrast issue. Needs lab measurement to diagnose.

### Next steps
- Experiment with timing parameters across different Android devices. (I only have one android phone at the moment)
- Lab work: measure torch and screen flash signals with photodiode to characterize LED rise-time and screen brightness — see [Lab Test Rig Guide](docs/lab-test-rig.md). I already measured the devices I have access to.

## Architecture

- **React Native / Expo** — cross-platform UI, timezone picker, transmission controls
- **Native Kotlin module** (`modules/native-torch-transmitter/`) — precision torch transmission on Android
- **JS transmitter** (`src/transmitter.ts`) — screen flash mode using `requestAnimationFrame` - not used right now since it doesn't work.
- **Protocol encoder** (`src/encoder.ts`) — WOP frame assembly, CRC-8, bit stuffing

The native module is the critical piece for torch mode. It spawns a max-priority thread that:
1. Finds the back camera with flash via Camera2 API
2. Busy-waits with `System.nanoTime()` for each 30ms bit period
3. Applies asymmetric offset compensation (shortens 0-bits before rising edges, extends 1-bits after) to match LED rise-time characteristics

## Documentation

- **[WOP Protocol Specification](docs/spec.md)** — full protocol spec (framing, opcodes, CRC, DST rules, etc.)
- **[Web Transmission Investigation](docs/web_transmission_investigation.md)** — why web APIs can't reliably transmit WOP
- **[Lab Test Rig](docs/lab-test-rig.md)** — photodiode circuit for measuring and comparing optical signals
- **[Signal Captures](docs/exports/)** — raw Saleae Logic captures from official and experimental transmissions

## Development

### Prerequisites
- Node.js / Bun
- Android Studio (for native builds)

### Setup
```bash
npm install   # or: bun install
```

### Commands
```bash
npx expo run:android   # Build and run on Android device/emulator
npx expo run:ios       # Build and run on iOS (torch module is Android-only for now)
npx expo start         # Start Metro dev server
npm run lint           # Run ESLint
```

Note: Changes to the native module (`modules/native-torch-transmitter/`) require a full native rebuild (`expo run:android`), not just a hot reload.

## Folder Structure

```
ProjectL289Mobile/
├── app/                          # Screens & navigation (Expo Router, file-based routing)
│   ├── (tabs)/
│   │   ├── index.tsx             # Main flash screen — timezone picker, offset selector, transmission UI
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
│               └── NativeTorchTransmitterModule.kt  # Kotlin torch transmitter
│
├── docs/                         # Documentation and lab data
│   ├── spec.md                   # WOP protocol specification
│   ├── lab-test-rig.md           # Photodiode measurement circuit guide
│   ├── web_transmission_investigation.md  # Web platform limitations analysis
│   ├── circuit-diagram.svg       # Lab rig schematic
│   ├── analyze_captures.py       # Python tool for signal analysis
│   └── exports/                  # Saleae Logic capture CSVs
│
├── components/                   # Reusable React Native UI components
├── constants/                    # Theme colors, etc.
├── hooks/                        # React hooks
├── assets/                       # Images, fonts, icons
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

## Credits & History

Special thanks to **DaveM** from the WatchUSeek forums for his foundational [reverse engineering work](https://www.watchuseek.com/threads/longines-vhp-gmt-with-flash-setting.5296584/) and signal captures, which made the initial protocol mapping possible.

## Disclaimers

### Legal Notice
This project is an independent effort created for the purposes of interoperability, preservation, and right-to-repair. It is not affiliated with, authorized by, or endorsed by The Swatch Group, Longines, or any of their subsidiaries. All product names, trademarks, and registered trademarks are property of their respective owners.

This implementation was developed through independent analysis of the communication protocol. No copyrighted code from proprietary applications is distributed in this repository.

### Limitation of Liability
**USE AT YOUR OWN RISK.** This software interacts with the internal firmware of high-precision electronic devices. The authors and contributors are not responsible for any damage to hardware, loss of data, or voiding of warranties that may occur through the use of this software.

## License
This project is licensed under the **MIT License**. See the [LICENSE](LICENSE) file for details.
