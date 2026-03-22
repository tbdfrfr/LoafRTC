import { StreamRenderer } from './renderer.js';
import { HEADER_SIZE, parseVideoPacket } from './protocol.mjs';

const HUD_HIDE_DELAY_MS = 3000;
const PING_INTERVAL_MS = 500;
const METRICS_INTERVAL_MS = 1000;

const CODEC_MAP = {
  0: 'avc1.640028',
  1: 'hvc1.1.6.L120.B0',
  2: 'av01.0.08M.08',
};

const state = {
  ws: null,
  pc: null,
  viewerId: null,
  iceServers: [],
  roomCode: '',

  videoChannel: null,
  controlChannel: null,

  renderer: new StreamRenderer(),
  decoder: null,
  decoderCodec: null,
  waitingForKeyframe: true,

  frameBuffers: new Map(),
  lastFrameIdSeen: -1,
  consecutiveDroppedFrames: 0,

  pendingPingById: new Map(),
  pingTimer: null,
  metricsTimer: null,
  connectionProbeTimer: null,
  hudHideTimer: null,

  decodedFramesThisSecond: 0,
  payloadBytesThisSecond: 0,
  bitrateMbps: 0,
  fps: 0,
  latencySamples: [],
  latencyMs: null,
  connectionKind: '--',

  mouseSendTs: 0,
  destroyed: false,
};

const ui = {
  landing: document.getElementById('landing'),
  stream: document.getElementById('stream'),
  form: document.getElementById('connect-form'),
  roomCode: document.getElementById('room-code'),
  connectButton: document.getElementById('connect-button'),
  connectStatus: document.getElementById('connect-status'),
  spinner: document.getElementById('spinner'),
  canvas: document.getElementById('stream-canvas'),
  hud: document.getElementById('hud'),
  latency: document.getElementById('hud-latency'),
  fps: document.getElementById('hud-fps'),
  bitrate: document.getElementById('hud-bitrate'),
  connection: document.getElementById('hud-connection'),
  fullscreenButton: document.getElementById('fullscreen-button'),
  disconnectButton: document.getElementById('disconnect-button'),
};

function setStatus(text) {
  ui.connectStatus.textContent = text;
}

function setPanel(isStreaming) {
  ui.landing.classList.toggle('panel-active', !isStreaming);
  ui.stream.classList.toggle('panel-active', isStreaming);
}

function showSpinner(show) {
  ui.spinner.classList.toggle('spinner-hidden', !show);
}

function showHudTemporarily() {
  ui.hud.classList.add('hud-visible');
  if (state.hudHideTimer) {
    clearTimeout(state.hudHideTimer);
  }
  state.hudHideTimer = setTimeout(() => {
    ui.hud.classList.remove('hud-visible');
  }, HUD_HIDE_DELAY_MS);
}

function updateHud() {
  const latencyText = state.latencyMs == null ? '--' : String(Math.round(state.latencyMs));
  ui.latency.textContent = `Latency: ${latencyText} ms`;
  ui.fps.textContent = `FPS: ${state.fps.toFixed(0)}`;
  ui.bitrate.textContent = `Bitrate: ${state.bitrateMbps.toFixed(2)} Mbps`;
  ui.connection.textContent = `Connection: ${state.connectionKind}`;
}

function normalizeRoomCode(raw) {
  return String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
}

function wsUrl() {
  const configured = window.LOAFRTC_SIGNALING_URL;
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return configured.trim();
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

function sendWs(message) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    return;
  }
  state.ws.send(JSON.stringify(message));
}

function sendControl(message) {
  if (!state.controlChannel || state.controlChannel.readyState !== 'open') {
    return;
  }
  state.controlChannel.send(JSON.stringify(message));
}

function requestKeyframe(reason) {
  sendControl({
    type: 'keyframe_request',
    reason,
    ts: Date.now(),
  });
}

function clearFrameBuffers() {
  state.frameBuffers.clear();
  state.lastFrameIdSeen = -1;
  state.consecutiveDroppedFrames = 0;
}

