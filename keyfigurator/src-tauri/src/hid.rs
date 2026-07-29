//! HID transport: the boundary between the app and the keyboard.
//!
//! The whole app talks to the board ONLY through the `HidTransport` trait. An
//! implementer supplies just two things — `is_connected` and `transceive` (send
//! one 32-byte frame, get one back). Every high-level operation (keymap, LEDs,
//! OLED, eeprom, ping) is a DEFAULT method built on `transceive` using the
//! byte-accurate [`crate::kf_protocol`] codec, so `MockHid` and `RealHid` share
//! the exact same protocol logic — the mock cannot drift from the firmware.
//!
//! - `MockHid` wraps a [`kf_protocol::BoardModel`] (a software port of
//!   `kf_hid.c`) and works today with no hardware.
//! - `RealHid` talks to a physical board over USB (hidapi). It is *supervised*:
//!   it survives the board not being present and hot-plugs in both directions.
//! - `BoardLink` is what the app actually holds — it routes each frame to the
//!   real board when one is attached and to the mock when one isn't, so the
//!   editor keeps working with no hardware and starts driving the board the
//!   moment it is plugged in.

use crate::kf_protocol::{self as kf, BoardModel, REPORT_LEN};
use crate::model::{AnimState, KeyMap, Layer, LedState, OledConfig, Palette, PomodoroConfig, UnderglowAnim};
use crate::products::Version;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Debug, thiserror::Error)]
pub enum HidError {
    #[error("no device connected")]
    NotConnected,
    #[error("device i/o error: {0}")]
    Io(String),
}

/// What a board says it is: product line, PCB revision, firmware build.
#[derive(Debug, Clone, Serialize)]
pub struct DeviceIdentity {
    pub product_id: u8,
    pub product_name: String,
    pub hardware: Version,
    pub firmware: Version,
}

/// Firmware version reported by PING.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct PingInfo {
    pub protocol: u8,
    pub fw_major: u8,
    pub fw_minor: u8,
}

fn expect_ok(resp: &[u8; REPORT_LEN]) -> Result<(), HidError> {
    match resp[2] {
        kf::STATUS_OK => Ok(()),
        other => Err(HidError::Io(format!("board returned status {other:#04x}"))),
    }
}

/// Everything the app needs from a keyboard. Implementers provide `is_connected`
/// + `transceive`; the rest are protocol default methods.
pub trait HidTransport: Send + Sync {
    fn is_connected(&self) -> bool;

    /// Send one 32-byte report and return the 32-byte response.
    fn transceive(&mut self, frame: &[u8; REPORT_LEN]) -> Result<[u8; REPORT_LEN], HidError>;

    /// PING purely as a liveness poke — did the board answer, yes or no.
    ///
    /// The firmware counts the app as present for `KF_APP_TIMEOUT_MS` (8 s)
    /// after *any* KeyFigurator frame, and drives its OLED link dot off that.
    /// So the app's connection poll has to actually touch the wire: reading
    /// `has_board()` alone sends nothing, and the dot goes red while the app
    /// sits idle even though it is running and attached.
    ///
    /// Deliberately not `ping()`. A protocol-mismatched board is still very
    /// much attached, and answering "no board" for one would hide a version
    /// problem behind a wiring problem.
    fn heartbeat(&mut self) -> bool {
        self.transceive(&kf::ping_frame()).is_ok()
    }

    /// PING → validate the protocol version matches the app.
    fn ping(&mut self) -> Result<PingInfo, HidError> {
        let resp = self.transceive(&kf::ping_frame())?;
        let info = PingInfo {
            protocol: resp[2],
            fw_major: resp[3],
            fw_minor: resp[4],
        };
        if info.protocol != kf::PROTOCOL_VERSION {
            return Err(HidError::Io(format!(
                "protocol mismatch: board v{}, app v{}",
                info.protocol,
                kf::PROTOCOL_VERSION
            )));
        }
        Ok(info)
    }

    /// GET_IDENTITY → product, hardware revision, firmware build.
    ///
    /// Separate from `ping`, which only negotiates the protocol version. Kept
    /// separate on purpose: a protocol-mismatched board still answers PING
    /// readably, which is how the app can say "your firmware is too old"
    /// instead of failing with a raw status byte.
    fn identity(&mut self) -> Result<DeviceIdentity, HidError> {
        let resp = self.transceive(&kf::identity_frame())?;
        let name_len = (resp[9] as usize).min(kf::PRODUCT_NAME_MAX);
        let name = String::from_utf8_lossy(&resp[10..10 + name_len]).into_owned();
        Ok(DeviceIdentity {
            product_id: resp[2],
            product_name: name,
            hardware: Version::new(resp[3], resp[4], resp[5]),
            firmware: Version::new(resp[6], resp[7], resp[8]),
        })
    }

    fn get_keymap(&mut self) -> Result<KeyMap, HidError> {
        let mut layers = Vec::with_capacity(kf::LAYER_COUNT);
        for layer in 0..kf::LAYER_COUNT as u8 {
            let mut keys = Vec::with_capacity(kf::KEY_COUNT);
            let mut offset = 0usize;
            while offset < kf::KEY_COUNT {
                let count = (kf::KEY_COUNT - offset).min(kf::KEYMAP_CHUNK_MAX);
                let req = kf::frame(kf::CMD_GET_KEYMAP, &[layer, offset as u8, count as u8]);
                let resp = self.transceive(&req)?;
                // Success echoes [layer, offset, count, …]; an error is [0, 0, status].
                if resp[2] != layer || resp[3] != offset as u8 {
                    return Err(HidError::Io("get_keymap: error response".into()));
                }
                let n = resp[4] as usize;
                for i in 0..n {
                    let kc = resp[5 + i * 2] as u16 | ((resp[6 + i * 2] as u16) << 8);
                    keys.push(kf::keycode_from_u16(kc));
                }
                offset += count;
            }
            layers.push(Layer { keys });
        }
        Ok(KeyMap { layers })
    }

    fn set_keymap(&mut self, map: &KeyMap) -> Result<(), HidError> {
        for (li, layer) in map.layers.iter().enumerate().take(kf::LAYER_COUNT) {
            let kcs: Vec<u16> = layer
                .keys
                .iter()
                .take(kf::KEY_COUNT)
                .map(|s| {
                    kf::keycode_to_u16(s).unwrap_or_else(|| {
                        eprintln!("kf: unknown keycode {s:?} -> KC_NO (defer to Vial)");
                        0
                    })
                })
                .collect();
            for req in kf::set_keymap_frames(li as u8, &kcs) {
                let resp = self.transceive(&req)?;
                expect_ok(&resp)?;
            }
        }
        Ok(())
    }

    /// Push per-key + underglow colours (25 slots) and brightness. Sending
    /// colour data implicitly turns the overlay on (firmware behaviour).
    fn set_leds(&mut self, leds: &LedState) -> Result<(), HidError> {
        for req in kf::set_led_color_frames(&leds.to_slots()) {
            let resp = self.transceive(&req)?;
            expect_ok(&resp)?;
        }
        let resp = self.transceive(&kf::brightness_frame(leds.brightness))?;
        expect_ok(&resp)
    }

    /// Upload a QGF image to the board's image screen.
    ///
    /// One-time, not per frame: once loaded, `qp_animate` plays it on-device
    /// with no further host traffic, so the animation survives the app closing.
    /// A failure part-way leaves the board with no image rather than a corrupt
    /// one, because `OLED_IMG_END` verifies the byte count before loading.
    fn push_oled_image(&mut self, image: &[u8]) -> Result<(), HidError> {
        let resp = self.transceive(&kf::oled_img_begin_frame(image.len() as u32))?;
        expect_ok(&resp)?;
        for f in kf::oled_img_data_frames(image) {
            let resp = self.transceive(&f)?;
            expect_ok(&resp)?;
        }
        let resp = self.transceive(&kf::oled_img_end_frame())?;
        expect_ok(&resp)
    }

