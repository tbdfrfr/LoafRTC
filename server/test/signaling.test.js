'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const { WebSocket } = require('ws');

process.env.TURN_USERNAME = process.env.TURN_USERNAME || 'loafuser';
process.env.TURN_PASSWORD = process.env.TURN_PASSWORD || 'loafpass';
process.env.TURN_DOMAIN = process.env.TURN_DOMAIN || '127.0.0.1';

const { createSignalingServer } = require('../server');

function waitForMessage(ws, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for WebSocket message'));
    }, timeoutMs);

    function onMessage(raw) {
      let parsed;
      try {
        parsed = JSON.parse(raw.toString());
      } catch (_err) {
        return;
      }

      if (!predicate || predicate(parsed)) {
        cleanup();
        resolve(parsed);
      }
    }

    function onClose() {
      cleanup();
      reject(new Error('WebSocket closed before expected message'));
    }

    function cleanup() {
      clearTimeout(timeout);
      ws.off('message', onMessage);
      ws.off('close', onClose);
    }

    ws.on('message', onMessage);
    ws.on('close', onClose);
  });
}

function sendAndWait(ws, payload, predicate, timeoutMs = 3000) {
  const pending = waitForMessage(ws, predicate, timeoutMs);
  ws.send(JSON.stringify(payload));
  return pending;
}

async function connectWs(url) {
  const ws = new WebSocket(url);
  await once(ws, 'open');
  return ws;
}

test('host register returns room code and ice servers', async (t) => {
  const signaling = createSignalingServer();
  await new Promise((resolve) => signaling.server.listen(0, '127.0.0.1', resolve));

  t.after(() => {
    signaling.close();
  });

  const port = signaling.server.address().port;
  const host = await connectWs(`ws://127.0.0.1:${port}/ws`);
  t.after(() => host.close());

  const registered = await sendAndWait(host, { type: 'host_register' }, (msg) => msg.type === 'host_registered');

  assert.equal(typeof registered.code, 'string');
  assert.equal(registered.code.length, 6);
  assert.equal(Array.isArray(registered.iceServers), true);
  assert.equal(registered.iceServers.length >= 1, true);
});

test('second viewer is rejected with ROOM_FULL', async (t) => {
  const signaling = createSignalingServer();
  await new Promise((resolve) => signaling.server.listen(0, '127.0.0.1', resolve));

  t.after(() => {
    signaling.close();
  });

  const port = signaling.server.address().port;
  const base = `ws://127.0.0.1:${port}/ws`;

  const host = await connectWs(base);
  const viewerOne = await connectWs(base);
  const viewerTwo = await connectWs(base);

  t.after(() => {
    host.close();
    viewerOne.close();
    viewerTwo.close();
  });

  const registered = await sendAndWait(host, { type: 'host_register' }, (msg) => msg.type === 'host_registered');

  const joined = await sendAndWait(
    viewerOne,
    { type: 'viewer_join', code: registered.code },
    (msg) => msg.type === 'viewer_joined'
  );
  assert.equal(typeof joined.viewerId, 'string');

  const rejected = await sendAndWait(
    viewerTwo,
    { type: 'viewer_join', code: registered.code },
    (msg) => msg.type === 'error'
  );

  assert.equal(rejected.code, 'ROOM_FULL');
});

test('invalid offer payload is rejected', async (t) => {
  const signaling = createSignalingServer();
  await new Promise((resolve) => signaling.server.listen(0, '127.0.0.1', resolve));

  t.after(() => {
    signaling.close();
  });

  const port = signaling.server.address().port;
  const base = `ws://127.0.0.1:${port}/ws`;

  const host = await connectWs(base);
  const viewer = await connectWs(base);

  t.after(() => {
    host.close();
    viewer.close();
  });

  const registered = await sendAndWait(host, { type: 'host_register' }, (msg) => msg.type === 'host_registered');

  const viewerJoined = await sendAndWait(
    viewer,
    { type: 'viewer_join', code: registered.code },
    (msg) => msg.type === 'viewer_joined'
  );

  const rejected = await sendAndWait(
    host,
    {
      type: 'signal_offer',
      viewerId: viewerJoined.viewerId,
      sdp: { type: 'offer', sdp: '' },
    },
    (msg) => msg.type === 'error'
  );
  assert.equal(rejected.code, 'INVALID_SDP');
});

test('invalid ICE candidate payload is rejected', async (t) => {
  const signaling = createSignalingServer();
  await new Promise((resolve) => signaling.server.listen(0, '127.0.0.1', resolve));

  t.after(() => {
    signaling.close();
  });

  const port = signaling.server.address().port;
  const base = `ws://127.0.0.1:${port}/ws`;

  const host = await connectWs(base);
  const viewer = await connectWs(base);

  t.after(() => {
    host.close();
    viewer.close();
  });

  const registered = await sendAndWait(host, { type: 'host_register' }, (msg) => msg.type === 'host_registered');

  const viewerJoined = await sendAndWait(
    viewer,
    { type: 'viewer_join', code: registered.code },
    (msg) => msg.type === 'viewer_joined'
  );

  const rejected = await sendAndWait(
    host,
    {
      type: 'signal_ice',
      viewerId: viewerJoined.viewerId,
      candidate: { candidate: '' },
    },
    (msg) => msg.type === 'error'
  );

  assert.equal(rejected.code, 'INVALID_ICE_CANDIDATE');
});

test('viewer receives room_closed when host disconnects', async (t) => {
  const signaling = createSignalingServer();
  await new Promise((resolve) => signaling.server.listen(0, '127.0.0.1', resolve));

  t.after(() => {
    signaling.close();
  });

  const port = signaling.server.address().port;
  const base = `ws://127.0.0.1:${port}/ws`;

  const host = await connectWs(base);
  const viewer = await connectWs(base);

  t.after(() => {
    host.close();
    viewer.close();
  });

  const registered = await sendAndWait(host, { type: 'host_register' }, (msg) => msg.type === 'host_registered');

  await sendAndWait(
    viewer,
    { type: 'viewer_join', code: registered.code },
    (msg) => msg.type === 'viewer_joined'
  );

  const roomClosedPending = waitForMessage(viewer, (msg) => msg.type === 'room_closed');
  host.close();

  const roomClosed = await roomClosedPending;
  assert.equal(roomClosed.code, registered.code);
  assert.equal(roomClosed.reason, 'host_disconnected');
});