function ensureDecoder(codecId) {
  const codec = CODEC_MAP[codecId] || CODEC_MAP[0];

  if (state.decoder && state.decoderCodec === codec && state.decoder.state !== 'closed') {
    return;
  }

  if (state.decoder && state.decoder.state !== 'closed') {
    try {
      state.decoder.close();
    } catch (_err) {
      // Ignore decoder close errors.
    }
  }

  state.waitingForKeyframe = true;
  state.decoderCodec = codec;

  state.decoder = new VideoDecoder({
    output: (videoFrame) => {
      state.decodedFramesThisSecond += 1;
      state.renderer.renderFrame(videoFrame);
      videoFrame.close();
    },
    error: () => {
      requestKeyframe('decoder_error');
      state.waitingForKeyframe = true;
      try {
        state.decoder.close();
      } catch (_err) {
        // Ignore decoder close errors.
      }
      state.decoder = null;
    },
  });

  try {
    state.decoder.configure({
      codec,
      hardwareAcceleration: 'prefer-hardware',
      optimizeForLatency: true,
    });
  } catch (_err) {
    try {
      state.decoder.configure({
        codec: CODEC_MAP[0],
        hardwareAcceleration: 'prefer-hardware',
        optimizeForLatency: true,
      });
      state.decoderCodec = CODEC_MAP[0];
    } catch (_err2) {
      state.decoder = null;
      requestKeyframe('decoder_config_failed');
    }
  }
}

function dropFrame(frameId, reason) {
  if (state.frameBuffers.has(frameId)) {
    state.frameBuffers.delete(frameId);
  }
  state.consecutiveDroppedFrames += 1;

  if (state.consecutiveDroppedFrames >= 3) {
    requestKeyframe(reason || 'drop_streak');
    state.consecutiveDroppedFrames = 0;
  }
}

function flushStaleFrames(newFrameId) {
  if (state.lastFrameIdSeen === -1 || newFrameId <= state.lastFrameIdSeen) {
    return;
  }

  const frameIds = Array.from(state.frameBuffers.keys());
  for (const frameId of frameIds) {
    if (frameId < newFrameId) {
      const entry = state.frameBuffers.get(frameId);
      if (!entry) {
        continue;
      }
      if (entry.receivedCount < entry.packetCount) {
        dropFrame(frameId, 'missing_packets');
      }
    }
  }
}

function concatChunks(chunks, totalLength) {
  const out = new Uint8Array(totalLength);
  let offset = 0;

  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    out.set(chunk, offset);
    offset += chunk.length;
  }

  return out;
}

function decodeAssembledFrame(frameId, assembled) {
  if (!assembled) {
    return;
  }

  ensureDecoder(assembled.codec);
  if (!state.decoder) {
    return;
  }

  const isKeyframe = assembled.frameType === 1;

  if (state.waitingForKeyframe && !isKeyframe) {
    dropFrame(frameId, 'awaiting_keyframe');
    return;
  }

  try {
    const encoded = new EncodedVideoChunk({
      type: isKeyframe ? 'key' : 'delta',
      timestamp: assembled.timestampUs,
      data: assembled.payload,
    });

    state.decoder.decode(encoded);
    state.waitingForKeyframe = false;
    state.consecutiveDroppedFrames = 0;
  } catch (_err) {
    dropFrame(frameId, 'decode_exception');
    requestKeyframe('decode_exception');
  }
}

function handleVideoPacket(rawData) {
  const packet = parseVideoPacket(rawData);
  if (!packet) {
    return;
  }

  state.payloadBytesThisSecond += packet.payload.length + HEADER_SIZE;

  flushStaleFrames(packet.frameId);
  if (packet.frameId > state.lastFrameIdSeen) {
    state.lastFrameIdSeen = packet.frameId;
  }

  let entry = state.frameBuffers.get(packet.frameId);
  if (!entry) {
    entry = {
      packetCount: packet.packetCount,
      receivedCount: 0,
      frameType: packet.frameType,
      codec: packet.codec,
      timestampUs: packet.timestampUs,
      chunks: new Array(packet.packetCount),
      totalLength: 0,
      createdAt: Date.now(),
    };
    state.frameBuffers.set(packet.frameId, entry);
  }

  if (entry.packetCount !== packet.packetCount) {
    dropFrame(packet.frameId, 'packet_count_mismatch');
    return;
  }

  if (!entry.chunks[packet.packetIndex]) {
    entry.chunks[packet.packetIndex] = packet.payload;
    entry.receivedCount += 1;
    entry.totalLength += packet.payload.length;
  }

  if (entry.receivedCount === entry.packetCount) {
    const payload = concatChunks(entry.chunks, entry.totalLength);
    state.frameBuffers.delete(packet.frameId);

    decodeAssembledFrame(packet.frameId, {
      frameType: entry.frameType,
      codec: entry.codec,
      timestampUs: entry.timestampUs,
      payload,
    });
  }

  const expiration = Date.now() - 1000;
  for (const [frameId, buffered] of state.frameBuffers.entries()) {
    if (buffered.createdAt < expiration) {
      dropFrame(frameId, 'frame_timeout');
    }
  }
}

