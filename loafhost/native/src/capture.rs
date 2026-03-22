use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Clone)]
pub struct CapturedFrame {
  pub width: u32,
  pub height: u32,
  pub timestamp_us: u64,
  pub bgra: Vec<u8>,
}

pub struct DesktopCapture {
  width: u32,
  height: u32,
  frame_period: Duration,
  next_frame_deadline: Instant,
  sequence: u64,
}

impl DesktopCapture {
  pub fn new(width: u32, height: u32, fps: u32) -> Result<Self, String> {
    if width == 0 || height == 0 {
      return Err(String::from("capture dimensions must be non-zero"));
    }

    if fps == 0 {
      return Err(String::from("fps must be non-zero"));
    }

    Ok(Self {
      width,
      height,
      frame_period: Duration::from_micros((1_000_000_u64 / fps as u64).max(1)),
      next_frame_deadline: Instant::now(),
      sequence: 0,
    })
  }

  pub fn reconfigure(&mut self, width: u32, height: u32, fps: u32) {
    self.width = width.max(1);
    self.height = height.max(1);
    self.frame_period = Duration::from_micros((1_000_000_u64 / fps.max(1) as u64).max(1));
  }

  pub fn acquire_next_frame(&mut self) -> Result<CapturedFrame, String> {
    let now = Instant::now();
    if now < self.next_frame_deadline {
      std::thread::sleep(self.next_frame_deadline - now);
    }

    self.next_frame_deadline = Instant::now() + self.frame_period;

    // The Linux development container cannot access Windows DXGI.
    // For local development we generate deterministic synthetic frames while keeping
    // timing and memory layout equivalent to BGRA output from Desktop Duplication.
    let frame = self.synthetic_frame();
    self.sequence = self.sequence.wrapping_add(1);
    Ok(frame)
  }

  fn synthetic_frame(&self) -> CapturedFrame {
    let pixel_count = (self.width as usize) * (self.height as usize);
    let mut bgra = vec![0_u8; pixel_count * 4];

    for y in 0..self.height {
      for x in 0..self.width {
        let idx = ((y * self.width + x) as usize) * 4;
        let t = (self.sequence & 0xFF) as u8;
        bgra[idx] = x.wrapping_add(t as u32) as u8;
        bgra[idx + 1] = y.wrapping_add((t / 2) as u32) as u8;
        bgra[idx + 2] = (x ^ y) as u8;
        bgra[idx + 3] = 255;
      }
    }

    CapturedFrame {
      width: self.width,
      height: self.height,
      timestamp_us: now_timestamp_us(),
      bgra,
    }
  }
}

fn now_timestamp_us() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|value| value.as_micros() as u64)
    .unwrap_or(0)
}
