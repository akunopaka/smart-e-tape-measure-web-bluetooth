import assert from "node:assert/strict";
import test from "node:test";

import { parseTapePacket } from "../protocol.js";

function packet(text) {
  const bytes = new TextEncoder().encode(text);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

test("decodes an observed metric measurement frame", () => {
  assert.deepEqual(parseTapePacket(packet("*00530;00000;0000PM\n")), {
    isValid: true,
    isZeroFrame: false,
    packetType: "measurement",
    rawText: "*00530;00000;0000PM",
    rawHex: "2A 30 30 35 33 30 3B 30 30 30 30 30 3B 30 30 30 30 50 4D 0A",
    measurementMm: 53,
    secondaryField: "00000",
    tertiaryField: "0000",
    stateCode: "P",
    unitCode: "M",
  });
});

test("classifies an all-zero notification", () => {
  const bytes = new Uint8Array(20);
  const result = parseTapePacket(new DataView(bytes.buffer));

  assert.equal(result.packetType, "zero-frame");
  assert.equal(result.isZeroFrame, true);
  assert.equal(result.isValid, false);
});

test("preserves the observed confirmation state", () => {
  const result = parseTapePacket(packet("*00530;00000;0000SM\n"));

  assert.equal(result.measurementMm, 53);
  assert.equal(result.stateCode, "S");
  assert.equal(result.unitCode, "M");
});

test("preserves an unknown packet without inventing fields", () => {
  const result = parseTapePacket(packet("unexpected"));

  assert.equal(result.packetType, "unknown");
  assert.equal(result.rawText, "unexpected");
  assert.equal(result.measurementMm, null);
});