function handleControlMessage(rawData) {
  let message;
  try {
    message = JSON.parse(rawData);
  } catch (_err) {
    return;
  }

  if (!message || typeof message.type !== 'string') {
    return;
  }

  if (message.type === 'ping') {
    sendControl({
      type: 'pong',
      pingId: message.pingId,
      ts: Date.now(),
    });
    return;
  }

  if (message.type === 'pong') {
    const pingId = String(message.pingId || '');
    const start = state.pendingPingById.get(pingId);
    if (start) {
      state.pendingPingById.delete(pingId);
      const rtt = Date.now() - start;
      state.latencySamples.push(rtt);
      if (state.latencySamples.length > 40) {
        state.latencySamples.shift();
      }
      const total = state.latencySamples.reduce((acc, value) => acc + value, 0);
      state.latencyMs = total / state.latencySamples.length;
    }
    return;
  }

  if (message.type === 'keyframe_request') {
    requestKeyframe('remote_request');
  }
}

function installDataChannelHandlers(channel) {
  if (channel.label === 'video') {
    state.videoChannel = channel;

    channel.binaryType = 'arraybuffer';
    channel.onopen = () => {
      setStatus('Streaming');
      showSpinner(false);
      setPanel(true);
      showHudTemporarily();
    };

    channel.onmessage = async (event) => {
      if (event.data instanceof ArrayBuffer) {
        handleVideoPacket(event.data);
        return;
      }

      if (event.data instanceof Blob) {
        const arrayBuffer = await event.data.arrayBuffer();
        handleVideoPacket(arrayBuffer);
      }
    };

    channel.onclose = () => {
      disconnect('Video channel closed');
    };

    return;
  }

  if (channel.label === 'control') {
    state.controlChannel = channel;

    channel.onopen = () => {
      if (state.pingTimer) {
        clearInterval(state.pingTimer);
      }
      state.pingTimer = setInterval(() => {
        const pingId = String(Date.now());
        state.pendingPingById.set(pingId, Date.now());
        sendControl({ type: 'ping', pingId, ts: Date.now() });
      }, PING_INTERVAL_MS);
    };

    channel.onmessage = (event) => {
      if (typeof event.data === 'string') {
        handleControlMessage(event.data);
      }
    };

    channel.onclose = () => {
      if (state.pingTimer) {
        clearInterval(state.pingTimer);
        state.pingTimer = null;
      }
    };
  }
}

async function updateConnectionKind() {
  if (!state.pc) {
    state.connectionKind = '--';
    return;
  }

  try {
    const stats = await state.pc.getStats();
    let selectedPair = null;
    const candidates = new Map();

    stats.forEach((report) => {
      if (report.type === 'transport' && report.selectedCandidatePairId) {
        selectedPair = stats.get(report.selectedCandidatePairId) || null;
      }

      if (report.type === 'remote-candidate' || report.type === 'local-candidate') {
        candidates.set(report.id, report);
      }
    });

    if (!selectedPair || !selectedPair.remoteCandidateId) {
      return;
    }

    const remote = candidates.get(selectedPair.remoteCandidateId);
    if (!remote) {
      return;
    }

    state.connectionKind = remote.candidateType === 'relay' ? 'Relay' : 'P2P';
  } catch (_err) {
    // Ignore stats collection errors.
  }
}

function startMetricsLoop() {
  if (state.metricsTimer) {
    clearInterval(state.metricsTimer);
  }

  state.metricsTimer = setInterval(() => {
    state.fps = state.decodedFramesThisSecond;
    state.bitrateMbps = (state.payloadBytesThisSecond * 8) / 1_000_000;

    state.decodedFramesThisSecond = 0;
    state.payloadBytesThisSecond = 0;
    updateHud();
  }, METRICS_INTERVAL_MS);

  if (state.connectionProbeTimer) {
    clearInterval(state.connectionProbeTimer);
  }

  state.connectionProbeTimer = setInterval(() => {
    updateConnectionKind();
  }, 2000);
}

