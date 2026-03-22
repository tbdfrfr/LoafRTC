import test from 'node:test';
import assert from 'node:assert/strict';

import { HEADER_SIZE, parseVideoPacket } from '../protocol.mjs';

function buildPacket({
  frameId = 42,
  packetIndex = 0,
  packetCount = 2,
  frameType = 1,
  codec = 0,
  timestampUs = 123456,
  payload = new Uint8Array([1, 2, 3, 4]),
} = {}) {
  const buffer = new ArrayBuffer(HEADER_SIZE + payload.length);
  const view = new DataView(buffer);

  view.setUint32(0, frameId, false);
  view.setUint8(4, packetIndex);
  view.setUint8(5, packetCount);
  view.setUint8(6, frameType);
  view.setUint8(7, codec);
  view.setUint32(8, timestampUs, false);
  view.setUint16(12, payload.length, false);

  new Uint8Array(buffer, HEADER_SIZE).set(payload);

  return buffer;
}

test('parseVideoPacket parses a valid packet', () => {
  const payload = new Uint8Array([11, 22, 33]);
  const parsed = parseVideoPacket(
    buildPacket({
      frameId: 1001,
      packetIndex: 1,
      packetCount: 3,
      frameType: 2,
      codec: 1,
      timestampUs: 987654,
      payload,
    })
  );

  assert.ok(parsed);
  assert.equal(parsed.frameId, 1001);
  assert.equal(parsed.packetIndex, 1);
  assert.equal(parsed.packetCount, 3);
  assert.equal(parsed.frameType, 2);
  assert.equal(parsed.codec, 1);
  assert.equal(parsed.timestampUs, 987654);
  assert.deepEqual(Array.from(parsed.payload), Array.from(payload));
});

test('parseVideoPacket rejects malformed packets', () => {
  assert.equal(parseVideoPacket(null), null);
  assert.equal(parseVideoPacket(new ArrayBuffer(HEADER_SIZE - 1)), null);

  const zeroCount = buildPacket({ packetCount: 0 });
  assert.equal(parseVideoPacket(zeroCount), null);

  const zeroPayload = buildPacket({ payload: new Uint8Array([]) });
  assert.equal(parseVideoPacket(zeroPayload), null);

  const badIndex = buildPacket({ packetIndex: 2, packetCount: 2 });
  assert.equal(parseVideoPacket(badIndex), null);

  const wrongLength = buildPacket({ payload: new Uint8Array([1, 2, 3]) });
  const wrongLengthView = new DataView(wrongLength);
  wrongLengthView.setUint16(12, 10, false);
  assert.equal(parseVideoPacket(wrongLength), null);
});
