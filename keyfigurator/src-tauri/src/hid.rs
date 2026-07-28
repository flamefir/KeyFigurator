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
use crate::model::{AnimState, KeyMap, Layer, LedState, OledConfig};
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
    fn push_oled(&mut self, cfg: &OledConfig) -> Result<(), HidError> {
        for (li, l) in cfg.layers.iter().enumerate().take(kf::LAYER_COUNT) {
            let resp = self.transceive(&kf::oled_set_layer_frame(li as u8, l.show_title, &l.name))?;
            expect_ok(&resp)?;
        }
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
        let (h, m, s) = cfg.countdown;
        let resp = self.transceive(&kf::oled_set_countdown_frame(h, m, s))?;
        expect_ok(&resp)
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
        assert_eq!(id.product_name, "Macro Pad Pro");
        assert_eq!(id.hardware.to_string(), "1.0.0");
        assert_eq!(id.firmware.to_string(), "0.2.0");

        let spec = products::lookup(id.product_id, id.hardware).expect("known product");
        assert!(!spec.capabilities.encoder_push, "rev 1.0.0 has no encoder push");
        assert_eq!(spec.default_special_enter, Some(5));
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
        };
        assert!(hid.push_oled(&cfg).is_ok());
        assert!(hid.eeprom_commit().is_ok());
    }
}
