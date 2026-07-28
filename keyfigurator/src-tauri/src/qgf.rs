//! QGF encoder — turns a PNG/GIF/JPEG into the one container the board can read.
//!
//! The RP2040 has no image decoder. Quantum Painter's `qp_load_image_mem` +
//! `qp_animate` consume **QGF** (Quantum Graphics File) and nothing else, so the
//! conversion has to happen host-side. This module is the counterpart to QMK's
//! `qmk painter-convert-graphics`, reimplemented here because the app cannot
//! shell out to a Python toolchain the user may not have.
//!
//! Format choices, and why:
//! - **PALETTE_4BPP** (16 colours). 4bpp is what makes a full-screen 128×128
//!   animation fit at all: 8 KB per frame against 16 KB for 8bpp, and a 48-byte
//!   palette against 768 bytes — and QGF repeats the palette in *every* frame.
//! - **IMAGE_UNCOMPRESSED**. QGF's RLE would shrink the upload, but the upload
//!   is one-time and the board has the RAM. Not worth the encoder complexity or
//!   the risk of a subtle mismatch with the firmware decoder.
//! - **One shared palette across all frames**, quantised over every frame at
//!   once. QGF stores a palette per frame, but generating them independently
//!   makes flat colours shimmer between frames.
//!
//! Wire format reference: `quantum/painter/qgf.h` in the firmware, and the
//! packing rules in `lib/python/qmk/painter.py::convert_image_bytes`.

use color_quant::NeuQuant;
use image::codecs::gif::GifDecoder;
use image::{AnimationDecoder, DynamicImage, RgbaImage};
use std::io::Cursor;

/// QGF block type ids (`qgf.h`).
const BLOCK_GRAPHICS_DESCRIPTOR: u8 = 0x00;
const BLOCK_FRAME_OFFSETS: u8 = 0x01;
const BLOCK_FRAME_DESCRIPTOR: u8 = 0x02;
const BLOCK_FRAME_PALETTE: u8 = 0x03;
const BLOCK_FRAME_DATA: u8 = 0x05;

/// `qp_image_format_t::PALETTE_4BPP`.
const FORMAT_PALETTE_4BPP: u8 = 0x06;
/// `painter_compression_t::IMAGE_UNCOMPRESSED`.
const COMPRESSION_NONE: u8 = 0x00;

const PALETTE_COLORS: usize = 16;
const BITS_PER_PIXEL: usize = 4;
const PIXELS_PER_BYTE: usize = 8 / BITS_PER_PIXEL;

/// Block header is `type_id, neg_type_id, length:24` = 5 bytes.
const BLOCK_HEADER_LEN: usize = 5;
const GRAPHICS_DESCRIPTOR_LEN: usize = BLOCK_HEADER_LEN + 18;
const FRAME_DESCRIPTOR_LEN: usize = BLOCK_HEADER_LEN + 6;

/// Frame delay floor. A GIF claiming 0 ms would peg the board's deferred
/// executor; browsers clamp these too.
const MIN_FRAME_DELAY_MS: u16 = 20;
const DEFAULT_FRAME_DELAY_MS: u16 = 100;

#[derive(Debug, thiserror::Error)]
pub enum QgfError {
    #[error("not a data URL")]
    NotDataUrl,
    #[error("base64 decode failed: {0}")]
    Base64(String),
    #[error("image decode failed: {0}")]
    Decode(String),
    #[error("image has no frames")]
    NoFrames,
    #[error("encoded image is {size} bytes, over the board's {budget} byte budget")]
    TooLarge { size: usize, budget: usize },
}

#[derive(Debug)]
pub struct QgfImage {
    pub bytes: Vec<u8>,
    pub width: u16,
    pub height: u16,
    pub frames: u16,
}

/// Decode a `data:image/...;base64,...` URL — the shape the frontend's file
/// input produces — and encode it as QGF.
pub fn encode_data_url(
    data_url: &str,
    max_dim: u32,
    max_frames: usize,
    budget: usize,
) -> Result<QgfImage, QgfError> {
    use base64::Engine;
    let comma = data_url.find(',').ok_or(QgfError::NotDataUrl)?;
    if !data_url[..comma].starts_with("data:") {
        return Err(QgfError::NotDataUrl);
    }
    let raw = base64::engine::general_purpose::STANDARD
        .decode(data_url[comma + 1..].trim())
        .map_err(|e| QgfError::Base64(e.to_string()))?;
    encode_bytes(&raw, max_dim, max_frames, budget)
}