function stopMetricsLoop() {
  if (state.metricsTimer) {
    clearInterval(state.metricsTimer);
    state.metricsTimer = null;
  }

  if (state.connectionProbeTimer) {
    clearInterval(state.connectionProbeTimer);
    state.connectionProbeTimer = null;
  }
}

function teardownPeer() {
  if (state.videoChannel) {
    try {
      state.videoChannel.close();
    } catch (_err) {
      // Ignore channel close errors.
    }
  }
  if (state.controlChannel) {
    try {
      state.controlChannel.close();
    } catch (_err) {
      // Ignore channel close errors.
    }
  }

  if (state.pc) {
    try {
      state.pc.close();
    } catch (_err) {
      // Ignore peer close errors.
    }
  }

  state.videoChannel = null;
  state.controlChannel = null;
  state.pc = null;
}

function teardownDecoder() {
  if (state.decoder) {
    try {
      state.decoder.close();
    } catch (_err) {
      // Ignore decoder close errors.
    }
  }
  state.decoder = null;
  state.decoderCodec = null;
  state.waitingForKeyframe = true;
}

function teardownSocket() {
  if (state.ws) {
    try {
      state.ws.close();
    } catch (_err) {
      // Ignore websocket close errors.
    }
  }
  state.ws = null;
}

function disconnect(reason) {
  if (state.destroyed) {
    return;
  }

  if (state.pingTimer) {
    clearInterval(state.pingTimer);
    state.pingTimer = null;
  }

  stopMetricsLoop();
  teardownPeer();
  teardownSocket();
  teardownDecoder();
  clearFrameBuffers();

  state.pendingPingById.clear();
  state.latencySamples = [];
  state.latencyMs = null;
  state.bitrateMbps = 0;
  state.fps = 0;
  state.connectionKind = '--';

  updateHud();
  setPanel(false);
  showSpinner(false);
  setStatus(reason || 'Disconnected');
}

function setupPeerConnection(iceServers) {
  state.pc = new RTCPeerConnection({ iceServers });

  state.pc.ondatachannel = (event) => {
    installDataChannelHandlers(event.channel);
  };

  state.pc.onicecandidate = (event) => {
    if (!event.candidate) {
      return;
    }

    sendWs({
      type: 'signal_ice',
      viewerId: state.viewerId,
      candidate: event.candidate,
    });
  };

  state.pc.onconnectionstatechange = () => {
    const current = state.pc.connectionState;
    if (current === 'connected') {
      setStatus('Streaming');
      startMetricsLoop();
      showSpinner(false);
      setPanel(true);
      showHudTemporarily();
    }

    if (current === 'failed' || current === 'disconnected' || current === 'closed') {
      disconnect(`Connection ${current}`);
    }
  };
}

async function onSignalOffer(message) {
  if (!state.pc) {
    return;
  }

  await state.pc.setRemoteDescription(message.sdp);
  const answer = await state.pc.createAnswer();
  await state.pc.setLocalDescription(answer);

  sendWs({
    type: 'signal_answer',
    viewerId: state.viewerId,
    sdp: state.pc.localDescription,
  });
}

async function connectToRoom(roomCode) {
  state.roomCode = roomCode;
  setStatus('Connecting to signaling server...');
  showSpinner(true);

  await state.renderer.initialize(ui.canvas);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl());
    state.ws = ws;

    ws.addEventListener('open', () => {
      setStatus('Joining room...');
      sendWs({ type: 'viewer_join', code: roomCode });
    });

    ws.addEventListener('message', async (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (_err) {
        return;
      }

      if (message.type === 'viewer_joined') {
        state.viewerId = message.viewerId;
        state.iceServers = Array.isArray(message.iceServers) ? message.iceServers : [];
        setupPeerConnection(state.iceServers);
        setStatus('Waiting for host offer...');
        resolve();
        return;
      }

      if (message.type === 'signal_offer') {
        try {
          await onSignalOffer(message);
        } catch (err) {
          disconnect(`Offer handling failed: ${err.message}`);
        }
        return;
      }

      if (message.type === 'signal_ice') {
        if (state.pc && message.candidate) {
          try {
            await state.pc.addIceCandidate(message.candidate);
          } catch (_err) {
            // Ignore invalid ICE candidates.
          }
        }
        return;
      }

      if (message.type === 'room_closed') {
        disconnect(`Room closed: ${message.reason || 'host closed'}`);
        return;
      }

      if (message.type === 'error') {
        reject(new Error(message.message || message.code || 'Signaling error'));
      }
    });

    ws.addEventListener('error', () => {
      reject(new Error('Signaling socket error'));
    });

    ws.addEventListener('close', () => {
      if (state.pc && state.pc.connectionState !== 'closed') {
        disconnect('Signaling disconnected');
      }
    });
  });
}

