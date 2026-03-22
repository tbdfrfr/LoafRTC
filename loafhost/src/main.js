'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, clipboard, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');

const WebSocket = require('ws');
const dc = require('node-datachannel');

let nativeAddon;
try {
  nativeAddon = require(path.join(__dirname, '..', 'native', 'index.node'));
} catch (err) {
  nativeAddon = {
    start_pipeline: () => {
      throw new Error(`Native addon unavailable: ${err.message}`);
    },
    stop_pipeline: () => {},
    request_keyframe: () => {},
    update_config: () => {},
    set_video_sender: () => {},
    set_stats_callback: () => {},
  };
}

const DEFAULT_SETTINGS = {
  resolution: '1080p',
  fps: 60,
  bitrateMbps: 20,
  codec: 'auto',
  audioEnabled: false,
};

const SIGNALING_URL = process.env.SIGNALING_URL || 'ws://127.0.0.1:3000/ws';
const INPUT_PIPE_PATH = '\\\\.\\pipe\\loafrtc-input';

const state = {
  window: null,
  tray: null,
  ws: null,
  roomCode: '------',
  hostId: null,
  iceServers: [],
  status: 'Disconnected',
  settings: { ...DEFAULT_SETTINGS },

  peers: new Map(),
  inputPipe: null,
  inputBridgeProcess: null,
  stats: {
    fpsSent: 0,
    bitrateMbps: 0,
    encodeMs: 0,
    rttMs: 0,
  },
};

function updateRenderer(channel, payload) {
  if (!state.window || state.window.isDestroyed()) {
    return;
  }
  state.window.webContents.send(channel, payload);
}

function pushState() {
  updateRenderer('host:state', {
    roomCode: state.roomCode,
    status: state.status,
    settings: state.settings,
    stats: state.stats,
    peerCount: state.peers.size,
    signalingUrl: SIGNALING_URL,
  });
}

function setStatus(next) {
  state.status = next;
  pushState();
}

function createWindow() {
  state.window = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 860,
    minHeight: 560,
    backgroundColor: '#0b101b',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  state.window.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  state.window.on('closed', () => {
    state.window = null;
  });
}

function createTray() {
  const icon = nativeImage.createEmpty();
  state.tray = new Tray(icon);
  state.tray.setToolTip('LoafHost');

  const menu = Menu.buildFromTemplate([
    {
      label: 'Open LoafHost',
      click: () => {
        if (!state.window) {
          createWindow();
        }
        state.window.show();
        state.window.focus();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.quit();
      },
    },
  ]);

  state.tray.setContextMenu(menu);
}

function startInputBridge() {
  if (process.platform !== 'win32') {
    return;
  }

  const devPath = path.join(__dirname, '..', 'resources', 'input-bridge.exe');
  const prodPath = path.join(process.resourcesPath, 'input-bridge.exe');

  const inputBridgeBinary = fs.existsSync(prodPath) ? prodPath : devPath;

  if (!fs.existsSync(inputBridgeBinary)) {
    return;
  }

  state.inputBridgeProcess = spawn(inputBridgeBinary, [], {
    windowsHide: true,
    detached: false,
    stdio: 'ignore',
  });

  state.inputBridgeProcess.on('exit', () => {
    state.inputBridgeProcess = null;
  });

  connectInputPipe();
}

function connectInputPipe() {
  if (process.platform !== 'win32') {
    return;
  }

  if (state.inputPipe && !state.inputPipe.destroyed) {
    return;
  }

  const socket = net.connect(INPUT_PIPE_PATH);
  state.inputPipe = socket;

  socket.on('error', () => {
    state.inputPipe = null;
    setTimeout(connectInputPipe, 1500);
  });

  socket.on('close', () => {
    state.inputPipe = null;
    setTimeout(connectInputPipe, 1500);
  });
}

function sendInputEvent(event) {
  if (!state.inputPipe || state.inputPipe.destroyed) {
    return;
  }

  try {
    state.inputPipe.write(`${JSON.stringify(event)}\n`);
  } catch (_err) {
    // Ignore transient pipe errors.
  }
}

function buildRtcConfig() {
  return {
    iceServers: state.iceServers,
  };
}