/// Encode raw image file bytes (PNG/JPEG/GIF) as QGF.
pub fn encode_bytes(
    raw: &[u8],
    max_dim: u32,
    max_frames: usize,
    budget: usize,
) -> Result<QgfImage, QgfError> {
    let frames = decode_frames(raw, max_frames)?;
    let frames = resize_frames(frames, max_dim);
    encode_frames(&frames, budget)
}

struct Frame {
    image: RgbaImage,
    delay_ms: u16,
}

/// Decode to a frame list. GIFs go through the animation decoder so we get real
/// per-frame delays; everything else is a single frame.
fn decode_frames(raw: &[u8], max_frames: usize) -> Result<Vec<Frame>, QgfError> {
    let is_gif = raw.len() >= 3 && &raw[..3] == b"GIF";
    if is_gif {
        let decoder =
            GifDecoder::new(Cursor::new(raw)).map_err(|e| QgfError::Decode(e.to_string()))?;
        let collected = decoder
            .into_frames()
            .collect_frames()
            .map_err(|e| QgfError::Decode(e.to_string()))?;
        if collected.is_empty() {
            return Err(QgfError::NoFrames);
        }
        let all: Vec<Frame> = collected
            .into_iter()
            .map(|f| {
                let (num, den) = f.delay().numer_denom_ms();
                let ms = if den == 0 { DEFAULT_FRAME_DELAY_MS as u32 } else { num / den.max(1) };
                Frame {
                    delay_ms: (ms as u16).max(MIN_FRAME_DELAY_MS),
                    image: f.into_buffer(),
                }
            })
            .collect();
        Ok(sample_frames(all, max_frames))
    } else {
        let img = image::load_from_memory(raw).map_err(|e| QgfError::Decode(e.to_string()))?;
        Ok(vec![Frame {
            image: img.to_rgba8(),
            delay_ms: DEFAULT_FRAME_DELAY_MS,
        }])
    }
}

/// Drop frames evenly rather than truncating, so a long GIF still plays the
/// whole loop — just coarser. Delays are scaled so total duration is preserved.
fn sample_frames(frames: Vec<Frame>, max_frames: usize) -> Vec<Frame> {
    if frames.len() <= max_frames || max_frames == 0 {
        return frames;
    }
    let total = frames.len();
    let step = total as f64 / max_frames as f64;
    (0..max_frames)
        .map(|i| {
            let start = (i as f64 * step).round() as usize;
            let end = (((i + 1) as f64) * step).round() as usize;
            let src = &frames[start.min(total - 1)];
            // Absorb the delay of every frame this one stands in for.
            let merged: u32 = frames[start.min(total - 1)..end.min(total)]
                .iter()
                .map(|f| f.delay_ms as u32)
                .sum();
            Frame {
                image: src.image.clone(),
                delay_ms: merged.clamp(MIN_FRAME_DELAY_MS as u32, u16::MAX as u32) as u16,
            }
        })
        .collect()
}

/// Scale down to fit `max_dim` on the long edge, preserving aspect ratio. Images
/// already within budget are left alone — upscaling would only waste bytes.
fn resize_frames(frames: Vec<Frame>, max_dim: u32) -> Vec<Frame> {
    let (w, h) = match frames.first() {
        Some(f) => (f.image.width(), f.image.height()),
        None => return frames,
    };
    if w <= max_dim && h <= max_dim {
        return frames;
    }
    let scale = (max_dim as f64 / w as f64).min(max_dim as f64 / h as f64);
    let nw = ((w as f64 * scale).round() as u32).max(1);
    let nh = ((h as f64 * scale).round() as u32).max(1);
    frames
        .into_iter()
        .map(|f| Frame {
            image: DynamicImage::ImageRgba8(f.image)
                .resize_exact(nw, nh, image::imageops::FilterType::Lanczos3)
                .to_rgba8(),
            delay_ms: f.delay_ms,
        })
        .collect()
}

/// Build one 16-colour palette across every frame, so flat colours don't shimmer
/// between frames the way independent per-frame quantisation makes them.
fn build_palette(frames: &[Frame]) -> NeuQuant {
    let mut all: Vec<u8> = Vec::new();
    for f in frames {
        all.extend_from_slice(f.image.as_raw());
    }
    // sample_fac 10 trades a little accuracy for speed; NeuQuant's usable range
    // is 1 (best) to 30 (fastest).
    NeuQuant::new(10, PALETTE_COLORS, &all)
}

