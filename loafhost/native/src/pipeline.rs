use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crossbeam_channel::{bounded, Receiver, Sender};
use parking_lot::RwLock;

use crate::capture::{CapturedFrame, DesktopCapture};
use crate::encode::{EncodedFrame, Encoder};

type PacketSender = Box<dyn Fn(&str, Vec<u8>) + Send + Sync + 'static>;
type StatsSink = Box<dyn Fn(PipelineStats) + Send + Sync + 'static>;

#[derive(Clone)]
pub struct PipelineConfig {
  pub width: u32,
  pub height: u32,
  pub fps: u32,
  pub bitrate_mbps: u32,
  pub codec: String,
}

#[derive(Clone, Copy)]
pub struct PipelineStats {
  pub fps_sent: f64,
  pub bitrate_mbps: f64,
  pub encode_ms: f64,
  pub rtt_ms: f64,
}

impl Default for PipelineStats {
  fn default() -> Self {
    Self {
      fps_sent: 0.0,
      bitrate_mbps: 0.0,
      encode_ms: 0.0,
      rtt_ms: 0.0,
    }
  }
}

struct RunningPipeline {
  stop: Arc<AtomicBool>,
  config: Arc<RwLock<PipelineConfig>>,
  force_keyframe: Arc<AtomicBool>,
  threads: Vec<JoinHandle<()>>,
}

pub struct PipelineController {
  running: Option<RunningPipeline>,
}

impl PipelineController {
  pub fn new() -> Self {
    Self { running: None }
  }

  pub fn start(
    &mut self,
    viewer_id: String,
    config: PipelineConfig,
    packet_sender: PacketSender,
    stats_sink: StatsSink,
  ) -> Result<(), String> {
    self.stop()?;

    let stop = Arc::new(AtomicBool::new(false));
    let config_lock = Arc::new(RwLock::new(config.clone()));
    let force_keyframe = Arc::new(AtomicBool::new(true));

    let (capture_tx, capture_rx) = bounded::<CapturedFrame>(3);
    let (encode_tx, encode_rx) = bounded::<EncodedFrame>(3);

    let capture_thread = spawn_capture_thread(
      stop.clone(),
      config_lock.clone(),
      capture_tx,
      capture_rx.clone(),
    )?;

    let encode_thread = spawn_encode_thread(
      stop.clone(),
      config_lock.clone(),
      force_keyframe.clone(),
      capture_rx,
      encode_tx,
      encode_rx.clone(),
    )?;

    let send_thread = spawn_send_thread(
      stop.clone(),
      viewer_id,
      encode_rx,
      packet_sender,
      stats_sink,
    );

    self.running = Some(RunningPipeline {
      stop,
      config: config_lock,
      force_keyframe,
      threads: vec![capture_thread, encode_thread, send_thread],
    });

    Ok(())
  }

  pub fn stop(&mut self) -> Result<(), String> {
    if let Some(mut running) = self.running.take() {
      running.stop.store(true, Ordering::SeqCst);
      for thread in running.threads.drain(..) {
        let _ = thread.join();
      }
    }

    Ok(())
  }

  pub fn request_keyframe(&mut self) -> Result<(), String> {
    if let Some(running) = self.running.as_ref() {
      running.force_keyframe.store(true, Ordering::SeqCst);
      return Ok(());
    }

    Err(String::from("pipeline is not running"))
  }

  pub fn update_config(&mut self, config: PipelineConfig) -> Result<(), String> {
    if let Some(running) = self.running.as_ref() {
      *running.config.write() = config;
      return Ok(());
    }

    Err(String::from("pipeline is not running"))
  }
}

fn spawn_capture_thread(
  stop: Arc<AtomicBool>,
  config: Arc<RwLock<PipelineConfig>>,
  capture_tx: Sender<CapturedFrame>,
  capture_rx_for_drop: Receiver<CapturedFrame>,
) -> Result<JoinHandle<()>, String> {
  let initial = config.read().clone();
  let mut capturer = DesktopCapture::new(initial.width, initial.height, initial.fps)?;

  Ok(thread::spawn(move || {
    while !stop.load(Ordering::Relaxed) {
      let cfg = config.read().clone();
      capturer.reconfigure(cfg.width, cfg.height, cfg.fps);

      let frame = match capturer.acquire_next_frame() {
        Ok(frame) => frame,
        Err(_) => {
          thread::sleep(Duration::from_millis(2));
          continue;
        }
      };

      push_drop_oldest(&capture_tx, &capture_rx_for_drop, frame);
    }
  }))
}

