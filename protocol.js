export const TAPE_SERVICE_UUID =
  "0783b03e-8535-b5a0-7140-a304d2495cb7";

export const TAPE_NOTIFY_CHARACTERISTIC_UUID =
  "0783b03e-8535-b5a0-7140-a304d2495cb8";

export function parseTapePacket(dataView) {
  const bytes = new Uint8Array(
    dataView.buffer,
    dataView.byteOffset,
    dataView.byteLength,
  );
  const rawText = new TextDecoder("ascii").decode(bytes).trim();
  const rawHex = toHex(bytes);
  const isZeroFrame =
    bytes.length > 0 && bytes.every((byte) => byte === 0);

  if (isZeroFrame) {
    return invalidPacket(rawText, rawHex, "zero-frame", true);
  }

  const match = rawText.match(
    /^\*(\d{5});(\d{5});(\d{4})([A-Z])([A-Z])$/,
  );

  if (!match) {
    return invalidPacket(rawText, rawHex, "unknown");
  }

  const encodedMeasurement = Number.parseInt(match[1], 10);
  if (!Number.isFinite(encodedMeasurement)) {
    return invalidPacket(rawText, rawHex, "unknown");
  }

  return {
    isValid: true,
    isZeroFrame: false,
    packetType: "measurement",
    rawText,
    rawHex,
    measurementMm: encodedMeasurement / 10,
    secondaryField: match[2],
    tertiaryField: match[3],
    stateCode: match[4],
    unitCode: match[5],
  };
}

function invalidPacket(
  rawText,
  rawHex,
  packetType,
  isZeroFrame = false,
) {
  return {
    isValid: false,
    isZeroFrame,
    packetType,
    rawText,
    rawHex,
    measurementMm: null,
    secondaryField: null,
    tertiaryField: null,
    stateCode: null,
    unitCode: null,
  };
}

function toHex(bytes) {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join(" ")
    .toUpperCase();
}