    /// Select the global animation. QMK's RGB matrix has one mode for the whole
    /// board, so this is deliberately not per-key — per-key state is colour only.
    ///
    /// `AnimState::name` is mapped to a stable wire id here rather than sent
    /// raw, because QMK's own effect numbers shift with the compiled-in set.
    fn set_anim(&mut self, anim: &AnimState) -> Result<(), HidError> {
        let (h, s, v) = anim.hsv();
        let resp = self.transceive(&kf::set_anim_frame(
            kf::anim_id(&anim.name),
            anim.speed,
            h,
            s,
            v,
        ))?;
        expect_ok(&resp)
    }

    /// Hand the LEDs back to the board's own RGB matrix animations (`on = false`)
    /// or re-assert the host's colour overlay (`on = true`).
    ///
    /// This is the only way back: `set_leds` colour data implicitly sets
    /// `overlay_on = 1` in the firmware, so once the app has pushed colours the
    /// board renders nothing but that static frame until it is told otherwise.
    fn set_overlay(&mut self, on: bool) -> Result<(), HidError> {
        let resp = self.transceive(&kf::overlay_frame(on))?;
        expect_ok(&resp)
    }

    /// Push the full OLED config (RAM-only on the board, so re-push on reconnect).
    /// Push a "Cycle Colors" palette for one target (keys or underglow).
    ///
    /// Length first, then the colours: the board reads length as "how many of
    /// these are live", so raising it before the data is written would show
    /// stale entries for a frame.
    fn set_palette(&mut self, target: u8, pal: &Palette) -> Result<(), HidError> {
        let n = pal.colors.len().min(kf::PALETTE_MAX);
        let resp = self.transceive(&kf::set_palette_len_frame(target, n as u8, pal.rate))?;
        expect_ok(&resp)?;
        for f in kf::set_palette_frames(target, &pal.colors[..n]) {
            let resp = self.transceive(&f)?;
            expect_ok(&resp)?;
        }
        Ok(())
    }

    /// Push the underglow's own animation.
    ///
    /// Separate command because the board renders those four LEDs itself: QMK
    /// has one effect for the whole matrix, so `set_anim` could never give the
    /// underglow something different from the keys.
    fn set_ug_anim(&mut self, ug: &UnderglowAnim) -> Result<(), HidError> {
        let resp = self.transceive(&kf::set_ug_anim_frame(
            kf::anim_id(&ug.name),
            ug.speed,
            ug.intensity,
        ))?;
        expect_ok(&resp)
    }

    /// Push the whole OLED config.
    ///
    /// Returns whether the board accepted the pomodoro durations. `false` means
    /// firmware predating 0x58, which keeps its built-in 25/5/15/4 — everything
    /// else in the config still landed. Reported rather than swallowed so the
    /// settings UI can say so instead of showing inputs that do nothing.
    fn push_oled(&mut self, cfg: &OledConfig) -> Result<bool, HidError> {
        for (li, l) in cfg.layers.iter().enumerate().take(kf::LAYER_COUNT) {
            let resp = self.transceive(&kf::oled_set_layer_frame(li as u8, l.show_title, &l.name))?;
            expect_ok(&resp)?;
        }
        // Tell the board how many layer screens to show BEFORE the screen list,
        // so navigation is never briefly sized against the old count. Failure is
        // not fatal — older firmware simply keeps showing four.
        let n = cfg.layers.len().clamp(1, kf::LAYER_COUNT) as u8;
        let _ = self.transceive(&kf::oled_set_layer_count_frame(n))?;

        let types: Vec<u8> = cfg
            .screens
            .iter()
            .take(kf::OLED_MAX_CUSTOM_SCREENS)
            .map(|s| screen_kind_to_type(&s.kind))
            .collect();
        let resp = self.transceive(&kf::oled_set_screens_frame(&types))?;
        expect_ok(&resp)?;
        for (si, s) in cfg.screens.iter().enumerate().take(kf::OLED_MAX_CUSTOM_SCREENS) {
            if screen_kind_to_type(&s.kind) == kf::SCREEN_CUSTOM_TEXT {
                for f in kf::oled_set_text_frames(si as u8, 0, &s.title) {
                    let resp = self.transceive(&f)?;
                    expect_ok(&resp)?;
                }
                for f in kf::oled_set_text_frames(si as u8, 1, &s.body) {
                    let resp = self.transceive(&f)?;
                    expect_ok(&resp)?;
                }
            }
        }
        // Group by screen: one frame per screen carries all of its bindings.
        for slot in 0u8..10 {
            let pairs: Vec<(u8, u8)> = cfg
                .event_keys
                .iter()
                .filter(|(s, _, _)| *s == slot)
                .map(|(_, e, k)| (*e, *k))
                .collect();
            if pairs.is_empty() {
                continue;
            }
            for f in kf::oled_set_event_keys_frames(slot, &pairs) {
                let resp = self.transceive(&f)?;
                expect_ok(&resp)?;
            }
        }

        // Title size. 0 means the payload predates the setting, so leave the
        // board on whatever it has rather than snapping it to a default.
        if cfg.font_scale > 0 {
            let resp = self.transceive(&kf::oled_set_font_frame(cfg.font_scale))?;
            let _ = expect_ok(&resp); // old firmware simply has no font command
        }

        // Each screen's own LEDs. Rejection is not fatal: a board too old for
        // this keeps one global profile, which is exactly how it behaved before
        // the command existed, and everything else in this push still lands.
        for sl in &cfg.screen_leds {
            let (h, s, v) = sl.anim.hsv();
            for f in kf::set_screen_leds_frames(
                sl.slot,
                &sl.leds.to_slots(),
                kf::anim_id(&sl.anim.name),
                sl.anim.speed,
                (h, s, v),
                kf::anim_id(&sl.underglow.name),
                sl.underglow.speed,
                sl.underglow.intensity,
            ) {
                let resp = self.transceive(&f)?;
                if expect_ok(&resp).is_err() {
                    break;
                }
            }
        }

        // Icon / macro / keycode go over as three fields. A board that predates
        // SET_KEY_INFO answers STATUS_ERROR, so fall back to the single-string
        // command it does understand rather than failing the whole save — the
        // rest of this push is perfectly good on such a board.
        for (i, info) in cfg.key_info.iter().enumerate().take(kf::KEY_COUNT) {
            let fields = [
                (kf::KEY_INFO_MACRO, &info.macro_title),
                (kf::KEY_INFO_KEYCODE, &info.keycode),
            ];
            let mut supported = true;
            for (field, text) in fields {
                let resp = self.transceive(&kf::oled_set_key_info_frame(i as u8, field, text))?;
                if expect_ok(&resp).is_err() {
                    supported = false;
                    break;
                }
            }
            if !supported {
                // Same priority the old command carried: the macro names the
                // key if it has one, otherwise its keycode does.
                let legacy = if info.macro_title.is_empty() {
                    &info.keycode
                } else {
                    &info.macro_title
                };
                let resp = self.transceive(&kf::oled_set_key_label_frame(i as u8, legacy))?;
                expect_ok(&resp)?;
            }
        }

        // The icon masks. Sent for every key, `None` included: a cleared icon
        // has to be told to the board or the old one lingers there. Rejection
        // is not fatal — a board too old for this falls back to the text, which
        // it already has.
        for (i, mask) in cfg.key_icons.iter().enumerate().take(kf::KEY_COUNT) {
            for f in kf::oled_set_key_icon_frames(i as u8, mask.as_deref()) {
                let resp = self.transceive(&f)?;
                if expect_ok(&resp).is_err() {
                    break;
                }
            }
        }

        let (h, m, s) = cfg.countdown;
        let resp = self.transceive(&kf::oled_set_countdown_frame(h, m, s))?;
        expect_ok(&resp)?;
        // Rejection is not fatal for either of these two: a board too old for
        // them must still have received everything above. Sleep is sent first
        // so the pomodoro answer is the one reported — it is the setting with
        // visible UI riding on whether the board took it.
        let sleep = kf::oled_set_sleep_frame(cfg.sleep_timeout_s, cfg.sleep_mask);
        let _ = self.transceive(&sleep)?;
        self.push_pomodoro(&cfg.pomodoro)
    }