function setupPeer(viewerId) {
  if (state.peers.has(viewerId)) {
    return state.peers.get(viewerId);
  }

  const pc = new dc.PeerConnection(`peer-${viewerId}`, buildRtcConfig());

  const videoChannel = pc.createDataChannel('video', {
    ordered: false,
    maxRetransmits: 0,
  });

  const controlChannel = pc.createDataChannel('control', {
    ordered: true,
  });

  const peer = {
    viewerId,
    pc,
    videoChannel,
    controlChannel,
    connected: false,
    createdAt: Date.now(),
  };

  state.peers.set(viewerId, peer);

  pc.onLocalDescription((sdp, type) => {
    sendWs({
      type: 'signal_offer',
      viewerId,
      sdp: { type, sdp },
    });
  });

  pc.onLocalCandidate((candidate, mid) => {
    sendWs({
      type: 'signal_ice',
      viewerId,
      candidate: {
        candidate,
        sdpMid: mid || '0',
        sdpMLineIndex: 0,
      },
    });
  });

  pc.onStateChange((next) => {
    if (next === 'connected') {
      peer.connected = true;
      setStatus('Streaming');
      pushState();
      return;
    }

    if (next === 'failed' || next === 'closed' || next === 'disconnected') {
      closePeer(viewerId);
    }
  });

  videoChannel.onOpen(() => {
    try {
      if (typeof nativeAddon.set_video_sender === 'function') {
        nativeAddon.set_video_sender(viewerId, (buffer) => {
          if (videoChannel.isOpen()) {
            videoChannel.sendMessageBinary(Buffer.from(buffer));
          }
        });
      }

      nativeAddon.start_pipeline(viewerId, {
        resolution: state.settings.resolution,
        fps: state.settings.fps,
        bitrate_mbps: state.settings.bitrateMbps,
        codec: state.settings.codec,
        audio_enabled: false,
      });
    } catch (err) {
      updateRenderer('host:error', { message: err.message || 'Failed to start stream pipeline' });
    }
  });

  videoChannel.onClosed(() => {
    closePeer(viewerId);
  });

  controlChannel.onOpen(() => {
    controlChannel.sendMessage(JSON.stringify({ type: 'host_ready', ts: Date.now() }));
  });

  controlChannel.onMessage((raw) => {
    let message;
    try {
      message = JSON.parse(raw);
    } catch (_err) {
      return;
    }

    if (!message || typeof message.type !== 'string') {
      return;
    }

    if (message.type === 'ping') {
      controlChannel.sendMessage(
        JSON.stringify({
          type: 'pong',
          pingId: message.pingId,
          ts: Date.now(),
        })
      );
      return;
    }

    if (message.type === 'keyframe_request') {
      try {
        nativeAddon.request_keyframe();
      } catch (_err) {
        // Ignore transient keyframe request failures.
      }
      return;
    }

    if (message.type === 'quality_change' && message.payload) {
      const next = {
        resolution: String(message.payload.resolution || state.settings.resolution),
        fps: Number(message.payload.fps || state.settings.fps),
        bitrate_mbps: Number(message.payload.bitrateMbps || state.settings.bitrateMbps),
        codec: String(message.payload.codec || state.settings.codec),
        audio_enabled: false,
      };
      try {
        nativeAddon.update_config(next);
      } catch (_err) {
        // Ignore config update failures.
      }
      return;
    }

    if (message.type === 'input' && message.event) {
      sendInputEvent(message);
    }
  });

  return peer;
}

function closePeer(viewerId) {
  const peer = state.peers.get(viewerId);
  if (!peer) {
    return;
  }

  state.peers.delete(viewerId);

  try {
    peer.videoChannel.close();
  } catch (_err) {
    // Ignore.
  }

  try {
    peer.controlChannel.close();
  } catch (_err) {
    // Ignore.
  }

  try {
    peer.pc.close();
  } catch (_err) {
    // Ignore.
  }

  try {
    if (typeof nativeAddon.clear_video_sender === 'function') {
      nativeAddon.clear_video_sender(viewerId);
    }
  } catch (_err) {
    // Ignore sender cleanup failures.
  }

  if (state.peers.size === 0) {
    try {
      nativeAddon.stop_pipeline();
    } catch (_err) {
      // Ignore.
    }
    setStatus('Waiting');
  }

  pushState();
}

function closeAllPeers() {
  for (const viewerId of Array.from(state.peers.keys())) {
    closePeer(viewerId);
  }
}

function sendWs(message) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    return;
  }

  state.ws.send(JSON.stringify(message));
}

