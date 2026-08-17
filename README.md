[![License: CC BY-NC-SA 4.0](https://img.shields.io/badge/License-CC%20BY--NC--SA%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-nc-sa/4.0/)

# Orbit

The configuration app for the **Lunar x MacroPad**. Talks to the board over Raw
HID, alongside Vial.

> The repository is still named `KeyFigurator`. The app was renamed to Orbit and
> the product to Lunar x MacroPad in 2026-07; the repos keep their old names
> until that is done deliberately, because renaming breaks clones and remotes.

Does the things Vial structurally cannot:

- bind a key to a real host command (git / shell scripts)
- true per-key LED control, plus per-screen LED themes
- design what the OLED shows — layers, timers, countdowns, pomodoro, clock
- record macros by performing them, including shortcuts the OS normally eats

---

## Install (Windows)

1. Download `Orbit_<version>_x64-setup.exe` from the latest release.
2. Run it. It installs to `%LOCALAPPDATA%\Orbit` and adds a Start-menu entry.
3. Plug the board in. Orbit finds it automatically — the dot on the device card
   goes green, and the board's OLED shows its app-link dot.

No driver to install: the board enumerates as a standard HID device.

### Building the installer yourself

```bash
cd keyfigurator
npm install
npm run tauri build
```

Output lands in `keyfigurator/src-tauri/target/release/bundle/`:

| File | What it is |
|---|---|
| `nsis/Orbit_<version>_x64-setup.exe` | the installer |
| `msi/Orbit_<version>_x64_en-US.msi` | MSI, for deployment tooling |
| `Orbit.exe` (in `release/`) | the bare executable, no installer |

Prereqs: Rust, Node 18+, and the Tauri v2 prerequisites for Windows (MSVC or a
GNU toolchain + WebView2, which ships with Windows 11).

---

## Firmware

The board's firmware lives in
[Macro-Pro-Firmware](https://github.com/flamefir/Macro-Pro-Firmware)
(`keyboards/macro_pad_pro/`). Orbit reports the running firmware version on the
device card.

**Flashing:** hold `BOOTSEL` while plugging the board in (or double-tap reset, or
hold the top-left key while plugging in), then copy the `.uf2` onto the `RPI-RP2`
drive that appears.

> **Upgrading to firmware 0.4.0 or later from an earlier version resets the
> board's stored configuration.** 0.4.0 moved the EEPROM layout so the whole
> configuration survives a power cycle, and that shifts the dynamic keymap and
> the Vial macro buffer. The first boot after flashing reads the old keymap at
> the wrong offsets and will look scrambled. **Export from Orbit first** (Home →
> Export), then flash, reset the device, and import. This is expected, not a
> fault.

---

## Layout

```
keyfigurator/          the Tauri app  (see keyfigurator/README.md)
docs/                  design notes and decisions
```

## Licence

CC BY-NC-SA 4.0.