    /// Push the pomodoro phase durations.
    ///
    /// `Ok(false)` means the board answered but rejected the command, which is
    /// how firmware predating 0x58 identifies itself. That is a real answer,
    /// not a failure, so it is distinct from `Err` (the wire broke). Asking the
    /// board beats checking a firmware version number: it is ground truth, and
    /// there is no version table to keep in sync.
    fn push_pomodoro(&mut self, p: &PomodoroConfig) -> Result<bool, HidError> {
        let resp = self.transceive(&kf::oled_set_pomodoro_frame(
            p.work_min,
            p.pause_min,
            p.cycles,
        ))?;
        Ok(expect_ok(&resp).is_ok())
    }

    #[allow(clippy::too_many_arguments)]
    fn sync_time(
        &mut self,
        year_2000: u8,
        month: u8,
        day: u8,
        hour: u8,
        min: u8,
        sec: u8,
        weekday: u8,
    ) -> Result<(), HidError> {
        let resp = self.transceive(&kf::oled_sync_time_frame(
            year_2000, month, day, hour, min, sec, weekday,
        ))?;
        expect_ok(&resp)
    }

    fn eeprom_commit(&mut self) -> Result<(), HidError> {
        let resp = self.transceive(&kf::eeprom_commit_frame())?;
        expect_ok(&resp)
    }
}

/// Map the app's OLED screen `kind` string to the firmware `kf_screen_type`.
fn screen_kind_to_type(kind: &str) -> u8 {
    match kind {
        "timer" => kf::SCREEN_TIMER,
        "countdown" => kf::SCREEN_COUNTDOWN,
        "datetime" => kf::SCREEN_DATETIME,
        "pomodoro" => kf::SCREEN_POMODORO,
        // The app calls it a "gif" screen; the firmware calls it an image screen.
        "image" => kf::SCREEN_IMAGE,
        _ => kf::SCREEN_CUSTOM_TEXT,
    }
}

// ---------------------------------------------------------------------------
// Mock: a software model of the board. No hardware needed. Routes every frame
// through the same BoardModel + codec the firmware uses.
// ---------------------------------------------------------------------------
pub struct MockHid {
    board: BoardModel,
}

impl MockHid {
    pub fn new() -> Self {
        let mut board = BoardModel::default();
        // Seed a starter keymap so the UI shows something on first load.
        let km = KeyMap::default_21key();
        for (li, layer) in km.layers.iter().enumerate() {
            for (ki, name) in layer.keys.iter().enumerate() {
                board.keymap[li][ki] = kf::keycode_to_u16(name).unwrap_or(0);
            }
        }
        Self { board }
    }
}

impl Default for MockHid {
    fn default() -> Self {
        Self::new()
    }
}

impl HidTransport for MockHid {
    fn is_connected(&self) -> bool {
        true // the mock is always "plugged in"
    }
    fn transceive(&mut self, frame: &[u8; REPORT_LEN]) -> Result<[u8; REPORT_LEN], HidError> {
        self.board
            .handle(frame)
            .ok_or_else(|| HidError::Io("mock: not a KeyFigurator frame".into()))
    }
}

// ---------------------------------------------------------------------------
// Real: talks to the actual board over Raw HID via `hidapi`.
//
// The `HidDevice` is not `Sync`, and unsolicited RUN_HOST_CMD packets share the
// single IN pipe with command responses. So one dedicated supervisor thread OWNS
// the `HidApi` and the device and serializes all access: `transceive` hands it a
// request over a channel and blocks for the reply; when idle the thread polls
// for unsolicited RUN_HOST_CMD packets and forwards their index to the host-cmd
// channel.
//
// That thread also owns CONNECTION STATE. It runs for the whole life of the app
// whether or not a board is present: when dark it rescans every SCAN_INTERVAL
// and attaches as soon as the board appears; when a USB error says the board
// went away it drops the device and goes dark again. So unplug/replug works any
// number of times within one session — connecting is not a startup-only event.
//
// Identity constants live in kf_protocol (kf::VENDOR_ID / PRODUCT_ID / USAGE*).
// ---------------------------------------------------------------------------
type IoRequest = ([u8; REPORT_LEN], Sender<Result<[u8; REPORT_LEN], HidError>>);

/// How often to rescan the USB bus while no board is attached.
const SCAN_INTERVAL: Duration = Duration::from_millis(1000);
/// How long the supervisor blocks per wait while dark. Shorter than
/// `SCAN_INTERVAL` so a queued frame is rejected promptly instead of sitting
/// until the next rescan.
const DARK_POLL: Duration = Duration::from_millis(200);
/// How long a caller waits for the supervisor to answer one frame.
const TRANSCEIVE_TIMEOUT: Duration = Duration::from_secs(3);

pub struct RealHid {
    req_tx: Mutex<Sender<IoRequest>>,
    connected: Arc<AtomicBool>,
}

impl RealHid {
    /// Start the supervised Raw HID link. Never fails on "no board" — it returns
    /// a handle that reports `is_connected() == false` and attaches by itself as
    /// soon as a board is plugged in.
    ///
    /// `host_cmd_tx` receives the binding index whenever the board sends an
    /// unsolicited RUN_HOST_CMD packet. `conn_tx` receives `true`/`false` on
    /// every attach/detach so the UI can be told without waiting for a poll.
    pub fn start(host_cmd_tx: Sender<u8>, conn_tx: Sender<bool>) -> Self {
        let (req_tx, req_rx) = channel::<IoRequest>();
        let connected = Arc::new(AtomicBool::new(false));
        let conn_flag = connected.clone();

        // If the thread can't even spawn we still hand back a usable (permanently
        // disconnected) handle; BoardLink falls through to the mock.
        let spawned = std::thread::Builder::new()
            .name("kf-hid-io".into())
            .spawn(move || supervisor(&req_rx, &host_cmd_tx, &conn_tx, &conn_flag));
        if let Err(e) = spawned {
            eprintln!("kf: could not start the hid supervisor thread ({e}); mock only");
        }

        RealHid {
            req_tx: Mutex::new(req_tx),
            connected,
        }
    }
}

/// Outcome of one board transaction, separating "this call failed" from "the
/// board is gone" so the supervisor knows when to drop the device and rescan.
enum IoOutcome {
    Response([u8; REPORT_LEN]),
    /// Transaction failed but the device still looks alive (e.g. no reply).
    Failed(HidError),
    /// USB-layer error — treat the board as unplugged.
    Lost(HidError),
}