fn spawn_encode_thread(
  stop: Arc<AtomicBool>,
  config: Arc<RwLock<PipelineConfig>>,
  force_keyframe: Arc<AtomicBool>,
  capture_rx: Receiver<CapturedFrame>,
  encode_tx: Sender<EncodedFrame>,
  encode_rx_for_drop: Receiver<EncodedFrame>,
) -> Result<JoinHandle<()>, String> {
  let initial = config.read().clone();
  let mut encoder = Encoder::new(&initial.codec, initial.bitrate_mbps);

  Ok(thread::spawn(move || {
    while !stop.load(Ordering::Relaxed) {
      let frame = match capture_rx.recv_timeout(Duration::from_millis(25)) {
        Ok(frame) => frame,
        Err(_) => continue,
      };

      let cfg = config.read().clone();
      encoder.update(&cfg.codec, cfg.bitrate_mbps);

      if force_keyframe.swap(false, Ordering::SeqCst) {
        encoder.request_keyframe();
      }

      let encoded = match encoder.encode(frame) {
        Ok(frame) => frame,
        Err(_) => continue,
      };

      push_drop_oldest(&encode_tx, &encode_rx_for_drop, encoded);
    }
  }))
}

fn spawn_send_thread(
  stop: Arc<AtomicBool>,
  viewer_id: String,
  encode_rx: Receiver<EncodedFrame>,
  packet_sender: PacketSender,
  stats_sink: StatsSink,
) -> JoinHandle<()> {
  thread::spawn(move || {
    let mut frame_id: u32 = 0;
    let mut sent_frames = 0_u64;
    let mut sent_bytes = 0_u64;
    let mut encode_ms_sum = 0.0_f64;
    let mut interval_start = Instant::now();

    while !stop.load(Ordering::Relaxed) {
      let encoded = match encode_rx.recv_timeout(Duration::from_millis(25)) {
        Ok(frame) => frame,
        Err(_) => continue,
      };

      let packets = packetize_frame(frame_id, &encoded, 1150);
      for packet in packets {
        sent_bytes = sent_bytes.saturating_add(packet.len() as u64);
        packet_sender(&viewer_id, packet);
      }

      sent_frames = sent_frames.saturating_add(1);
      encode_ms_sum += encoded.encode_ms;
      frame_id = frame_id.wrapping_add(1);

      let elapsed = interval_start.elapsed();
      if elapsed >= Duration::from_secs(1) {
        let elapsed_secs = elapsed.as_secs_f64().max(0.001);
        let fps = sent_frames as f64 / elapsed_secs;
        let bitrate_mbps = (sent_bytes as f64 * 8.0 / elapsed_secs) / 1_000_000.0;
        let encode_ms = if sent_frames == 0 {
          0.0
        } else {
          encode_ms_sum / sent_frames as f64
        };

        stats_sink(PipelineStats {
          fps_sent: fps,
          bitrate_mbps,
          encode_ms,
          rtt_ms: 0.0,
        });

        sent_frames = 0;
        sent_bytes = 0;
        encode_ms_sum = 0.0;
        interval_start = Instant::now();
      }
    }
  })
}

fn push_drop_oldest<T>(tx: &Sender<T>, rx_for_drop: &Receiver<T>, value: T) {
  if tx.try_send(value).is_ok() {
    return;
  }

  let _ = rx_for_drop.try_recv();
  let _ = tx.try_send(value);
}

fn packetize_frame(frame_id: u32, frame: &EncodedFrame, max_chunk_payload: usize) -> Vec<Vec<u8>> {
  let payload = &frame.payload;
  let chunk_count = ((payload.len() + max_chunk_payload - 1) / max_chunk_payload).max(1);
  let packet_count = chunk_count.min(u8::MAX as usize);

  let mut out = Vec::with_capacity(packet_count);
  let timestamp_us_32 = (frame.timestamp_us & 0xFFFF_FFFF) as u32;

  for packet_index in 0..packet_count {
    let start = packet_index * max_chunk_payload;
    let end = ((packet_index + 1) * max_chunk_payload).min(payload.len());
    let chunk = &payload[start..end];

    let mut packet = Vec::with_capacity(14 + chunk.len());
    packet.extend_from_slice(&frame_id.to_be_bytes());
    packet.push(packet_index as u8);
    packet.push(packet_count as u8);
    packet.push(frame.frame_type);
    packet.push(frame.codec);
    packet.extend_from_slice(&timestamp_us_32.to_be_bytes());
    packet.extend_from_slice(&(chunk.len() as u16).to_be_bytes());
    packet.extend_from_slice(chunk);

    out.push(packet);
  }

  out
}
