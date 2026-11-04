# Changelog

All notable changes. Newest first. The project is early and has no tagged releases yet.

## Unreleased

### Added
- **Visualizer tile** (`viz`): a spectrum of the Mac's system audio drawn on the tablet, in five
  styles chosen per tile (bars with peak caps, mirror, blocks, wave, ring). A Core Audio process
  tap (`tools/sysaudio.swift`) feeds an FFT; the server compiles it on first use and runs it only
  while a tablet shows the tile. Needs the macOS "System Audio Recording" permission.
- **Quarter-tile grid:** every key is resizable down to a quarter of a classic tile (grid measured
  in units, config version 2). Drag handle and size steppers in the editor. A version-1 `pad.json`
  is migrated on first start and kept as `pad.json.v1.bak`.
- **Radio:** a car-stereo widget (Nightride FM and Virgin Radio) and 1-cell station tiles
  (play/stop). Plays on the Mac (mpv or ffplay) or on the tablet, switchable with MAC/TAB.
- **Pad bar:** reload button and a button that opens the dashboard kiosk (`KIOSK_URL`).
- **Latching keys** ("remember on/off") with a sunk-in lit state.
- **Keys step:** repeated presses (quick double press) and modifier-only taps (e.g. double Option).
- **Mouse click step** (left/right/middle, single/double/triple).
- **Mac actions catalog**, `when` guard, `continueOnError`, `$PAD_OUT`.
- **Long press, status LEDs, faders**, cube page transition, cyberpunk look with 3D keys.
- English by default with Italian (`?lang=it`), MIT licence, launchd agent script.

### Fixed
- Digits in key combos are sent as top-row key codes (`keystroke "2"` arrived as keypad 2).
- Editor over `http://<lan-ip>`: adding a key failed (`crypto.randomUUID` is secure-context only).
- Editor header was rotated by the key-face CSS (`.top` rule).
- Editor: choosing the visualizer type threw and left a plain button.
- launchd: `ProcessType Interactive`; as a background job the visualizer ran at ~7 fps instead of 20.
- Reinstalling the launchd agent no longer races the asynchronous `bootout`.

### Not verified
- Real system-audio capture was only compiled and tested with the built-in test tone.
- Nothing has been run on a real tablet (designed for a Lenovo Duet Chromebook).