/// The single-owner supervisor loop: owns `HidApi` + the open device, services
/// `transceive` requests, drains unsolicited packets, and handles attach/detach.
/// Returns only when `RealHid` is dropped (the request channel closes).
fn supervisor(
    req_rx: &Receiver<IoRequest>,
    host_cmd_tx: &Sender<u8>,
    conn_tx: &Sender<bool>,
    connected: &AtomicBool,
) {
    // Exactly one HidApi for the process; it lives here for the whole run so
    // rescans are a `refresh_devices` rather than a re-init.
    let mut api = match hidapi::HidApi::new() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("kf: hidapi unavailable ({e}); mock only");
            return;
        }
    };

    let mut device: Option<hidapi::HidDevice> = None;
    let mut last_scan = Instant::now() - SCAN_INTERVAL;

    loop {
        // ---- Dark: no board attached. Reject queued frames, rescan on a timer.
        let Some(dev) = device.as_ref() else {
            match req_rx.recv_timeout(DARK_POLL) {
                Ok((_, resp_tx)) => {
                    let _ = resp_tx.send(Err(HidError::NotConnected));
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return, // RealHid dropped
            }
            if last_scan.elapsed() >= SCAN_INTERVAL {
                last_scan = Instant::now();
                if api.refresh_devices().is_ok() {
                    if let Ok(d) = find_and_open(&api) {
                        eprintln!("kf: board attached over Raw HID");
                        device = Some(d);
                        connected.store(true, Ordering::SeqCst);
                        let _ = conn_tx.send(true);
                    }
                }
            }
            continue;
        };

        // ---- Attached: serve requests, and poll for unsolicited packets when idle.
        let lost = match req_rx.try_recv() {
            Ok((frame, resp_tx)) => match write_then_read(dev, &frame, host_cmd_tx) {
                IoOutcome::Response(r) => {
                    let _ = resp_tx.send(Ok(r));
                    None
                }
                IoOutcome::Failed(e) => {
                    let _ = resp_tx.send(Err(e));
                    None
                }
                IoOutcome::Lost(e) => {
                    let _ = resp_tx.send(Err(HidError::NotConnected));
                    Some(e)
                }
            },
            Err(TryRecvError::Empty) => {
                let mut buf = [0u8; REPORT_LEN];
                match dev.read_timeout(&mut buf, 10) {
                    Ok(n) if n > 0 => {
                        if let Some(idx) = kf::parse_run_host_cmd(&buf) {
                            let _ = host_cmd_tx.send(idx);
                        }
                        None
                    }
                    Ok(_) => None, // read timed out, nothing available
                    Err(e) => Some(HidError::Io(e.to_string())),
                }
            }
            Err(TryRecvError::Disconnected) => return, // RealHid dropped
        };

        if let Some(e) = lost {
            eprintln!("kf: board detached ({e}); rescanning every {SCAN_INTERVAL:?}");
            device = None;
            connected.store(false, Ordering::SeqCst);
            let _ = conn_tx.send(false);
            // Rescan immediately rather than after a full interval, so a quick
            // replug (or a board rebooting out of the bootloader) reattaches fast.
            last_scan = Instant::now() - SCAN_INTERVAL;
        }
    }
}

/// Find the KeyFigurator interface (VID/PID on the QMK Raw HID usage) and open it.
fn find_and_open(api: &hidapi::HidApi) -> Result<hidapi::HidDevice, String> {
    let info = api
        .device_list()
        .find(|d| {
            d.vendor_id() == kf::VENDOR_ID
                && d.product_id() == kf::PRODUCT_ID
                && d.usage_page() == kf::USAGE_PAGE
                && d.usage() == kf::USAGE
        })
        .ok_or_else(|| "no KeyFigurator interface found".to_string())?;
    info.open_device(api).map_err(|e| e.to_string())
}

/// Write one request frame, then read until the matching response arrives,
/// forwarding any interleaved RUN_HOST_CMD packets to `host_cmd_tx`.
fn write_then_read(
    device: &hidapi::HidDevice,
    frame: &[u8; REPORT_LEN],
    host_cmd_tx: &Sender<u8>,
) -> IoOutcome {
    // QMK Raw HID uses report id 0: prepend a 0x00 report-id byte on write.
    let mut wbuf = [0u8; REPORT_LEN + 1];
    wbuf[1..].copy_from_slice(frame);
    if let Err(e) = device.write(&wbuf) {
        return IoOutcome::Lost(HidError::Io(e.to_string()));
    }

    // Up to ~2s (100 × 20ms) for the response.
    for _ in 0..100 {
        let mut buf = [0u8; REPORT_LEN];
        let n = match device.read_timeout(&mut buf, 20) {
            Ok(n) => n,
            Err(e) => return IoOutcome::Lost(HidError::Io(e.to_string())),
        };
        if n == 0 {
            continue;
        }
        if let Some(idx) = kf::parse_run_host_cmd(&buf) {
            let _ = host_cmd_tx.send(idx); // unsolicited; not our response
            continue;
        }
        return IoOutcome::Response(buf);
    }
    IoOutcome::Failed(HidError::Io("timeout waiting for board response".into()))
}

impl HidTransport for RealHid {
    fn is_connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }
    fn transceive(&mut self, frame: &[u8; REPORT_LEN]) -> Result<[u8; REPORT_LEN], HidError> {
        if !self.is_connected() {
            return Err(HidError::NotConnected);
        }
        let (resp_tx, resp_rx) = channel();
        self.req_tx
            .lock()
            .unwrap()
            .send((*frame, resp_tx))
            .map_err(|_| HidError::NotConnected)?;
        resp_rx
            .recv_timeout(TRANSCEIVE_TIMEOUT)
            .map_err(|_| HidError::Io("hid i/o thread timeout".into()))?
    }
}

// ---------------------------------------------------------------------------
// BoardLink — what the app holds. Routes each frame to the real board when one
// is attached and to the mock when one isn't, so the editor never breaks and a
// board that shows up mid-session is picked up without a restart.
// ---------------------------------------------------------------------------
pub struct BoardLink {
    real: RealHid,
    mock: MockHid,
}

impl BoardLink {
    pub fn new(real: RealHid) -> Self {
        Self {
            real,
            mock: MockHid::new(),
        }
    }

    /// True when a physical board is attached (as opposed to the mock standing in).
    pub fn has_board(&self) -> bool {
        self.real.is_connected()
    }
}

