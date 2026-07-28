//! Static product / hardware-revision database.
//!
//! Identity is three independent layers, and they matter separately:
//!
//! ```text
//!   Product   0x01  "Lunar x MacroPad"   ← which product line
//!     └─ Hardware  1.0.0              ← which PCB revision
//!          └─ Firmware  0.2.0         ← which build is running
//! ```
//!
//! A PCB respin bumps hardware without touching firmware; a firmware release
//! bumps firmware on unchanged hardware. **Capabilities belong to
//! product + hardware, never to firmware** — no firmware update can add an
//! encoder push switch that was never soldered on.
//!
//! The board reports its own identity over `GET_IDENTITY`; this table says what
//! that identity is *able to do*. The app must not assume every unit has every
//! feature, because rev 1.0.0 demonstrably does not.

use serde::{Deserialize, Serialize};

/// A three-part version. Ordered, so ranges can be expressed against it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Version {
    pub major: u8,
    pub minor: u8,
    pub patch: u8,
}

impl Version {
    pub const fn new(major: u8, minor: u8, patch: u8) -> Self {
        Self { major, minor, patch }
    }
}

impl std::fmt::Display for Version {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

/// What a given product + hardware revision physically supports.
///
/// Every field is a *hardware* fact. If something is conditional on firmware
/// version instead, it does not belong here — it belongs behind a protocol
/// version check.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Capabilities {
    /// Whether the rotary encoder has a push switch wired to the matrix.
    ///
    /// Rev 1.0.0 does NOT. The encoder rotates, but there is no push, so
    /// anything that assumed "push the encoder to confirm" is unreachable on
    /// that hardware and needs a real key standing in for it.
    pub encoder_push: bool,
    pub key_count: usize,
    pub led_count: usize,
    pub layer_count: usize,
    pub has_oled: bool,
    pub has_underglow: bool,
}

/// One row of the database: a product at a specific hardware revision.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProductSpec {
    pub product_id: u8,
    pub name: &'static str,
    pub hardware: Version,
    pub capabilities: Capabilities,
}

/// The database. Static and compiled in: it describes hardware that already
/// exists and shipped, so it is a fact table, not configuration.
pub const PRODUCTS: &[ProductSpec] = &[ProductSpec {
    product_id: 0x01,
    name: "Lunar x MacroPad",
    hardware: Version::new(1, 0, 0),
    capabilities: Capabilities {
        // Rev 1.0.0: encoder push is not present on this board.
        encoder_push: false,
        key_count: 21,
        led_count: 25,
        layer_count: 4,
        has_oled: true,
        has_underglow: true,
    },
}];

/// Look up an exact product + hardware match.
pub fn lookup(product_id: u8, hardware: Version) -> Option<&'static ProductSpec> {
    PRODUCTS
        .iter()
        .find(|p| p.product_id == product_id && p.hardware == hardware)
}

/// Best-effort lookup for a board whose exact revision is not in the table.
///
/// Falls back to the highest known revision of the same product, so a board
/// newer than this build of the app still gets sensible capabilities rather
/// than nothing. Returns `None` for an entirely unknown product, where guessing
/// would be worse than admitting ignorance.
pub fn lookup_or_nearest(product_id: u8, hardware: Version) -> Option<&'static ProductSpec> {
    lookup(product_id, hardware).or_else(|| {
        PRODUCTS
            .iter()
            .filter(|p| p.product_id == product_id)
            .max_by_key(|p| p.hardware)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tested_board_is_in_the_table() {
        let spec = lookup(0x01, Version::new(1, 0, 0)).expect("product 0x01 hw 1.0.0");
        assert_eq!(spec.name, "Lunar x MacroPad");
        assert_eq!(spec.capabilities.key_count, 21);
    }

    /// The whole reason the capability table exists: rev 1.0.0 has no encoder
    /// push, so the app must not offer it, and something else has to stand in.
    #[test]
    fn rev_1_0_0_has_no_encoder_push_and_names_a_stand_in() {
        let spec = lookup(0x01, Version::new(1, 0, 0)).unwrap();
        assert!(
            !spec.capabilities.encoder_push,
            "rev 1.0.0 has no push switch soldered; screens expose their actions              as assignable OLED events instead"
        );
    }

    #[test]
    fn unknown_revision_falls_back_to_the_newest_known_one() {
        // A board from the future: same product, unknown revision.
        let spec = lookup_or_nearest(0x01, Version::new(9, 9, 9)).unwrap();
        assert_eq!(spec.product_id, 0x01);
        // An unknown *product* is not guessable, so it must not resolve.
        assert!(lookup_or_nearest(0xEE, Version::new(1, 0, 0)).is_none());
    }

    #[test]
    fn versions_order_and_render() {
        assert!(Version::new(1, 0, 0) < Version::new(1, 0, 1));
        assert!(Version::new(1, 2, 0) < Version::new(2, 0, 0));
        assert_eq!(Version::new(1, 0, 0).to_string(), "1.0.0");
    }
}
