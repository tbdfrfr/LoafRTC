const HEADER_SIZE = 14;

function parseVideoPacket(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < HEADER_SIZE) {
    return null;
  }

  const view = new DataView(buffer);
  const frameId = view.getUint32(0, false);
  const packetIndex = view.getUint8(4);
  const packetCount = view.getUint8(5);
  const frameType = view.getUint8(6);
  const codec = view.getUint8(7);
  const timestampUs = view.getUint32(8, false);
  const payloadLength = view.getUint16(12, false);

  if (packetCount === 0 || payloadLength === 0) {
    return null;
  }

  if (HEADER_SIZE + payloadLength !== buffer.byteLength) {
    return null;
  }

  if (packetIndex >= packetCount) {
    return null;
  }

  const payload = new Uint8Array(buffer, HEADER_SIZE, payloadLength);

  return {
    frameId,
    packetIndex,
    packetCount,
    frameType,
    codec,
    timestampUs,
    payload,
  };
}

export { HEADER_SIZE, parseVideoPacket };