function setupInputCapture() {
  document.addEventListener('mousemove', showHudTemporarily, { passive: true });
  document.addEventListener('keydown', showHudTemporarily, { passive: true });

  ui.canvas.addEventListener('click', async () => {
    showHudTemporarily();
    try {
      await ui.canvas.requestPointerLock();
    } catch (_err) {
      // Ignore pointer lock rejection.
    }
  });

  document.addEventListener('keydown', (event) => {
    if (!state.controlChannel || state.controlChannel.readyState !== 'open') {
      return;
    }

    if (event.key === 'F11') {
      event.preventDefault();
    }

    sendControl({
      type: 'input',
      event: 'keydown',
      code: event.code,
      key: event.key,
      repeat: event.repeat,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
      ts: Date.now(),
    });
  });

  document.addEventListener('keyup', (event) => {
    if (!state.controlChannel || state.controlChannel.readyState !== 'open') {
      return;
    }

    sendControl({
      type: 'input',
      event: 'keyup',
      code: event.code,
      key: event.key,
      ts: Date.now(),
    });
  });

  ui.canvas.addEventListener('mousemove', (event) => {
    if (!state.controlChannel || state.controlChannel.readyState !== 'open') {
      return;
    }

    const ts = performance.now();
    if (ts - state.mouseSendTs < 8) {
      return;
    }
    state.mouseSendTs = ts;

    const rect = ui.canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));

    sendControl({
      type: 'input',
      event: 'mousemove',
      x,
      y,
      dx: event.movementX,
      dy: event.movementY,
      buttons: event.buttons,
      ts: Date.now(),
    });
  });

  ui.canvas.addEventListener('mousedown', (event) => {
    sendControl({
      type: 'input',
      event: 'mousedown',
      button: event.button,
      buttons: event.buttons,
      ts: Date.now(),
    });
  });

  ui.canvas.addEventListener('mouseup', (event) => {
    sendControl({
      type: 'input',
      event: 'mouseup',
      button: event.button,
      buttons: event.buttons,
      ts: Date.now(),
    });
  });

  ui.canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      sendControl({
        type: 'input',
        event: 'scroll',
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaZ: event.deltaZ,
        ts: Date.now(),
      });
    },
    { passive: false }
  );

  ui.canvas.addEventListener('contextmenu', (event) => {
    event.preventDefault();
  });
}

function setupUi() {
  ui.roomCode.addEventListener('input', () => {
    const normalized = normalizeRoomCode(ui.roomCode.value);
    if (normalized !== ui.roomCode.value) {
      ui.roomCode.value = normalized;
    }
  });

  ui.form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const code = normalizeRoomCode(ui.roomCode.value);
    if (code.length !== 6) {
      setStatus('Enter a valid 6-character code');
      return;
    }

    ui.connectButton.disabled = true;

    try {
      await connectToRoom(code);
    } catch (err) {
      disconnect(err.message || 'Failed to connect');
    } finally {
      ui.connectButton.disabled = false;
    }
  });

  ui.fullscreenButton.addEventListener('click', async () => {
    showHudTemporarily();
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    await document.documentElement.requestFullscreen();
  });

  ui.disconnectButton.addEventListener('click', () => {
    disconnect('Disconnected by user');
  });

  document.addEventListener('fullscreenchange', () => {
    state.renderer.resize(ui.canvas.clientWidth, ui.canvas.clientHeight);
  });

  window.addEventListener('resize', () => {
    state.renderer.resize(ui.canvas.clientWidth, ui.canvas.clientHeight);
  });
}

async function main() {
  setupUi();
  setupInputCapture();
  updateHud();
  setPanel(false);
  setStatus('Idle');
}

main();