impl HidTransport for BoardLink {
    fn is_connected(&self) -> bool {
        self.has_board()
    }
    fn transceive(&mut self, frame: &[u8; REPORT_LEN]) -> Result<[u8; REPORT_LEN], HidError> {
        // Decided per frame, so a board attaching or detaching takes effect on
        // the very next frame instead of at the next app start.
        if self.real.is_connected() {
            self.real.transceive(frame)
        } else {
            self.mock.transceive(frame)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mock_roundtrips_keymap() {
        let mut hid = MockHid::new();
        let mut map = hid.get_keymap().unwrap();
        map.layers[0].keys[0] = "KC_ESC".into();
        hid.set_keymap(&map).unwrap();
        assert_eq!(hid.get_keymap().unwrap().layers[0].keys[0], "KC_ESC");
    }

    #[test]
    fn mock_is_always_connected() {
        assert!(MockHid::new().is_connected());
    }

    #[test]
    fn mock_sets_leds_and_brightness() {
        let mut hid = MockHid::new();
        let mut leds = LedState::all_off(kf::KEY_COUNT);
        leds.keys[4] = [255, 0, 0];
        leds.underglow[0] = [0, 255, 0];
        leds.brightness = 123;
        assert!(hid.set_leds(&leds).is_ok());
        // The brightness byte is fed by the UI's global control, so pin that it
        // actually lands on the board rather than just being accepted.
        assert_eq!(hid.board.brightness, 123);
        assert_eq!(hid.board.rgb[4], [255, 0, 0]);
    }

    /// The upload is a three-phase handshake, so a partial transfer must fail
    /// rather than leave the board loading a truncated QGF.
    #[test]
    fn oled_image_upload_round_trips_and_rejects_short_uploads() {
        let mut hid = MockHid::new();
        // Not a real QGF — the mock models the buffer handshake, not the parse.
        let image: Vec<u8> = (0..500u32).map(|i| (i % 251) as u8).collect();
        assert!(hid.push_oled_image(&image).is_ok());
        assert!(hid.board.oled_img_ready);
        assert_eq!(hid.board.oled_img_received, image.len(), "every byte arrived");
        assert_eq!(hid.board.oled_img_expected, 0, "no upload left in flight");

        // A second upload must start clean rather than accumulate on the first.
        assert!(hid.push_oled_image(&image).is_ok());
        assert_eq!(hid.board.oled_img_received, image.len());

        // BEGIN then END with no data must not mark an image ready.
        hid.transceive(&kf::oled_img_begin_frame(500)).unwrap();
        let resp = hid.transceive(&kf::oled_img_end_frame()).unwrap();
        assert_eq!(resp[2], kf::STATUS_ERROR, "short upload must be rejected");
        assert!(!hid.board.oled_img_ready);
    }

    /// Ask an attached board which of the NEW commands it understands.
    ///
    /// The only reliable way to tell what is actually flashed: firmware that
    /// predates a command answers STATUS_ERROR for it. Run with:
    ///   cargo test real_board_probe -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_board_probe() {
        let (host_cmd_tx, _rx) = channel::<u8>();
        let (conn_tx, _c) = channel::<bool>();
        let mut real = RealHid::start(host_cmd_tx, conn_tx);
        let mut waited = 0;
        while !real.is_connected() && waited < 6000 {
            std::thread::sleep(Duration::from_millis(100));
            waited += 100;
        }
        if !real.is_connected() {
            println!("NO BOARD ATTACHED");
            return;
        }
        println!("identity: {:?}", real.identity());

        let probes: [(&str, [u8; REPORT_LEN]); 5] = [
            ("SET_UG_ANIM 0x22", kf::set_ug_anim_frame(0, 128, 180)),
            ("SET_PALETTE 0x23", kf::set_palette_len_frame(0, 0, 128)),
            ("SET_LAYER_COUNT 0x5A", kf::oled_set_layer_count_frame(1)),
            ("SET_SLEEP 0x59", kf::oled_set_sleep_frame(60, 0)),
            (
                "SET_EVENT_KEYS 0x5B",
                kf::oled_set_event_keys_frames(0, &[(0, 5)])[0],
            ),
        ];
        for (name, f) in probes {
            match real.transceive(&f) {
                Ok(r) => println!(
                    "{name:22} -> status {:#04x}  {}",
                    r[2],
                    if r[2] == kf::STATUS_OK { "SUPPORTED" } else { "NOT in this firmware" }
                ),
                Err(e) => println!("{name:22} -> transport error: {e}"),
            }
        }
    }

    /// Walk the whole Save-to-Board sequence against a physically attached
    /// board, reporting which step fails rather than just that one did.
    ///
    ///   cargo test real_board_save -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_board_save() {
        let (host_cmd_tx, _rx) = channel::<u8>();
        let (conn_tx, _c) = channel::<bool>();
        let mut real = RealHid::start(host_cmd_tx, conn_tx);
        let mut waited = 0;
        while !real.is_connected() && waited < 6000 {
            std::thread::sleep(Duration::from_millis(100));
            waited += 100;
        }
        if !real.is_connected() {
            println!("NO BOARD ATTACHED — skipping");
            return;
        }
        println!("identity: {:?}", real.identity());
        println!("ping:     {:?}", real.ping());

        let mut map = KeyMap::default_21key();
        map.layers[0].keys[0] = "KC_A".into();
        println!("set_keymap:  {:?}", real.set_keymap(&map));

        let leds = LedState {
            keys: vec![[255, 0, 0]; kf::KEY_COUNT],
            underglow: vec![[0, 255, 0]; kf::UNDERGLOW_COUNT],
            brightness: 255,
        };
        println!("set_leds:    {:?}", real.set_leds(&leds));
        println!("set_anim:    {:?}", real.set_anim(&AnimState::default()));
        println!("set_ug_anim: {:?}", real.set_ug_anim(&UnderglowAnim::default()));

        let cfg = OledConfig {
            layers: vec![crate::model::OledLayer { name: "ORBIT".into(), show_title: true }],
            screens: vec![crate::model::OledScreen {
                kind: "pomodoro".into(), title: String::new(), body: String::new(),
            }],
            countdown: (0, 0, 0),
            pomodoro: PomodoroConfig::default(),
            sleep_mask: 0,
            sleep_timeout_s: 60,
            event_keys: Vec::new(),
            key_info: Vec::new(),
            key_icons: Vec::new(),
            font_scale: 0,
            screen_leds: Vec::new(),
        };
        println!("push_oled:   {:?}", real.push_oled(&cfg));
        println!("eeprom:      {:?}", real.eeprom_commit());

        // Read the keymap back: the only way to know SET actually landed.
        match real.get_keymap() {
            Ok(m) => println!("readback layer0[0] = {:?} (expected KC_A)", m.layers[0].keys[0]),
            Err(e) => println!("get_keymap FAILED: {e}"),
        }
    }

    /// Probe a physically attached board and print what PING returns.
    ///
    /// `#[ignore]` because it needs real hardware. Run with:
    ///   cargo test real_board_ping -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_board_ping() {
        let (host_cmd_tx, _rx) = channel::<u8>();
        let (conn_tx, _crx) = channel::<bool>();
        let mut hid = RealHid::start(host_cmd_tx, conn_tx);

        // The supervisor rescans every second while dark; give it a few tries.
        let mut waited = 0;
        while !hid.is_connected() && waited < 6000 {
            std::thread::sleep(Duration::from_millis(250));
            waited += 250;
        }
        if !hid.is_connected() {
            println!("NO BOARD ATTACHED (nothing on {:#06x}/{:#06x})", kf::VENDOR_ID, kf::PRODUCT_ID);
            return;
        }

        // Raw frame first, so a version mismatch still shows the bytes instead
        // of being swallowed by ping()'s error path.
        let raw = hid.transceive(&kf::ping_frame()).expect("ping transceive");
        println!("PING raw response: {:02X?}", &raw[..8]);
        println!(
            "  magic=0x{:02X} cmd=0x{:02X} protocol=v{} firmware=v{}.{}",
            raw[0], raw[1], raw[2], raw[3], raw[4]
        );
        println!("  app expects protocol v{}", kf::PROTOCOL_VERSION);
        if raw[2] != kf::PROTOCOL_VERSION {
            println!(
                "  => MISMATCH: board is v{}, app is v{} — ping() rejects this",
                raw[2],
                kf::PROTOCOL_VERSION
            );
        } else {
            println!("  => match");
        }

