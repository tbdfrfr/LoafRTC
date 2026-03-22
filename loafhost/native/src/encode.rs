use std::time::{Duration, Instant};

use crate::capture::CapturedFrame;

#[derive(Clone)]
pub struct EncodedFrame {
  pub timestamp_us: u64,
  pub frame_type: u8,
  pub codec: u8,
  pub payload: Vec<u8>,
  pub encode_ms: f64,
}

#[derive(Clone, Copy)]
enum CodecKind {
  H264,
  H265,
  Av1,
}

impl CodecKind {
  fn id(self) -> u8 {
    match self {
      CodecKind::H264 => 0,
      CodecKind::H265 => 1,
      CodecKind::Av1 => 2,
    }
  }
}

pub struct Encoder {
  codec: CodecKind,
  bitrate_mbps: u32,
  frame_counter: u64,
  force_next_keyframe: bool,
}

impl Encoder {
  pub fn new(codec: &str, bitrate_mbps: u32) -> Self {
    Self {
      codec: choose_codec(codec),
      bitrate_mbps: bitrate_mbps.max(1),
      frame_counter: 0,
      force_next_keyframe: true,
    }
  }

  pub fn update(&mut self, codec: &str, bitrate_mbps: u32) {
    self.codec = choose_codec(codec);
    self.bitrate_mbps = bitrate_mbps.max(1);
  }

  pub fn request_keyframe(&mut self) {
    self.force_next_keyframe = true;
  }

  pub fn encode(&mut self, frame: CapturedFrame) -> Result<EncodedFrame, String> {
    let started = Instant::now();

    // Production builds should swap this section with hardware encoders:
    // NVENC -> AMF -> MFT fallback. The payload produced here keeps a deterministic
    // binary format suitable for transport and integration testing.
    let is_keyframe = self.force_next_keyframe || self.frame_counter % 120 == 0;
    self.force_next_keyframe = false;

    let frame_type = if is_keyframe { 1 } else { 0 };
    let payload_budget = target_payload_budget(self.bitrate_mbps);
    let payload = build_compact_payload(&frame, payload_budget, self.frame_counter);

    self.frame_counter = self.frame_counter.wrapping_add(1);

    Ok(EncodedFrame {
      timestamp_us: frame.timestamp_us,
      frame_type,
      codec: self.codec.id(),
      payload,
      encode_ms: elapsed_ms(started.elapsed()),
    })
  }
}

fn choose_codec(raw: &str) -> CodecKind {
  match raw.trim().to_ascii_lowercase().as_str() {
    "h264" => CodecKind::H264,
    "h265" => CodecKind::H265,
    "av1" => CodecKind::Av1,
    _ => CodecKind::H264,
  }
}

fn target_payload_budget(bitrate_mbps: u32) -> usize {
  // For integration and pressure testing keep a bounded payload per frame packetization path.
  // Real encoder output size is controlled by encoder RC; this approximation keeps the send loop hot.
  let bytes = (bitrate_mbps as usize * 1024 * 1024) / 8 / 60;
  bytes.clamp(4 * 1024, 220 * 1024)
}

fn build_compact_payload(frame: &CapturedFrame, target_len: usize, frame_index: u64) -> Vec<u8> {
  let mut out = Vec::with_capacity(target_len);

  out.extend_from_slice(&frame.width.to_be_bytes());
  out.extend_from_slice(&frame.height.to_be_bytes());
  out.extend_from_slice(&frame_index.to_be_bytes());

  if frame.bgra.is_empty() {
    return out;
  }

  let mut cursor = (frame_index as usize) % frame.bgra.len();
  while out.len() < target_len {
    out.push(frame.bgra[cursor]);
    cursor += 37;
    if cursor >= frame.bgra.len() {
      cursor %= frame.bgra.len();
    }
  }

  out
}

fn elapsed_ms(duration: Duration) -> f64 {
  duration.as_secs_f64() * 1000.0
}
