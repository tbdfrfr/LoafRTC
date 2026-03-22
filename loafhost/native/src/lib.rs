#![deny(clippy::all)]

use std::collections::HashMap;
use std::sync::Arc;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{
  ErrorStrategy, ThreadSafeCallContext, ThreadsafeFunction, ThreadsafeFunctionCallMode,
};
use napi_derive::napi;
use once_cell::sync::Lazy;
use parking_lot::Mutex;

mod capture;
mod encode;
mod pipeline;

use pipeline::{PipelineController, PipelineStats};

#[napi(object)]
#[derive(Clone)]
pub struct StreamConfig {
  pub resolution: String,
  pub fps: u32,
  pub bitrate_mbps: u32,
  pub codec: String,
  pub audio_enabled: bool,
}

impl Default for StreamConfig {
  fn default() -> Self {
    Self {
      resolution: String::from("1080p"),
      fps: 60,
      bitrate_mbps: 20,
      codec: String::from("auto"),
      audio_enabled: false,
    }
  }
}

#[napi(object)]
#[derive(Clone)]
pub struct NativeStats {
  pub fps_sent: f64,
  pub bitrate_mbps: f64,
  pub encode_ms: f64,
  pub rtt_ms: f64,
}

struct SenderBridge {
  by_viewer: HashMap<String, ThreadsafeFunction<Vec<u8>, ErrorStrategy::CalleeHandled>>,
}

impl SenderBridge {
  fn new() -> Self {
    Self {
      by_viewer: HashMap::new(),
    }
  }

  fn set(&mut self, viewer_id: String, callback: ThreadsafeFunction<Vec<u8>, ErrorStrategy::CalleeHandled>) {
    self.by_viewer.insert(viewer_id, callback);
  }

  fn remove(&mut self, viewer_id: &str) {
    self.by_viewer.remove(viewer_id);
  }

  fn send(&self, viewer_id: &str, packet: Vec<u8>) {
    if let Some(cb) = self.by_viewer.get(viewer_id) {
      let _ = cb.call(Ok(packet), ThreadsafeFunctionCallMode::NonBlocking);
    }
  }
}

static SENDER_BRIDGE: Lazy<Arc<Mutex<SenderBridge>>> =
  Lazy::new(|| Arc::new(Mutex::new(SenderBridge::new())));

static STATS_CALLBACK: Lazy<Arc<Mutex<Option<ThreadsafeFunction<NativeStats, ErrorStrategy::CalleeHandled>>>>> =
  Lazy::new(|| Arc::new(Mutex::new(None)));

static CONTROLLER: Lazy<Arc<Mutex<PipelineController>>> =
  Lazy::new(|| Arc::new(Mutex::new(PipelineController::new())));

fn resolution_to_dimensions(resolution: &str) -> (u32, u32) {
  match resolution {
    "720p" => (1280, 720),
    "1080p" => (1920, 1080),
    "1440p" => (2560, 1440),
    _ => (1920, 1080),
  }
}

fn to_pipeline_stats(stats: PipelineStats) -> NativeStats {
  NativeStats {
    fps_sent: stats.fps_sent,
    bitrate_mbps: stats.bitrate_mbps,
    encode_ms: stats.encode_ms,
    rtt_ms: stats.rtt_ms,
  }
}

#[napi]
pub fn set_video_sender(viewer_id: String, callback: JsFunction) -> Result<()> {
  let tsfn: ThreadsafeFunction<Vec<u8>, ErrorStrategy::CalleeHandled> = callback
    .create_threadsafe_function(256, |ctx: ThreadSafeCallContext<Vec<u8>>| {
      let env = ctx.env;
      let data = ctx.value;
      let out = env.create_buffer_with_data(data)?;
      Ok(vec![out.into_raw()])
    })?;

  SENDER_BRIDGE.lock().set(viewer_id, tsfn);
  Ok(())
}

#[napi]
pub fn clear_video_sender(viewer_id: String) -> Result<()> {
  SENDER_BRIDGE.lock().remove(&viewer_id);
  Ok(())
}

#[napi]
pub fn set_stats_callback(callback: JsFunction) -> Result<()> {
  let tsfn: ThreadsafeFunction<NativeStats, ErrorStrategy::CalleeHandled> = callback
    .create_threadsafe_function(64, |ctx: ThreadSafeCallContext<NativeStats>| {
      let env = ctx.env;
      let stats = ctx.value;
      let mut obj = env.create_object()?;
      obj.set_named_property("fps_sent", env.create_double(stats.fps_sent)?)?;
      obj.set_named_property("bitrate_mbps", env.create_double(stats.bitrate_mbps)?)?;
      obj.set_named_property("encode_ms", env.create_double(stats.encode_ms)?)?;
      obj.set_named_property("rtt_ms", env.create_double(stats.rtt_ms)?)?;
      Ok(vec![obj])
    })?;

  *STATS_CALLBACK.lock() = Some(tsfn);
  Ok(())
}

#[napi]
pub fn start_pipeline(viewer_id: String, config: StreamConfig) -> Result<()> {
  let (width, height) = resolution_to_dimensions(&config.resolution);
  let fps = config.fps.max(1).min(240);
  let bitrate_mbps = config.bitrate_mbps.max(1).min(1000);

  let sender_bridge = SENDER_BRIDGE.clone();
  let stats_callback = STATS_CALLBACK.clone();

  let sender = move |target_viewer: &str, packet: Vec<u8>| {
    sender_bridge.lock().send(target_viewer, packet);
  };

  let stats_sink = move |stats: PipelineStats| {
    if let Some(cb) = stats_callback.lock().as_ref() {
      let payload = to_pipeline_stats(stats);
      let _ = cb.call(Ok(payload), ThreadsafeFunctionCallMode::NonBlocking);
    }
  };

  CONTROLLER
    .lock()
    .start(
      viewer_id,
      pipeline::PipelineConfig {
        width,
        height,
        fps,
        bitrate_mbps,
        codec: config.codec,
      },
      Box::new(sender),
      Box::new(stats_sink),
    )
    .map_err(|err| Error::from_reason(err.to_string()))
}

#[napi]
pub fn stop_pipeline() -> Result<()> {
  CONTROLLER
    .lock()
    .stop()
    .map_err(|err| Error::from_reason(err.to_string()))
}

#[napi]
pub fn request_keyframe() -> Result<()> {
  CONTROLLER
    .lock()
    .request_keyframe()
    .map_err(|err| Error::from_reason(err.to_string()))
}

#[napi]
pub fn update_config(config: StreamConfig) -> Result<()> {
  let (width, height) = resolution_to_dimensions(&config.resolution);

  CONTROLLER
    .lock()
    .update_config(pipeline::PipelineConfig {
      width,
      height,
      fps: config.fps.max(1).min(240),
      bitrate_mbps: config.bitrate_mbps.max(1).min(1000),
      codec: config.codec,
    })
    .map_err(|err| Error::from_reason(err.to_string()))
}
