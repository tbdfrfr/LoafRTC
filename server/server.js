'use strict';

const crypto = require('crypto');
const http = require('http');
const path = require('path');

const dotenv = require('dotenv');
const express = require('express');
const helmet = require('helmet');
const { WebSocketServer, WebSocket } = require('ws');

const { buildIceServers, validateTurnEnv } = require('./turn');

const localEnvPath = path.join(__dirname, '.env');
const rootEnvPath = path.join(__dirname, '..', '.env');
dotenv.config({ path: localEnvPath });
dotenv.config({ path: rootEnvPath, override: false });

const PORT = Number(process.env.PORT || 3000);
const ROOM_CODE_LENGTH = 6;
const HEARTBEAT_MS = 20_000;
const STALE_ROOM_MS = 60 * 60 * 1000;
const MAX_SDP_LENGTH = 262_144;
const MAX_CANDIDATE_LENGTH = 8_192;

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function normalizeRoomCode(raw) {
  return String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, ROOM_CODE_LENGTH);
}

function createRoomCode(rooms) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  for (let attempts = 0; attempts < 1000; attempts += 1) {
    let code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
      code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    if (!rooms.has(code)) {
      return code;
    }
  }

  throw new Error('Failed to allocate room code');
}

function now() {
  return Date.now();
}

function sendJson(ws, message) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(JSON.stringify(message));
}

function isValidSdpDescription(sdp) {
  if (!sdp || typeof sdp !== 'object') {
    return false;
  }

  const type = String(sdp.type || '');
  const raw = String(sdp.sdp || '');
  if (!['offer', 'answer'].includes(type)) {
    return false;
  }

  if (!raw || raw.length > MAX_SDP_LENGTH) {
    return false;
  }

  return true;
}

function isValidIceCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    return false;
  }

  const raw = String(candidate.candidate || '');
  if (!raw || raw.length > MAX_CANDIDATE_LENGTH) {
    return false;
  }

  return true;
}

function createApp(frontendPath) {
  const app = express();

  app.use(
    helmet({
      crossOriginEmbedderPolicy: false,
      contentSecurityPolicy: false,
    })
  );
  app.use(express.json({ limit: '64kb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, ts: now() });
  });

  app.use(express.static(frontendPath));

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/ws') || req.path.startsWith('/api')) {
      next();
      return;
    }
    res.sendFile(path.join(frontendPath, 'index.html'));
  });

  return app;
}