fn encode_frames(frames: &[Frame], budget: usize) -> Result<QgfImage, QgfError> {
    let first = frames.first().ok_or(QgfError::NoFrames)?;
    let (width, height) = (first.image.width(), first.image.height());
    let nq = build_palette(frames);

    // QGF palette entries are QMK HSV, not RGB (see qgf_palette_entry_v1_t).
    let rgb_palette = nq.color_map_rgb();
    let mut palette_hsv = Vec::with_capacity(PALETTE_COLORS * 3);
    for i in 0..PALETTE_COLORS {
        let (r, g, b) = (
            *rgb_palette.get(i * 3).unwrap_or(&0),
            *rgb_palette.get(i * 3 + 1).unwrap_or(&0),
            *rgb_palette.get(i * 3 + 2).unwrap_or(&0),
        );
        let (h, s, v) = crate::model::rgb_to_hsv([r, g, b]);
        palette_hsv.extend_from_slice(&[h, s, v]);
    }

    // Build each frame's blob first — the graphics descriptor needs the total
    // size and the offsets table needs each frame's position, neither of which
    // is known until the frames are laid out.
    let mut frame_blobs: Vec<Vec<u8>> = Vec::with_capacity(frames.len());
    for f in frames {
        let pixels = pack_4bpp(&f.image, &nq);
        let mut blob = Vec::with_capacity(FRAME_DESCRIPTOR_LEN + BLOCK_HEADER_LEN * 2 + 48 + pixels.len());

        push_block_header(&mut blob, BLOCK_FRAME_DESCRIPTOR, 6);
        blob.push(FORMAT_PALETTE_4BPP);
        blob.push(0x00); // flags: no delta, no transparency
        blob.push(COMPRESSION_NONE);
        blob.push(0x00); // transparency index (unused)
        blob.extend_from_slice(&f.delay_ms.to_le_bytes());

        push_block_header(&mut blob, BLOCK_FRAME_PALETTE, palette_hsv.len() as u32);
        blob.extend_from_slice(&palette_hsv);

        push_block_header(&mut blob, BLOCK_FRAME_DATA, pixels.len() as u32);
        blob.extend_from_slice(&pixels);

        frame_blobs.push(blob);
    }

    let offsets_block_len = BLOCK_HEADER_LEN + 4 * frames.len();
    let frames_start = GRAPHICS_DESCRIPTOR_LEN + offsets_block_len;
    let total: usize = frames_start + frame_blobs.iter().map(|b| b.len()).sum::<usize>();
    if total > budget {
        return Err(QgfError::TooLarge { size: total, budget });
    }

    let mut out = Vec::with_capacity(total);

    // Graphics descriptor
    push_block_header(&mut out, BLOCK_GRAPHICS_DESCRIPTOR, 18);
    out.extend_from_slice(&[0x51, 0x47, 0x46]); // magic 0x464751, "QGF" little-endian
    out.push(0x01); // qgf_version
    out.extend_from_slice(&(total as u32).to_le_bytes());
    out.extend_from_slice(&(!(total as u32)).to_le_bytes());
    out.extend_from_slice(&(width as u16).to_le_bytes());
    out.extend_from_slice(&(height as u16).to_le_bytes());
    out.extend_from_slice(&(frames.len() as u16).to_le_bytes());

    // Frame offsets, absolute from file start.
    push_block_header(&mut out, BLOCK_FRAME_OFFSETS, (4 * frames.len()) as u32);
    let mut cursor = frames_start;
    for blob in &frame_blobs {
        out.extend_from_slice(&(cursor as u32).to_le_bytes());
        cursor += blob.len();
    }

    for blob in &frame_blobs {
        out.extend_from_slice(blob);
    }

    debug_assert_eq!(out.len(), total, "QGF size must match the declared total");

    Ok(QgfImage {
        bytes: out,
        width: width as u16,
        height: height as u16,
        frames: frames.len() as u16,
    })
}

fn push_block_header(out: &mut Vec<u8>, type_id: u8, length: u32) {
    out.push(type_id);
    out.push(!type_id);
    out.extend_from_slice(&length.to_le_bytes()[..3]); // 24-bit length
}