function connectSignaling() {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    return;
  }

  setStatus('Connecting');
  const ws = new WebSocket(SIGNALING_URL);
  state.ws = ws;

  ws.on('open', () => {
    setStatus('Registering host');
    sendWs({ type: 'host_register' });
  });

  ws.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch (_err) {
      return;
    }

    if (message.type === 'host_registered') {
      state.roomCode = message.code || '------';
      state.iceServers = Array.isArray(message.iceServers) ? message.iceServers : [];
      setStatus('Waiting');
      pushState();
      return;
    }

    if (message.type === 'viewer_joined') {
      const peer = setupPeer(message.viewerId);
      if (peer) {
        peer.pc.setLocalDescription();
      }
      return;
    }

    if (message.type === 'signal_answer') {
      const peer = state.peers.get(message.viewerId);
      if (!peer || !message.sdp) {
        return;
      }
      peer.pc.setRemoteDescription(message.sdp.sdp, message.sdp.type);
      return;
    }

    if (message.type === 'signal_ice') {
      const peer = state.peers.get(message.viewerId);
      if (!peer || !message.candidate) {
        return;
      }

      const c = message.candidate;
      peer.pc.addRemoteCandidate(c.candidate, c.sdpMid || '0');
      return;
    }

    if (message.type === 'viewer_left') {
      closePeer(message.viewerId);
      return;
    }

    if (message.type === 'room_closed') {
      closeAllPeers();
      state.roomCode = '------';
      setStatus('Disconnected');
      return;
    }

    if (message.type === 'error') {
      updateRenderer('host:error', { message: message.message || message.code || 'Unknown server error' });
    }
  });

  ws.on('close', () => {
    setStatus('Disconnected');
    closeAllPeers();
    state.roomCode = '------';
    pushState();
    setTimeout(connectSignaling, 2000);
  });

  ws.on('error', () => {
    setStatus('Disconnected');
  });
}

function setupIpc() {
  ipcMain.handle('host:get-state', async () => ({
    roomCode: state.roomCode,
    status: state.status,
    settings: state.settings,
    stats: state.stats,
    peerCount: state.peers.size,
    signalingUrl: SIGNALING_URL,
    appVersion: app.getVersion(),
  }));

  ipcMain.handle('host:copy-room-code', async () => {
    if (state.roomCode && state.roomCode !== '------') {
      clipboard.writeText(state.roomCode);
      return true;
    }
    return false;
  });

  ipcMain.handle('host:update-settings', async (_event, patch) => {
    state.settings = {
      ...state.settings,
      ...patch,
      audioEnabled: false,
    };

    try {
      nativeAddon.update_config({
        resolution: state.settings.resolution,
        fps: Number(state.settings.fps),
        bitrate_mbps: Number(state.settings.bitrateMbps),
        codec: state.settings.codec,
        audio_enabled: false,
      });
    } catch (_err) {
      // Pipeline may not be running yet.
    }

    pushState();
    return state.settings;
  });

  ipcMain.handle('host:force-keyframe', async () => {
    try {
      nativeAddon.request_keyframe();
      return true;
    } catch (_err) {
      return false;
    }
  });

  ipcMain.handle('host:disconnect', async () => {
    closeAllPeers();
    sendWs({ type: 'room_close' });
    return true;
  });

  ipcMain.handle('host:open-signaling-url', async () => {
    await require('electron').shell.openExternal(SIGNALING_URL.replace(/^ws/, 'http'));
    return true;
  });

  if (typeof nativeAddon.set_stats_callback === 'function') {
    try {
      nativeAddon.set_stats_callback((incoming) => {
        state.stats = {
          fpsSent: Number(incoming.fps_sent || 0),
          bitrateMbps: Number(incoming.bitrate_mbps || 0),
          encodeMs: Number(incoming.encode_ms || 0),
          rttMs: Number(incoming.rtt_ms || 0),
        };
        updateRenderer('host:stats', state.stats);
      });
    } catch (_err) {
      // Ignore unavailable callback bridge.
    }
  }
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', () => {});
  autoUpdater.on('update-downloaded', () => {
    updateRenderer('host:update-downloaded', { ready: true });
  });

  setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 30 * 60 * 1000).unref();
}

function shutdown() {
  closeAllPeers();

  if (state.ws) {
    try {
      state.ws.close();
    } catch (_err) {
      // Ignore.
    }
  }

  if (state.inputPipe && !state.inputPipe.destroyed) {
    state.inputPipe.destroy();
  }

  if (state.inputBridgeProcess) {
    try {
      state.inputBridgeProcess.kill();
    } catch (_err) {
      // Ignore.
    }
  }
}

app.on('window-all-closed', (event) => {
  event.preventDefault();
  if (state.window) {
    state.window.hide();
  }
});

app.on('before-quit', () => {
  shutdown();
});

app.whenReady().then(() => {
  dc.initLogger('Error');
  createWindow();
  createTray();
  setupIpc();
  startInputBridge();
  setupAutoUpdater();
  connectSignaling();
  pushState();
});