function createSignalingServer(options = {}) {
  const frontendPath = options.frontendPath || path.join(__dirname, '..', 'frontend');
  const app = createApp(frontendPath);
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  const rooms = new Map();
  const socketMeta = new WeakMap();

  function closeRoom(roomCode, reason) {
    const room = rooms.get(roomCode);
    if (!room) {
      return;
    }

    room.viewers.forEach((viewer) => {
      sendJson(viewer.ws, {
        type: 'room_closed',
        code: roomCode,
        reason,
      });
      try {
        viewer.ws.close();
      } catch (_err) {
        // Ignore socket close errors.
      }
    });

    rooms.delete(roomCode);
  }

  function handleHostRegister(ws, message) {
    const meta = socketMeta.get(ws);
    if (meta.role) {
      sendJson(ws, {
        type: 'error',
        code: 'ALREADY_REGISTERED',
        message: 'Socket already registered',
      });
      return;
    }

    const requestedCode = normalizeRoomCode(message.code);
    const roomCode = requestedCode || createRoomCode(rooms);

    const existing = rooms.get(roomCode);
    if (existing && existing.host && existing.host.ws.readyState === WebSocket.OPEN) {
      sendJson(ws, {
        type: 'error',
        code: 'ROOM_ALREADY_HOSTED',
        message: 'Room code already in use by another host',
      });
      return;
    }

    const room = {
      code: roomCode,
      host: {
        id: meta.id,
        ws,
      },
      viewers: new Map(),
      createdAt: now(),
      updatedAt: now(),
    };

    rooms.set(roomCode, room);
    meta.role = 'host';
    meta.roomCode = roomCode;

    sendJson(ws, {
      type: 'host_registered',
      code: roomCode,
      iceServers: buildIceServers(),
    });
  }

  function handleViewerJoin(ws, message) {
    const meta = socketMeta.get(ws);
    if (meta.role) {
      sendJson(ws, {
        type: 'error',
        code: 'ALREADY_REGISTERED',
        message: 'Socket already registered',
      });
      return;
    }

    const roomCode = normalizeRoomCode(message.code);
    if (roomCode.length !== ROOM_CODE_LENGTH) {
      sendJson(ws, {
        type: 'error',
        code: 'INVALID_ROOM_CODE',
        message: 'Room code must be 6 alphanumeric characters',
      });
      return;
    }

    const room = rooms.get(roomCode);
    if (!room || !room.host || room.host.ws.readyState !== WebSocket.OPEN) {
      sendJson(ws, {
        type: 'error',
        code: 'ROOM_NOT_FOUND',
        message: 'Host is offline or room does not exist',
      });
      return;
    }

    if (room.viewers.size >= 1) {
      sendJson(ws, {
        type: 'error',
        code: 'ROOM_FULL',
        message: 'Host currently supports one active viewer',
      });
      return;
    }

    const requestedViewerId = String(message.viewerId || '').trim();
    const viewerId = requestedViewerId.length > 0 ? requestedViewerId.slice(0, 64) : randomId('viewer');

    if (room.viewers.has(viewerId)) {
      sendJson(ws, {
        type: 'error',
        code: 'VIEWER_EXISTS',
        message: 'Viewer ID already in use for this room',
      });
      return;
    }

    room.viewers.set(viewerId, { id: viewerId, ws, joinedAt: now() });
    room.updatedAt = now();

    meta.role = 'viewer';
    meta.roomCode = roomCode;
    meta.viewerId = viewerId;

    sendJson(ws, {
      type: 'viewer_joined',
      code: roomCode,
      viewerId,
      iceServers: buildIceServers(),
    });

    sendJson(room.host.ws, {
      type: 'viewer_joined',
      code: roomCode,
      viewerId,
    });
  }

  function relayToViewer(room, viewerId, payload) {
    const viewer = room.viewers.get(viewerId);
    if (!viewer || viewer.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    sendJson(viewer.ws, payload);
    return true;
  }

  function relayToHost(room, payload) {
    if (!room.host || room.host.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    sendJson(room.host.ws, payload);
    return true;
  }

  function handleSignalOffer(ws, message) {
    const meta = socketMeta.get(ws);
    if (meta.role !== 'host') {
      sendJson(ws, { type: 'error', code: 'HOST_ONLY', message: 'Offer relay is host-only' });
      return;
    }

    const room = rooms.get(meta.roomCode);
    if (!room) {
      sendJson(ws, { type: 'error', code: 'ROOM_NOT_FOUND', message: 'Room not found' });
      return;
    }

    const viewerId = String(message.viewerId || '');
    if (!viewerId) {
      sendJson(ws, { type: 'error', code: 'MISSING_VIEWER_ID', message: 'viewerId is required' });
      return;
    }

    if (!isValidSdpDescription(message.sdp)) {
      sendJson(ws, { type: 'error', code: 'INVALID_SDP', message: 'Invalid offer SDP payload' });
      return;
    }

    const forwarded = relayToViewer(room, viewerId, {
      type: 'signal_offer',
      viewerId,
      sdp: message.sdp,
    });

    if (!forwarded) {
      sendJson(ws, {
        type: 'error',
        code: 'VIEWER_NOT_FOUND',
        message: 'Target viewer is not connected',
      });
    }
  }

  function handleSignalAnswer(ws, message) {
    const meta = socketMeta.get(ws);
    if (meta.role !== 'viewer') {
      sendJson(ws, { type: 'error', code: 'VIEWER_ONLY', message: 'Answer relay is viewer-only' });
      return;
    }

    const room = rooms.get(meta.roomCode);
    if (!room) {
      sendJson(ws, { type: 'error', code: 'ROOM_NOT_FOUND', message: 'Room not found' });
      return;
    }

    if (!isValidSdpDescription(message.sdp)) {
      sendJson(ws, { type: 'error', code: 'INVALID_SDP', message: 'Invalid answer SDP payload' });
      return;
    }

    relayToHost(room, {
      type: 'signal_answer',
      viewerId: meta.viewerId,
      sdp: message.sdp,
    });
  }

  function handleSignalIce(ws, message) {
    const meta = socketMeta.get(ws);
    const room = rooms.get(meta.roomCode);

    if (!room) {
      sendJson(ws, { type: 'error', code: 'ROOM_NOT_FOUND', message: 'Room not found' });
      return;
    }

    if (meta.role === 'host') {
      const viewerId = String(message.viewerId || '');
      if (!viewerId) {
        sendJson(ws, {
          type: 'error',
          code: 'MISSING_VIEWER_ID',
          message: 'viewerId is required when host sends ICE',
        });
        return;
      }

      if (!isValidIceCandidate(message.candidate)) {
        sendJson(ws, {
          type: 'error',
          code: 'INVALID_ICE_CANDIDATE',
          message: 'Invalid ICE candidate payload',
        });
        return;
      }

      relayToViewer(room, viewerId, {
        type: 'signal_ice',
        viewerId,
        candidate: message.candidate,
      });
      return;
    }

    if (meta.role === 'viewer') {
      if (!isValidIceCandidate(message.candidate)) {
        sendJson(ws, {
          type: 'error',
          code: 'INVALID_ICE_CANDIDATE',
          message: 'Invalid ICE candidate payload',
        });
        return;
      }

      relayToHost(room, {
        type: 'signal_ice',
        viewerId: meta.viewerId,
        candidate: message.candidate,
      });
      return;
    }

    sendJson(ws, {
      type: 'error',
      code: 'UNREGISTERED_SOCKET',
      message: 'Socket must register as host or viewer first',
    });
  }

  function handleRoomClose(ws) {
    const meta = socketMeta.get(ws);
    if (meta.role !== 'host' || !meta.roomCode) {
      return;
    }

    closeRoom(meta.roomCode, 'host_closed');
    meta.roomCode = null;
    meta.role = null;
  }

  function handleDisconnect(ws) {
    const meta = socketMeta.get(ws);
    if (!meta || !meta.roomCode) {
      return;
    }

    const room = rooms.get(meta.roomCode);
    if (!room) {
      return;
    }

    if (meta.role === 'host') {
      closeRoom(meta.roomCode, 'host_disconnected');
      return;
    }

    if (meta.role === 'viewer' && meta.viewerId) {
      room.viewers.delete(meta.viewerId);
      room.updatedAt = now();
      relayToHost(room, {
        type: 'viewer_left',
        code: room.code,
        viewerId: meta.viewerId,
      });

      if (room.viewers.size === 0 && room.host.ws.readyState !== WebSocket.OPEN) {
        rooms.delete(room.code);
      }
    }
  }

  function handleMessage(ws, rawMessage) {
    let message;
    try {
      message = JSON.parse(rawMessage.toString());
    } catch (_err) {
      sendJson(ws, {
        type: 'error',
        code: 'INVALID_JSON',
        message: 'Message must be valid JSON',
      });
      return;
    }

    if (!message || typeof message.type !== 'string') {
      sendJson(ws, {
        type: 'error',
        code: 'INVALID_MESSAGE',
        message: 'Message missing type',
      });
      return;
    }

    switch (message.type) {
      case 'host_register':
        handleHostRegister(ws, message);
        break;
      case 'viewer_join':
        handleViewerJoin(ws, message);
        break;
      case 'signal_offer':
        handleSignalOffer(ws, message);
        break;
      case 'signal_answer':
        handleSignalAnswer(ws, message);
        break;
      case 'signal_ice':
        handleSignalIce(ws, message);
        break;
      case 'room_close':
        handleRoomClose(ws);
        break;
      default:
        sendJson(ws, {
          type: 'error',
          code: 'UNKNOWN_MESSAGE_TYPE',
          message: `Unknown message type: ${message.type}`,
        });
    }
  }

  wss.on('connection', (ws) => {
    const meta = {
      id: randomId('sock'),
      role: null,
      roomCode: null,
      viewerId: null,
      connectedAt: now(),
      isAlive: true,
    };

    socketMeta.set(ws, meta);

    sendJson(ws, {
      type: 'welcome',
      id: meta.id,
      ts: now(),
    });

    ws.on('pong', () => {
      meta.isAlive = true;
    });

    ws.on('message', (raw) => {
      handleMessage(ws, raw);
    });

    ws.on('close', () => {
      handleDisconnect(ws);
    });

    ws.on('error', () => {
      handleDisconnect(ws);
    });
  });

  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      const meta = socketMeta.get(ws);
      if (!meta) {
        return;
      }

      if (!meta.isAlive) {
        try {
          ws.terminate();
        } catch (_err) {
          // Ignore terminate errors.
        }
        return;
      }

      meta.isAlive = false;
      try {
        ws.ping();
      } catch (_err) {
        // Ignore ping errors.
      }
    });

    const deadline = now() - STALE_ROOM_MS;
    rooms.forEach((room, code) => {
      const hostOpen = room.host && room.host.ws.readyState === WebSocket.OPEN;
      if (!hostOpen && room.updatedAt < deadline) {
        closeRoom(code, 'stale_cleanup');
      }
    });
  }, HEARTBEAT_MS);

  heartbeat.unref();

  return {
    app,
    server,
    wss,
    rooms,
    close: () => {
      clearInterval(heartbeat);
      wss.close();
      server.close();
    },
  };
}

function start() {
  validateTurnEnv();
  const signaling = createSignalingServer();
  signaling.server.listen(PORT, () => {
    process.stdout.write(`[loafrtc-server] listening on :${PORT}\n`);
  });
}

if (require.main === module) {
  start();
}

module.exports = {
  createSignalingServer,
  start,
};