/// Pack palette indices two-per-byte. Per QMK's `convert_image_bytes`, the FIRST
/// pixel occupies the LOW nibble — getting this backwards renders a recognisable
/// but horizontally scrambled image, so it is worth pinning in a test.
fn pack_4bpp(img: &RgbaImage, nq: &NeuQuant) -> Vec<u8> {
    let raw = img.as_raw();
    let pixel_count = (img.width() * img.height()) as usize;
    let mut out = vec![0u8; pixel_count.div_ceil(PIXELS_PER_BYTE)];
    for i in 0..pixel_count {
        let px = &raw[i * 4..i * 4 + 4];
        let idx = (nq.index_of(px) & (PALETTE_COLORS - 1)) as u8;
        out[i / PIXELS_PER_BYTE] |= idx << ((i % PIXELS_PER_BYTE) * BITS_PER_PIXEL);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid_png(w: u32, h: u32, rgba: [u8; 4]) -> Vec<u8> {
        let img = RgbaImage::from_pixel(w, h, image::Rgba(rgba));
        let mut buf = Vec::new();
        DynamicImage::ImageRgba8(img)
            .write_to(&mut Cursor::new(&mut buf), image::ImageFormat::Png)
            .unwrap();
        buf
    }

    fn read_u32(b: &[u8], at: usize) -> u32 {
        u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
    }
    fn read_u16(b: &[u8], at: usize) -> u16 {
        u16::from_le_bytes([b[at], b[at + 1]])
    }

    /// The header the firmware's `qgf_read_graphics_descriptor` validates before
    /// it will touch anything else. Every field here is a hard reject if wrong.
    #[test]
    fn graphics_descriptor_matches_firmware_expectations() {
        let png = solid_png(8, 4, [200, 100, 50, 255]);
        let out = encode_bytes(&png, 128, 8, 100_000).unwrap();
        let b = &out.bytes;

        assert_eq!(b[0], BLOCK_GRAPHICS_DESCRIPTOR);
        assert_eq!(b[1], !BLOCK_GRAPHICS_DESCRIPTOR);
        assert_eq!([b[2], b[3], b[4]], [18, 0, 0], "descriptor payload is 18 bytes");
        assert_eq!(&b[5..8], &[0x51, 0x47, 0x46], "magic must read 'QGF'");
        assert_eq!(b[8], 0x01, "qgf version");

        let total = read_u32(b, 9);
        let neg = read_u32(b, 13);
        assert_eq!(total as usize, b.len(), "declared size must match actual");
        assert_eq!(neg, !total, "firmware checks the negated size");

        assert_eq!(read_u16(b, 17), 8);
        assert_eq!(read_u16(b, 19), 4);
        assert_eq!(read_u16(b, 21), 1);
    }

    /// Offsets are absolute from file start; a frame descriptor must actually
    /// live at each one or the firmware walks into garbage.
    #[test]
    fn frame_offsets_point_at_real_frame_descriptors() {
        let png = solid_png(16, 16, [10, 220, 90, 255]);
        let out = encode_bytes(&png, 128, 8, 100_000).unwrap();
        let b = &out.bytes;

        let offsets_at = GRAPHICS_DESCRIPTOR_LEN;
        assert_eq!(b[offsets_at], BLOCK_FRAME_OFFSETS);
        assert_eq!(b[offsets_at + 1], !BLOCK_FRAME_OFFSETS);

        let frame0 = read_u32(b, offsets_at + BLOCK_HEADER_LEN) as usize;
        assert_eq!(b[frame0], BLOCK_FRAME_DESCRIPTOR);
        assert_eq!(b[frame0 + 1], !BLOCK_FRAME_DESCRIPTOR);
        assert_eq!(b[frame0 + BLOCK_HEADER_LEN], FORMAT_PALETTE_4BPP);
        assert_eq!(b[frame0 + BLOCK_HEADER_LEN + 2], COMPRESSION_NONE);

        // Palette block follows the frame descriptor, then the data block.
        let pal = frame0 + FRAME_DESCRIPTOR_LEN;
        assert_eq!(b[pal], BLOCK_FRAME_PALETTE);
        assert_eq!([b[pal + 2], b[pal + 3], b[pal + 4]], [48, 0, 0], "16 HSV entries");

        let data = pal + BLOCK_HEADER_LEN + 48;
        assert_eq!(b[data], BLOCK_FRAME_DATA);
        // 16x16 at 4bpp = 128 bytes
        assert_eq!([b[data + 2], b[data + 3], b[data + 4]], [128, 0, 0]);
    }

    /// Low nibble first. Backwards packing still produces a plausible-looking
    /// file, so only an explicit check catches it.
    #[test]
    fn packs_first_pixel_into_the_low_nibble() {
        let mut img = RgbaImage::new(2, 1);
        img.put_pixel(0, 0, image::Rgba([255, 0, 0, 255]));
        img.put_pixel(1, 0, image::Rgba([0, 0, 255, 255]));
        let nq = build_palette(&[Frame { image: img.clone(), delay_ms: 100 }]);

        let packed = pack_4bpp(&img, &nq);
        assert_eq!(packed.len(), 1, "two 4bpp pixels pack into one byte");
        let expect_lo = nq.index_of(&[255, 0, 0, 255]) as u8 & 0x0F;
        let expect_hi = nq.index_of(&[0, 0, 255, 255]) as u8 & 0x0F;
        assert_eq!(packed[0] & 0x0F, expect_lo, "first pixel is the LOW nibble");
        assert_eq!(packed[0] >> 4, expect_hi, "second pixel is the HIGH nibble");
    }

    #[test]
    fn odd_pixel_count_rounds_up_to_a_whole_byte() {
        let png = solid_png(3, 1, [0, 0, 0, 255]);
        let out = encode_bytes(&png, 128, 8, 100_000).unwrap();
        // 3 pixels at 4bpp = 1.5 bytes -> 2
        let offsets_at = GRAPHICS_DESCRIPTOR_LEN;
        let frame0 = read_u32(&out.bytes, offsets_at + BLOCK_HEADER_LEN) as usize;
        let data = frame0 + FRAME_DESCRIPTOR_LEN + BLOCK_HEADER_LEN + 48;
        assert_eq!(out.bytes[data + 2], 2);
    }

    #[test]
    fn oversized_images_are_scaled_down_not_rejected() {
        let png = solid_png(512, 256, [90, 90, 90, 255]);
        let out = encode_bytes(&png, 128, 8, 100_000).unwrap();
        assert!(out.width <= 128 && out.height <= 128, "got {}x{}", out.width, out.height);
        // Aspect ratio preserved: 512x256 is 2:1, so 128x64.
        assert_eq!((out.width, out.height), (128, 64));
    }

    #[test]
    fn refuses_to_exceed_the_board_budget() {
        let png = solid_png(128, 128, [1, 2, 3, 255]);
        let err = encode_bytes(&png, 128, 8, 100).unwrap_err();
        assert!(matches!(err, QgfError::TooLarge { .. }), "got {err:?}");
    }

    #[test]
    fn rejects_non_data_urls_and_bad_base64() {
        assert!(matches!(
            encode_data_url("not a url", 128, 8, 100_000).unwrap_err(),
            QgfError::NotDataUrl
        ));
        assert!(matches!(
            encode_data_url("data:image/png;base64,!!!not base64!!!", 128, 8, 100_000).unwrap_err(),
            QgfError::Base64(_)
        ));
    }

    #[test]
    fn round_trips_through_a_data_url() {
        use base64::Engine;
        let png = solid_png(8, 8, [12, 34, 56, 255]);
        let url = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&png)
        );
        let out = encode_data_url(&url, 128, 8, 100_000).unwrap();
        assert_eq!((out.width, out.height, out.frames), (8, 8, 1));
    }

    /// Frame sampling has to preserve total playback duration, otherwise a long
    /// GIF plays back at the wrong speed once trimmed to the frame cap.
    #[test]
    fn sampling_preserves_total_duration() {
        let mk = |n: usize| {
            (0..n)
                .map(|_| Frame {
                    image: RgbaImage::new(1, 1),
                    delay_ms: 100,
                })
                .collect::<Vec<_>>()
        };
        let sampled = sample_frames(mk(20), 5);
        assert_eq!(sampled.len(), 5);
        let total: u32 = sampled.iter().map(|f| f.delay_ms as u32).sum();
        assert_eq!(total, 2000, "20 frames x 100ms must still total 2s");

        // Under the cap, nothing changes.
        assert_eq!(sample_frames(mk(3), 8).len(), 3);
    }
}