        match hid.ping() {
            Ok(info) => println!("ping() -> Ok({info:?})"),
            Err(e) => println!("ping() -> Err({e})"),
        }
    }

    /// Identity must decode to the three separate layers, and must resolve
    /// against the capability table — that lookup is what tells the app this
    /// board has no encoder push.
    #[test]
    fn identity_decodes_and_resolves_capabilities() {
        use crate::products;
        let mut hid = MockHid::new();
        let id = hid.identity().unwrap();

        assert_eq!(id.product_id, 0x01);
        assert_eq!(id.product_name, "Lunar x MacroPad");
        assert_eq!(id.hardware.to_string(), "1.0.0");
        assert_eq!(id.firmware.to_string(), "0.2.0");

        let spec = products::lookup(id.product_id, id.hardware).expect("known product");
        assert!(!spec.capabilities.encoder_push, "rev 1.0.0 has no encoder push");
    }

    /// Every screen kind the frontend can emit must map to a distinct firmware
    /// type. A missing arm silently falls through to CUSTOM_TEXT, which is how
    /// the image screen first shipped rendering as an empty text screen.
    #[test]
    fn every_screen_kind_maps_to_its_own_firmware_type() {
        assert_eq!(screen_kind_to_type("timer"), kf::SCREEN_TIMER);
        assert_eq!(screen_kind_to_type("countdown"), kf::SCREEN_COUNTDOWN);
        assert_eq!(screen_kind_to_type("datetime"), kf::SCREEN_DATETIME);
        assert_eq!(screen_kind_to_type("pomodoro"), kf::SCREEN_POMODORO);
        assert_eq!(screen_kind_to_type("image"), kf::SCREEN_IMAGE);
        assert_eq!(screen_kind_to_type("custom"), kf::SCREEN_CUSTOM_TEXT);
        assert_eq!(screen_kind_to_type("something else"), kf::SCREEN_CUSTOM_TEXT);
    }

    /// End to end: a real encoded QGF through the real chunker into the board
    /// model. Catches an off-by-one between the encoder's size, the chunking,
    /// and the board's byte accounting — which a hand-made byte vector would not.
    #[test]
    fn real_qgf_survives_encode_chunk_and_upload() {
        use crate::qgf;
        let img = image::RgbaImage::from_fn(48, 32, |x, y| {
            image::Rgba([(x * 5) as u8, (y * 7) as u8, 128, 255])
        });
        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();

        let encoded = qgf::encode_bytes(&png, 128, 8, kf::OLED_IMG_MAX_BYTES).unwrap();
        assert_eq!((encoded.width, encoded.height), (48, 32));

        let mut hid = MockHid::new();
        hid.push_oled_image(&encoded.bytes).unwrap();
        assert!(hid.board.oled_img_ready);
        assert_eq!(
            hid.board.oled_img_received,
            encoded.bytes.len(),
            "every encoded byte must reach the board exactly once"
        );

        // And the chunking must never exceed what one report can carry.
        for f in kf::oled_img_data_frames(&encoded.bytes) {
            assert!(f[5] as usize <= kf::OLED_IMG_CHUNK_MAX);
        }
    }

    /// Pins the bug `set_overlay` exists to fix: colour data implicitly turns
    /// the overlay ON in firmware, so without an explicit off the board is
    /// locked to that static frame and can never return to its own animations.
    #[test]
    fn set_overlay_hands_the_leds_back_after_a_colour_push() {
        let mut hid = MockHid::new();
        let mut leds = LedState::all_off(kf::KEY_COUNT);
        leds.keys[0] = [255, 0, 0];
        hid.set_leds(&leds).unwrap();
        assert!(hid.board.overlay_on, "colour data must imply overlay on");

        hid.set_overlay(false).unwrap();
        assert!(!hid.board.overlay_on, "overlay off returns the board to its own effects");

        hid.set_overlay(true).unwrap();
        assert!(hid.board.overlay_on, "overlay on re-asserts the host's colours");
    }

    #[test]
    fn mock_ping_reports_version() {
        let mut hid = MockHid::new();
        let info = hid.ping().unwrap();
        assert_eq!(info.protocol, kf::PROTOCOL_VERSION);
    }

    /// With no board attached, BoardLink must report "no board" yet still serve
    /// every operation off the mock, so the editor works with nothing plugged in.
    #[test]
    fn board_link_falls_through_to_mock_when_dark() {
        let (host_cmd_tx, _host_cmd_rx) = channel::<u8>();
        let (conn_tx, _conn_rx) = channel::<bool>();
        let mut link = BoardLink::new(RealHid::start(host_cmd_tx, conn_tx));

        assert!(!link.has_board(), "no hardware in a unit test");
        assert!(!link.is_connected());

        // Served by the mock: a full keymap round-trip still succeeds.
        let mut map = link.get_keymap().unwrap();
        map.layers[0].keys[3] = "KC_F5".into();
        link.set_keymap(&map).unwrap();
        assert_eq!(link.get_keymap().unwrap().layers[0].keys[3], "KC_F5");
        assert_eq!(link.ping().unwrap().protocol, kf::PROTOCOL_VERSION);
    }

    /// A disconnected RealHid rejects frames immediately rather than blocking a
    /// caller for the full transceive timeout.
    #[test]
    fn real_hid_rejects_frames_while_dark() {
        let (host_cmd_tx, _host_cmd_rx) = channel::<u8>();
        let (conn_tx, _conn_rx) = channel::<bool>();
        let mut real = RealHid::start(host_cmd_tx, conn_tx);

        assert!(!real.is_connected());
        let started = std::time::Instant::now();
        let err = real.transceive(&kf::ping_frame()).unwrap_err();
        assert!(matches!(err, HidError::NotConnected), "got {err:?}");
        assert!(
            started.elapsed() < TRANSCEIVE_TIMEOUT,
            "should fail fast, took {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn pomodoro_durations_reach_the_board() {
        let mut hid = MockHid::new();
        assert_eq!(
            hid.board.pomodoro,
            (25, 5, 4),
            "an unconfigured board runs the firmware's compile-time defaults"
        );

        let cfg = PomodoroConfig { work_min: 50, pause_min: 10, cycles: 3 };
        assert!(hid.push_pomodoro(&cfg).unwrap(), "mock supports the command");
        assert_eq!(hid.board.pomodoro, (50, 10, 3));
    }

    /// 0 is the protocol's "leave this one alone", so a host that only wants to
    /// change the work phase does not have to know the other three.
    #[test]
    fn pomodoro_zero_field_keeps_the_current_value() {
        let mut hid = MockHid::new();
        hid.push_pomodoro(&PomodoroConfig { work_min: 45, pause_min: 0, cycles: 0 })
            .unwrap();
        assert_eq!(hid.board.pomodoro, (45, 5, 4), "only work_min moved");
    }

    /// The firmware clamps instead of rejecting, so the app must not believe a
    /// value it sent is what the board ended up with.
    #[test]
    fn pomodoro_out_of_range_is_clamped_not_rejected() {
        let mut hid = MockHid::new();
        assert!(hid
            .push_pomodoro(&PomodoroConfig { work_min: 255, pause_min: 255, cycles: 255 })
            .unwrap());
        assert_eq!(
            hid.board.pomodoro,
            (kf::POMO_MAX_MINUTES, kf::POMO_MAX_MINUTES, kf::POMO_MAX_CYCLES)
        );
    }

    /// The whole point of not bumping the protocol version: a board that does
    /// not know 0x58 must still receive every other part of its OLED config.
    #[test]
    fn oled_push_survives_a_board_that_rejects_pomodoro() {
        let mut hid = MockHid::new();
        hid.board.reject_pomodoro = true;

        let cfg = OledConfig {
            layers: vec![crate::model::OledLayer { name: "GIT".into(), show_title: true }],
            screens: vec![crate::model::OledScreen {
                kind: "pomodoro".into(),
                title: String::new(),
                body: String::new(),
            }],
            countdown: (0, 5, 0),
            pomodoro: PomodoroConfig { work_min: 50, ..Default::default() },
            sleep_mask: 0,
            sleep_timeout_s: 60,
            event_keys: Vec::new(),
            key_info: Vec::new(),
            key_icons: Vec::new(),
            font_scale: 0,
            screen_leds: Vec::new(),
        };
        hid.push_oled(&cfg).expect("the rest of the config still lands");
        assert_eq!(hid.board.oled_layer_names[0], "GIT");
        assert_eq!(hid.board.oled_countdown, (0, 5, 0));
        assert_eq!(hid.board.pomodoro, (25, 5, 4), "old firmware keeps its defaults");

        assert!(
            !hid.push_pomodoro(&cfg.pomodoro).unwrap(),
            "and the UI is told the board does not support it"
        );
    }

    /// Cycle Colors has to survive the chunk boundary: 20 colours is three
    /// frames, and an off-by-one in the offset would corrupt entries 9 and 18
    /// while the first eight looked perfect.
    #[test]
    fn palette_round_trips_across_chunk_boundaries() {
        let mut hid = MockHid::new();
        assert_eq!(hid.board.palettes[0].len, 0, "no cycling until asked");

        let colors: Vec<crate::model::Rgb> =
            (0..kf::PALETTE_MAX).map(|i| [i as u8, 255 - i as u8, 7]).collect();
        hid.set_palette(kf::PALETTE_TARGET_KEYS, &Palette { colors: colors.clone(), rate: 200 })
            .unwrap();

        let p = &hid.board.palettes[kf::PALETTE_TARGET_KEYS as usize];
        assert_eq!(p.len as usize, kf::PALETTE_MAX);
        assert_eq!(p.rate, 200);
        for (i, want) in colors.iter().enumerate() {
            assert_eq!(&p.rgb[i], want, "entry {i} survived chunking");
        }
    }

    /// The two targets are independent — the underglow's list must not land on
    /// top of the keys'.
    #[test]
    fn palette_targets_do_not_collide() {
        let mut hid = MockHid::new();
        hid.set_palette(kf::PALETTE_TARGET_KEYS, &Palette { colors: vec![[1, 2, 3]], rate: 10 })
            .unwrap();
        hid.set_palette(
            kf::PALETTE_TARGET_UNDERGLOW,
            &Palette { colors: vec![[9, 8, 7], [6, 5, 4]], rate: 20 },
        )
        .unwrap();

        assert_eq!(hid.board.palettes[0].len, 1);
        assert_eq!(hid.board.palettes[0].rgb[0], [1, 2, 3]);
        assert_eq!(hid.board.palettes[0].rate, 10);
        assert_eq!(hid.board.palettes[1].len, 2);
        assert_eq!(hid.board.palettes[1].rgb[1], [6, 5, 4]);
        assert_eq!(hid.board.palettes[1].rate, 20);
    }

    /// An empty palette is how the app says "stop cycling", so it must clear
    /// the length rather than being ignored as a no-op.
    #[test]
    fn empty_palette_clears_cycling() {
        let mut hid = MockHid::new();
        hid.set_palette(kf::PALETTE_TARGET_KEYS, &Palette { colors: vec![[1, 2, 3]], rate: 10 })
            .unwrap();
        assert_eq!(hid.board.palettes[0].len, 1);

        hid.set_palette(kf::PALETTE_TARGET_KEYS, &Palette { colors: vec![], rate: 10 })
            .unwrap();
        assert_eq!(hid.board.palettes[0].len, 0);
    }

    /// The board gets the macro title AND the keycode, and decides between
    /// them itself. Worth pinning that each lands in its own slot, that a long
    /// name is clipped rather than overrunning the frame, and that non-ASCII is
    /// dropped: the board's 5x7 font covers 32..126 and renders a star as '?'.
    #[test]
    fn key_text_reaches_the_board_as_two_fields() {
        let mut hid = MockHid::new();
        let info = |m: &str, kc: &str| crate::model::KeyInfo {
            macro_title: m.into(),
            keycode: kc.into(),
        };
        let cfg = OledConfig {
            layers: Vec::new(),
            screens: Vec::new(),
            countdown: (0, 0, 0),
            pomodoro: PomodoroConfig::default(),
            sleep_mask: 0,
            sleep_timeout_s: 60,
            event_keys: Vec::new(),
            screen_leds: Vec::new(),
            key_icons: Vec::new(),
            font_scale: 0,
            key_info: vec![
                info("Open terminal", "ENTER"),
                info("", "F5"),
                info("\u{2605} starred", "A"),
                info("a-very-long-macro-name-here", "B"),
            ],
        };
        hid.push_oled(&cfg).unwrap();

        let k = |i: usize| hid.board.key_info[i].clone();
        assert_eq!(
            k(0),
            ["Open terminal".to_string(), "ENTER".into()],
            "both go over; which one shows is the board's decision, not the app's"
        );
        assert_eq!(k(1)[kf::KEY_INFO_MACRO as usize], "");
        assert_eq!(k(1)[kf::KEY_INFO_KEYCODE as usize], "F5");
        assert_eq!(
            k(2)[kf::KEY_INFO_MACRO as usize],
            " starred",
            "the star's bytes are dropped, the rest of the title survives"
        );
        assert_eq!(
            k(3)[kf::KEY_INFO_MACRO as usize].len(),
            kf::KEY_LABEL_MAX,
            "clipped to what the panel and the frame can hold"
        );
        assert_eq!(k(4), ["".to_string(), "".into()], "untouched keys stay empty");
    }

    /// The icon mask reaches the board whole, and a key with no icon is told so
    /// explicitly — otherwise removing an icon in the app would leave the old
    /// one on the panel forever.
    #[test]
    fn icon_masks_reach_the_board_and_clears_are_sent() {
        let mut hid = MockHid::new();
        // A recognisable pattern rather than a uniform fill, so a chunk landing
        // at the wrong offset actually fails the test.
        let mask: Vec<u8> = (0..kf::KEY_ICON_BYTES).map(|i| (i * 7) as u8).collect();
        let cfg = OledConfig {
            layers: Vec::new(),
            screens: Vec::new(),
            countdown: (0, 0, 0),
            pomodoro: PomodoroConfig::default(),
            sleep_mask: 0,
            sleep_timeout_s: 60,
            event_keys: Vec::new(),
            screen_leds: Vec::new(),
            key_info: Vec::new(),
            key_icons: vec![Some(mask.clone()), None],
            font_scale: 0,
        };
        hid.push_oled(&cfg).unwrap();

        assert_eq!(
            hid.board.key_icons[0].expect("key 0 has an icon").as_slice(),
            mask.as_slice(),
            "all 128 bytes, in order, across every chunk"
        );
        assert!(hid.board.key_icons[1].is_none(), "key 1 has no icon");

        // Now clear key 0 the way the app does when the user removes the icon.
        let cleared = OledConfig { key_icons: vec![None], ..cfg };
        hid.push_oled(&cleared).unwrap();
        assert!(
            hid.board.key_icons[0].is_none(),
            "a removed icon is actively cleared, not just left unsent"
        );
    }

    /// The font picker has to actually reach the board.
    ///
    /// It used to change the app's preview and nothing else: the firmware drew
    /// every title at a hardcoded scale 2. Also pins that a payload with no
    /// font_scale leaves the board alone rather than snapping it to a default,
    /// which is what an older app's payload looks like.
    #[test]
    fn font_scale_reaches_the_board() {
        let mut hid = MockHid::new();
        let base = OledConfig {
            layers: Vec::new(),
            screens: Vec::new(),
            countdown: (0, 0, 0),
            pomodoro: PomodoroConfig::default(),
            sleep_mask: 0,
            sleep_timeout_s: 60,
            event_keys: Vec::new(),
            screen_leds: Vec::new(),
            key_info: Vec::new(),
            key_icons: Vec::new(),
            font_scale: 0,
        };
        assert_eq!(hid.board.font_scale, 2, "the firmware's own default");

        hid.push_oled(&OledConfig { font_scale: 4, ..base.clone() }).unwrap();
        assert_eq!(hid.board.font_scale, 4, "XL reaches the panel");

        hid.push_oled(&base).unwrap();
        assert_eq!(
            hid.board.font_scale, 4,
            "a payload with no font_scale leaves the board on what it had"
        );

        // Out of range is clamped on the way out, never sent as-is.
        let f = kf::oled_set_font_frame(9);
        assert_eq!(f[2], kf::FONT_SCALE_MAX);
    }

    /// Every screen gets its own LED profile on the board.
    ///
    /// The app has always had per-screen profiles, but the board held exactly
    /// one — so an animation set on the first layer ran on every screen the
    /// moment you rotated away from it, which is the reported bug. Pins that
    /// each slot lands separately and that slots the app never sent stay
    /// untouched, since those are the ones the board leaves on its global state.
    #[test]
    fn each_screen_gets_its_own_led_profile() {
        use crate::model::ScreenLeds;
        let mut hid = MockHid::new();
        let profile = |slot: u8, anim: &str, key0: [u8; 3], ug: &str| ScreenLeds {
            slot,
            leds: LedState {
                keys: vec![key0; kf::KEY_COUNT],
                underglow: vec![[255, 255, 255]; 4],
                brightness: 255,
            },
            anim: AnimState { name: anim.into(), speed: 200, color: [255, 0, 0] },
            underglow: UnderglowAnim { name: ug.into(), speed: 90, intensity: 120 },
        };
        let cfg = OledConfig {
            layers: Vec::new(),
            screens: Vec::new(),
            countdown: (0, 0, 0),
            pomodoro: PomodoroConfig::default(),
            sleep_mask: 0,
            sleep_timeout_s: 60,
            event_keys: Vec::new(),
            key_info: Vec::new(),
            key_icons: Vec::new(),
            font_scale: 0,
            screen_leds: vec![
                profile(0, "breathe", [255, 0, 0], "wave"),
                profile(4, "solid", [255, 255, 255], "solid"),
            ],
        };
        hid.push_oled(&cfg).unwrap();

        let s0 = hid.board.screen_leds[0].as_ref().expect("layer screen 0 configured");
        assert_eq!(s0.anim, kf::ANIM_BREATHE);
        assert_eq!(s0.anim_speed, 200);
        assert_eq!(s0.rgb[0], [255, 0, 0]);
        assert_eq!(s0.ug_anim, kf::ANIM_WAVE, "underglow is its own animation");
        assert_eq!(s0.ug_intensity, 120);

        let s4 = hid.board.screen_leds[4].as_ref().expect("first custom screen configured");
        assert_eq!(s4.anim, kf::ANIM_SOLID, "a different screen keeps a different anim");
        assert_eq!(s4.rgb[0], [255, 255, 255]);
        assert_eq!(s4.rgb[kf::KEY_COUNT], [255, 255, 255], "underglow slot 21 too");

        assert!(
            hid.board.screen_leds[1].is_none(),
            "a slot the app never sent is left alone, so an unconfigured board \
             behaves exactly as it did before this command existed"
        );
    }

    /// A board that predates SET_KEY_INFO must not fail the whole save: the app
    /// falls back to the single-string command such firmware does understand.
    #[test]
    fn old_firmware_falls_back_to_the_single_label() {
        let mut hid = MockHid::new();
        hid.board.reject_key_info = true;
        let cfg = OledConfig {
            layers: Vec::new(),
            screens: Vec::new(),
            countdown: (0, 0, 0),
            pomodoro: PomodoroConfig::default(),
            sleep_mask: 0,
            sleep_timeout_s: 60,
            event_keys: Vec::new(),
            screen_leds: Vec::new(),
            key_icons: Vec::new(),
            font_scale: 0,
            key_info: vec![
                crate::model::KeyInfo {
                    macro_title: "Open terminal".into(),
                    keycode: "ENTER".into(),
                },
                crate::model::KeyInfo {
                    macro_title: "".into(),
                    keycode: "F5".into(),
                },
            ],
        };
        hid.push_oled(&cfg).expect("an old board is not a failed save");
        assert_eq!(
            hid.board.key_info[0][kf::KEY_INFO_MACRO as usize],
            "Open terminal",
            "the macro names the key when it has one"
        );
        assert_eq!(
            hid.board.key_info[1][kf::KEY_INFO_MACRO as usize],
            "F5",
            "otherwise the keycode does"
        );
    }

    /// Event keys are what make a screen's actions reachable on hardware with
    /// no encoder push, so "did they land" is worth pinning.
    #[test]
    fn event_keys_reach_the_board() {
        let mut hid = MockHid::new();
        assert_eq!(hid.board.event_keys[0][0], kf::EVENT_KEY_NONE, "unbound until told");

        let cfg = OledConfig {
            layers: Vec::new(),
            screens: Vec::new(),
            countdown: (0, 0, 0),
            pomodoro: PomodoroConfig::default(),
            sleep_mask: 0,
            sleep_timeout_s: 60,
            // Present Keys on layer screen 0 -> key 5; pomodoro start on the
            // first custom screen -> key 11.
            event_keys: vec![(0, 0, 5), (4, 8, 11)],
            key_info: Vec::new(),
            key_icons: Vec::new(),
            font_scale: 0,
            screen_leds: Vec::new(),
        };
        hid.push_oled(&cfg).unwrap();
        assert_eq!(hid.board.event_keys[0][0], 5);
        assert_eq!(hid.board.event_keys[4][8], 11);
        // Nothing else was touched.
        assert_eq!(hid.board.event_keys[0][1], kf::EVENT_KEY_NONE);
    }

    /// Sleep is opt-in per screen, so an unconfigured board must never blank
    /// itself. The mask is over the nav-index space, NOT the app's screen list.
    #[test]
    fn sleep_mask_reaches_the_board_and_defaults_to_never() {
        let mut hid = MockHid::new();
        assert_eq!(hid.board.sleep_mask, 0, "nothing sleeps until asked");
        assert_eq!(hid.board.sleep_timeout_s, 60);

        // Layer screen 2 (bit 2) and the first custom screen (bit 4).
        let cfg = OledConfig {
            layers: Vec::new(),
            screens: Vec::new(),
            countdown: (0, 0, 0),
            pomodoro: PomodoroConfig::default(),
            sleep_mask: (1 << 2) | (1 << 4),
            sleep_timeout_s: 90,
            event_keys: Vec::new(),
            key_info: Vec::new(),
            key_icons: Vec::new(),
            font_scale: 0,
            screen_leds: Vec::new(),
        };
        hid.push_oled(&cfg).unwrap();
        assert_eq!(hid.board.sleep_mask, 0b0001_0100);
        assert_eq!(hid.board.sleep_timeout_s, 90);
    }

    /// 0 is the protocol's "keep the current timeout", so a host can change
    /// which screens sleep without restating how long.
    #[test]
    fn sleep_timeout_zero_keeps_the_current_value() {
        let mut hid = MockHid::new();
        hid.transceive(&kf::oled_set_sleep_frame(45, 0xFF)).unwrap();
        assert_eq!(hid.board.sleep_timeout_s, 45);

        hid.transceive(&kf::oled_set_sleep_frame(0, 0x01)).unwrap();
        assert_eq!(hid.board.sleep_timeout_s, 45, "timeout untouched");
        assert_eq!(hid.board.sleep_mask, 0x01, "mask still applied");
    }

    /// The heartbeat has to put a frame ON THE WIRE — that is its whole job.
    /// The firmware's app-link dot goes red 8 s after the last frame, so a
    /// heartbeat that short-circuits on a cached flag would look fine here and
    /// still leave the board reporting the app as absent.
    #[test]
    fn heartbeat_sends_a_frame_and_reports_the_answer() {
        let mut hid = MockHid::new();
        assert!(hid.heartbeat(), "mock answers, so the board counts as alive");

        // Same frame PING uses, so the firmware's kf_hid_handle() refreshes its
        // last-seen timestamp exactly as a real ping would.
        let resp = hid.transceive(&kf::ping_frame()).unwrap();
        assert_eq!(resp[0], kf::KF_MAGIC);
        assert_eq!(resp[1], kf::CMD_PING);
    }

    /// A dark board must read as dead rather than panicking or hanging — this
    /// runs every 3 s, and `board_status` turns it straight into the UI's dot.
    #[test]
    fn heartbeat_is_false_when_no_board_answers() {
        let (host_cmd_tx, _host_cmd_rx) = channel::<u8>();
        let (conn_tx, _conn_rx) = channel::<bool>();
        let mut real = RealHid::start(host_cmd_tx, conn_tx);

        assert!(!real.is_connected(), "no hardware in a unit test");
        assert!(!real.heartbeat());
    }

    #[test]
    fn mock_pushes_oled_and_commits() {
        let mut hid = MockHid::new();
        let cfg = OledConfig {
            layers: vec![crate::model::OledLayer { name: "GIT".into(), show_title: true }],
            screens: vec![crate::model::OledScreen {
                kind: "custom".into(),
                title: "Hi".into(),
                body: "world".into(),
            }],
            countdown: (0, 5, 0),
            pomodoro: PomodoroConfig::default(),
            sleep_mask: 0,
            sleep_timeout_s: 60,
            event_keys: Vec::new(),
            key_info: Vec::new(),
            key_icons: Vec::new(),
            font_scale: 0,
            screen_leds: Vec::new(),
        };
        assert!(hid.push_oled(&cfg).is_ok());
        assert!(hid.eeprom_commit().is_ok());
    }
}
