import {
  parseTapePacket,
  TAPE_NOTIFY_CHARACTERISTIC_UUID,
  TAPE_SERVICE_UUID,
} from "./protocol.js";
import {
  addCaptureRecord,
  clearAllCaptures,
  createCaptureSession,
  exportAllCaptures,
  finishCaptureSession,
} from "./storage.js";

const elements = {
  addMarkerButton: document.querySelector("#add-marker-button"),
  browserMessage: document.querySelector("#browser-message"),
  captureStats: document.querySelector("#capture-stats"),
  captureStatus: document.querySelector("#capture-status"),
  clearCapturesButton: document.querySelector("#clear-captures-button"),
  clearLogButton: document.querySelector("#clear-log-button"),
  connectButton: document.querySelector("#connect-button"),
  connectionMeta: document.querySelector("#connection-meta"),
  connectionStatus: document.querySelector("#connection-status"),
  deviceName: document.querySelector("#device-name"),
  diagnosticLog: document.querySelector("#diagnostic-log"),
  disconnectButton: document.querySelector("#disconnect-button"),
  exportCsvButton: document.querySelector("#export-csv-button"),
  exportJsonButton: document.querySelector("#export-json-button"),
  logStatus: document.querySelector("#log-status"),
  measurementCm: document.querySelector("#measurement-cm"),
  measurementValue: document.querySelector("#measurement-value"),
  newSessionButton: document.querySelector("#new-session-button"),
  packetMeta: document.querySelector("#packet-meta"),
  packetValidity: document.querySelector("#packet-validity"),
  pauseLogButton: document.querySelector("#pause-log-button"),
  rawAscii: document.querySelector("#raw-ascii"),
  rawHex: document.querySelector("#raw-hex"),
  recordingDot: document.querySelector("#recording-dot"),
  reselectButton: document.querySelector("#reselect-button"),
  transferCount: document.querySelector("#transfer-count"),
  transferLog: document.querySelector("#transfer-log"),
};

let selectedDevice = null;
let notifyCharacteristic = null;
let userRequestedDisconnect = false;
let connectionAttemptPromise = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let reconnectPaused = false;
let connectionEpisodeId = null;
let connectionReadyAtEpochMs = null;
let lastPacketReceivedAtEpochMs = null;
let captureSession = null;
let capturedPacketCount = 0;
let packetSequence = 0;
let lastPacketPerformanceMs = null;
let pendingPacketRender = null;
let packetRenderScheduled = false;
let previousMeasurementStateCode = null;
let previousMeasurementMm = null;
let currentConfirmationId = null;
let lastConfirmationPacketAtEpochMs = null;
let confirmedTransferCount = 0;
let logPaused = false;
const pausedLogEntries = [];
const pendingCaptureWrites = new Set();
const MAX_VISIBLE_LOG_ENTRIES = 200;
const MAX_VISIBLE_TRANSFERS = 20;
const MAX_RECONNECT_ATTEMPTS = 12;
// ponytail: one global threshold; make it per-device if captures prove different burst timing.
const CONFIRMATION_BURST_GAP_MS = 1_500;
const RECONNECT_DELAYS_MS = [
  500,
  1_000,
  2_000,
  5_000,
  5_000,
  5_000,
  5_000,
  5_000,
  5_000,
  5_000,
  5_000,
  5_000,
];

initialise();

function initialise() {
  elements.connectButton.addEventListener("click", connectSelectedOrChoose);
  elements.reselectButton.addEventListener("click", chooseAndConnect);
  elements.disconnectButton.addEventListener("click", disconnect);
  elements.addMarkerButton.addEventListener("click", addManualMarker);
  elements.newSessionButton.addEventListener("click", startNewCaptureSession);
  elements.exportJsonButton.addEventListener("click", () => {
    void exportCurrentCapture("json");
  });
  elements.exportCsvButton.addEventListener("click", () => {
    void exportCurrentCapture("csv");
  });
  elements.clearCapturesButton.addEventListener("click", clearCaptureHistory);
  elements.pauseLogButton.addEventListener("click", toggleLogPause);
  elements.clearLogButton.addEventListener("click", () => {
    elements.diagnosticLog.replaceChildren();
    pausedLogEntries.length = 0;
    updateLogStatus();
  });
  document.addEventListener("visibilitychange", () => {
    log(`Page visibility: ${document.visibilityState}`, {
      eventType: "visibility-change",
    });
    if (
      document.visibilityState === "hidden" &&
      reconnectTimer
    ) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
      reconnectAttempt = Math.max(0, reconnectAttempt - 1);
      reconnectPaused = true;
      setStatus(
        "Reconnect paused - return to this page",
        "working",
      );
      elements.connectionMeta.textContent =
        "Waiting for the page to become visible";
      log("Reconnect timer paused because the page is hidden", {
        eventType: "reconnect-paused",
      });
      setConnectionButtons(false);
      return;
    }
    if (
      document.visibilityState === "visible" &&
      reconnectPaused &&
      !userRequestedDisconnect &&
      !selectedDevice?.gatt?.connected
    ) {
      reconnectPaused = false;
      scheduleReconnect("Page is visible again");
    }
  });
  void startNewCaptureSession();

  if (!window.isSecureContext) {
    showUnsupported(
      "Web Bluetooth requires HTTPS or localhost.",
    );
    return;
  }

  if (!navigator.bluetooth) {
    showUnsupported(
      "Web Bluetooth is not available in this browser. Check the browser compatibility link in the README.",
    );
    return;
  }

  elements.browserMessage.textContent =
    "Web Bluetooth is available. Wake the tape, then connect.";
  log("Ready to select a device");
}

async function connectSelectedOrChoose() {
  if (selectedDevice) {
    cancelReconnect(true);
    userRequestedDisconnect = false;
    await connectGatt({ reason: "manual-reconnect" });
    return;
  }

  await chooseAndConnect();
}

async function chooseAndConnect() {
  if (!navigator.bluetooth) {
    return;
  }

  try {
    cancelReconnect(true);
    userRequestedDisconnect = false;
    setStatus("Opening the Bluetooth device chooser...", "working");
    log("Requesting a device by service UUID or ES-Tape name");

    const selectionStartedAt = performance.now();
    const device = await navigator.bluetooth.requestDevice({
      filters: [
        { services: [TAPE_SERVICE_UUID] },
        { namePrefix: "ES-Tape" },
      ],
      optionalServices: [TAPE_SERVICE_UUID],
    });

    selectDevice(device);
    logTiming("Device selected", selectionStartedAt);
    await connectGatt({ reason: "device-selected" });
  } catch (error) {
    handleError("Device selection or connection failed", error);
  }
}

function selectDevice(device) {
  if (selectedDevice) {
    selectedDevice.removeEventListener(
      "gattserverdisconnected",
      handleDisconnected,
    );
  }

  selectedDevice = device;
  selectedDevice.addEventListener(
    "gattserverdisconnected",
    handleDisconnected,
  );
  elements.deviceName.textContent =
    selectedDevice.name || "RF-BMF01 (name not advertised)";
  elements.reselectButton.disabled = false;
  elements.connectButton.textContent = "Reconnect";
}

async function connectGatt({
  reason = "manual",
  isReconnect = false,
  attempt = 0,
} = {}) {
  if (!selectedDevice?.gatt) {
    throw new Error("The selected device does not expose a GATT server");
  }
  if (connectionAttemptPromise) {
    return connectionAttemptPromise;
  }

  connectionAttemptPromise = establishGattConnection({
    reason,
    isReconnect,
    attempt,
  });
  try {
    return await connectionAttemptPromise;
  } finally {
    connectionAttemptPromise = null;
    setConnectionButtons(false);
  }
}

async function establishGattConnection({ reason, isReconnect, attempt }) {
  const attemptStartedAt = performance.now();
  const timings = {};
  removeNotificationListener();
  setConnectionButtons(true);
  setStatus(
    isReconnect
      ? `Reconnecting ${attempt}/${MAX_RECONNECT_ATTEMPTS}...`
      : "Connecting to GATT...",
    "working",
  );
  elements.connectionMeta.textContent = isReconnect
    ? `Automatic reconnect - attempt ${attempt}`
    : "Establishing the BLE connection";

  log(
    isReconnect
      ? `Automatic reconnect attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS}`
      : "GATT connection started",
    {
      eventType: isReconnect ? "reconnect-attempt" : "connection-attempt",
      detail: { attempt, reason },
    },
  );

  try {
    let startedAt = performance.now();
    const server = selectedDevice.gatt.connected
      ? selectedDevice.gatt
      : await selectedDevice.gatt.connect();
    timings.gattMs = roundMilliseconds(performance.now() - startedAt);
    logTiming("GATT connected", startedAt);

    startedAt = performance.now();
    const service = await server.getPrimaryService(TAPE_SERVICE_UUID);
    timings.serviceMs = roundMilliseconds(performance.now() - startedAt);
    logTiming("Custom service discovered", startedAt);

    startedAt = performance.now();
    const characteristic = await service.getCharacteristic(
      TAPE_NOTIFY_CHARACTERISTIC_UUID,
    );
    characteristic.addEventListener(
      "characteristicvaluechanged",
      handleNotification,
    );
    await characteristic.startNotifications();
    notifyCharacteristic = characteristic;
    timings.notificationsMs = roundMilliseconds(
      performance.now() - startedAt,
    );
    timings.totalMs = roundMilliseconds(
      performance.now() - attemptStartedAt,
    );

    lastPacketPerformanceMs = null;
    lastPacketReceivedAtEpochMs = null;
    previousMeasurementStateCode = null;
    previousMeasurementMm = null;
    currentConfirmationId = null;
    lastConfirmationPacketAtEpochMs = null;
    connectionEpisodeId = crypto.randomUUID();
    connectionReadyAtEpochMs = Date.now();
    reconnectAttempt = 0;
    reconnectPaused = false;
    cancelReconnect(false);
    logTiming("Notifications enabled", startedAt);

    setStatus("Connected - waiting for measurements", "connected");
    elements.connectionMeta.textContent =
      `Automatic reconnect enabled - BLE session ${shortValue(connectionEpisodeId, 8)}`;
    log(
      isReconnect
        ? `Reconnected in ${Math.round(timings.totalMs)} ms`
        : `BLE ready in ${Math.round(timings.totalMs)} ms`,
      {
        eventType: isReconnect
          ? "reconnect-success"
          : "connection-ready",
        detail: {
          attempt,
          reason,
          connectionEpisodeId,
          timings,
        },
      },
    );
    return true;
  } catch (error) {
    const detail = errorDetails(error);
    removeNotificationListener();
    resetFailedGattConnection();

    setStatus(
      isReconnect
        ? `Reconnect attempt ${attempt} failed`
        : "Could not enable notifications",
      "error",
    );
    log(
      `${isReconnect ? `Reconnect ${attempt}` : "Connection"}: ${detail.name}: ${detail.message}`,
      {
        eventType: isReconnect
          ? "reconnect-failed"
          : "connection-failed",
        detail: {
          attempt,
          reason,
          error: detail,
          elapsedMs: roundMilliseconds(
            performance.now() - attemptStartedAt,
          ),
        },
      },
    );

    if (!userRequestedDisconnect) {
      scheduleReconnect("Connection error");
    }
    return false;
  }
}

function handleNotification(event) {
  const receivedAt = new Date();
  const receivedAtPerformanceMs = performance.now();
  const sourceValue = event.target.value;
  const rawBytes = new Uint8Array(
    sourceValue.buffer,
    sourceValue.byteOffset,
    sourceValue.byteLength,
  ).slice();
  const packet = parseTapePacket(new DataView(rawBytes.buffer));
  const sincePreviousPacketMs =
    lastPacketPerformanceMs === null
      ? null
      : receivedAtPerformanceMs - lastPacketPerformanceMs;
  lastPacketPerformanceMs = receivedAtPerformanceMs;
  lastPacketReceivedAtEpochMs = receivedAt.getTime();
  packetSequence += 1;
  const confirmation = classifyConfirmation(packet);

  capturePacket({
    kind: "packet",
    sequence: packetSequence,
    receivedAt: receivedAt.toISOString(),
    receivedAtEpochMs: receivedAt.getTime(),
    performanceMs: roundMilliseconds(receivedAtPerformanceMs),
    sincePreviousPacketMs:
      sincePreviousPacketMs === null
        ? null
        : roundMilliseconds(sincePreviousPacketMs),
    rawBytes: Array.from(rawBytes),
    rawBase64: bytesToBase64(rawBytes),
    rawHex: packet.rawHex,
    rawText: packet.rawText,
    isValid: packet.isValid,
    isZeroFrame: packet.isZeroFrame,
    packetType: packet.packetType,
    measurementMm: packet.measurementMm,
    secondaryField: packet.secondaryField,
    tertiaryField: packet.tertiaryField,
    stateCode: packet.stateCode,
    unitCode: packet.unitCode,
    connectionEpisodeId,
    confirmationId: confirmation.confirmationId,
    isConfirmedMeasurement: confirmation.isConfirmedMeasurement,
    isConfirmationStart: confirmation.isConfirmationStart,
    deviceName: selectedDevice?.name || null,
    deviceId: selectedDevice?.id || null,
    documentVisibility: document.visibilityState,
    connectionState: selectedDevice?.gatt?.connected
      ? "connected"
      : "disconnected",
  });
  recordConfirmedTransfer(packet, confirmation, packetSequence, receivedAt);

  schedulePacketRender(
    packet,
    sincePreviousPacketMs,
    packetSequence,
    confirmation,
  );
}

function recordConfirmedTransfer(packet, confirmation, sequence, receivedAt) {
  if (!packet.isValid || !confirmation.isConfirmationStart) {
    return;
  }

  confirmedTransferCount += 1;
  elements.transferCount.textContent = String(confirmedTransferCount);

  const item = document.createElement("li");
  const number = document.createElement("span");
  const value = document.createElement("strong");
  const codes = document.createElement("span");
  const raw = document.createElement("code");
  const time = document.createElement("time");

  number.textContent = `#${confirmedTransferCount}`;
  value.textContent = `${formatNumber(packet.measurementMm)} mm`;
  codes.className = "transfer-code";
  codes.textContent = `${packet.stateCode}/${packet.unitCode}`;
  raw.textContent = printable(packet.rawText);
  raw.title = `RX packet #${sequence}: ${packet.rawHex}`;
  time.dateTime = receivedAt.toISOString();
  time.textContent = receivedAt.toLocaleTimeString();

  item.append(number, value, codes, raw, time);
  elements.transferLog.prepend(item);
  while (elements.transferLog.childElementCount > MAX_VISIBLE_TRANSFERS) {
    elements.transferLog.lastElementChild.remove();
  }
}

function schedulePacketRender(
  packet,
  sincePreviousPacketMs,
  sequence,
  confirmation,
) {
  pendingPacketRender = {
    packet,
    sincePreviousPacketMs,
    sequence,
    confirmation,
  };
  if (packetRenderScheduled) {
    return;
  }

  packetRenderScheduled = true;
  window.requestAnimationFrame(() => {
    packetRenderScheduled = false;
    const renderData = pendingPacketRender;
    pendingPacketRender = null;
    if (renderData) {
      renderPacket(renderData);
    }
  });
}

function renderPacket({
  packet,
  sincePreviousPacketMs,
  sequence,
  confirmation,
}) {
  elements.rawAscii.textContent = printable(packet.rawText);
  elements.rawHex.textContent = packet.rawHex || "—";
  elements.packetMeta.dataset.state = packet.stateCode || packet.packetType;
  const intervalLabel =
    sincePreviousPacketMs === null
      ? "first packet"
      : `${formatNumber(sincePreviousPacketMs)} ms since previous`;

  if (packet.isZeroFrame) {
    elements.packetValidity.textContent =
      `ZERO_FRAME - empty service frame - ${intervalLabel}`;
    elements.packetMeta.textContent = "ZERO / -";
    log(`ZERO_FRAME #${sequence} - ${intervalLabel}`, {
      persist: false,
    });
    return;
  }

  if (!packet.isValid) {
    elements.packetValidity.textContent =
      `Unrecognised packet format - ${intervalLabel}`;
    elements.packetMeta.textContent = "- / -";
    log(
      `Unknown packet #${sequence}: ${printable(packet.rawText)} | ${packet.rawHex}`,
      { persist: false },
    );
    return;
  }

  elements.measurementValue.textContent = formatNumber(packet.measurementMm);
  elements.measurementCm.textContent =
    `${formatNumber(packet.measurementMm / 10)} cm`;
  elements.packetMeta.textContent =
    `${packet.stateCode} / ${packet.unitCode}`;
  elements.packetValidity.textContent =
    packet.stateCode === "S"
      ? `${confirmation.isConfirmationStart ? "New confirmed measurement" : "Repeated confirmation"} - ${intervalLabel}`
      : `Live value - fields: ${packet.secondaryField}; ${packet.tertiaryField} - ${intervalLabel}`;
  log(
    `Packet #${sequence} ${printable(packet.rawText)} -> ${formatNumber(packet.measurementMm)} mm`,
    { persist: false },
  );
}

function handleDisconnected() {
  const disconnectedAtEpochMs = Date.now();
  const disconnectedEpisodeId = connectionEpisodeId;
  const connectedDurationMs = connectionReadyAtEpochMs
    ? disconnectedAtEpochMs - connectionReadyAtEpochMs
    : null;
  const sinceLastPacketMs = lastPacketReceivedAtEpochMs
    ? disconnectedAtEpochMs - lastPacketReceivedAtEpochMs
    : null;

  removeNotificationListener();
  lastPacketPerformanceMs = null;
  connectionEpisodeId = null;
  connectionReadyAtEpochMs = null;
  setConnectionButtons(false);

  if (userRequestedDisconnect) {
    setStatus("Disconnected by user", "idle");
    elements.connectionMeta.textContent =
      "Automatic reconnect stopped";
    log("GATT disconnected by user");
    return;
  }

  setStatus("Connection lost - starting reconnect", "working");
  elements.connectionMeta.textContent =
    "Wake or extend the tape; reconnection is automatic";
  log("Received gattserverdisconnected event", {
    eventType: "gatt-disconnected",
    detail: {
      connectionEpisodeId: disconnectedEpisodeId,
      connectedDurationMs,
      sinceLastPacketMs,
      lastPacketSequence: packetSequence,
      documentVisibility: document.visibilityState,
    },
  });
  scheduleReconnect("gattserverdisconnected");
}

function disconnect() {
  const wasReconnectActive = Boolean(
    reconnectTimer || reconnectPaused || reconnectAttempt > 0,
  );
  userRequestedDisconnect = true;
  cancelReconnect(true);
  removeNotificationListener();

  if (selectedDevice?.gatt?.connected) {
    selectedDevice.gatt.disconnect();
  } else if (wasReconnectActive) {
    setStatus("Automatic reconnect stopped", "idle");
    elements.connectionMeta.textContent =
      "Select Reconnect to try again";
    setConnectionButtons(false);
    log("Automatic reconnect stopped by user", {
      eventType: "reconnect-cancelled",
    });
  } else {
    handleDisconnected();
  }
}

function removeNotificationListener() {
  if (!notifyCharacteristic) {
    return;
  }

  notifyCharacteristic.removeEventListener(
    "characteristicvaluechanged",
    handleNotification,
  );
  notifyCharacteristic = null;
}

function scheduleReconnect(reason) {
  if (
    userRequestedDisconnect ||
    !selectedDevice?.gatt ||
    selectedDevice.gatt.connected ||
    reconnectTimer
  ) {
    return;
  }

  if (document.visibilityState === "hidden") {
    if (!reconnectPaused) {
      reconnectPaused = true;
      setStatus("Reconnect paused - return to this page", "working");
      elements.connectionMeta.textContent =
        "Mobile browsers may restrict BLE while a page is hidden";
      log("Automatic reconnect paused because the page is hidden", {
        eventType: "reconnect-paused",
        detail: { reason },
      });
    }
    return;
  }

  if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
    reconnectPaused = false;
    setStatus("Automatic reconnect stopped", "error");
    elements.connectionMeta.textContent =
      "Wake the tape, then select Reconnect";
    log(
      `Automatic reconnect exhausted after ${MAX_RECONNECT_ATTEMPTS} attempts`,
      {
        eventType: "reconnect-exhausted",
        detail: { reason },
      },
    );
    setConnectionButtons(false);
    return;
  }

  const attempt = reconnectAttempt + 1;
  reconnectAttempt = attempt;
  const delayMs =
    RECONNECT_DELAYS_MS[
      Math.min(attempt - 1, RECONNECT_DELAYS_MS.length - 1)
    ];
  setStatus(
    `Reconnect ${attempt}/${MAX_RECONNECT_ATTEMPTS} in ${formatNumber(delayMs / 1_000)} s`,
    "working",
  );
  elements.connectionMeta.textContent =
    "Wake or slightly extend the tape";
  log(
    `Reconnect ${attempt}/${MAX_RECONNECT_ATTEMPTS} scheduled in ${delayMs} ms`,
    {
      eventType: "reconnect-scheduled",
      detail: { attempt, delayMs, reason },
    },
  );

  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    void connectGatt({
      reason,
      isReconnect: true,
      attempt,
    });
  }, delayMs);
  setConnectionButtons(false);
}

function cancelReconnect(resetAttempts) {
  if (reconnectTimer) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectPaused = false;
  if (resetAttempts) {
    reconnectAttempt = 0;
  }
}

function resetFailedGattConnection() {
  if (!selectedDevice?.gatt?.connected) {
    return;
  }

  selectedDevice.removeEventListener(
    "gattserverdisconnected",
    handleDisconnected,
  );
  selectedDevice.gatt.disconnect();
  selectedDevice.addEventListener(
    "gattserverdisconnected",
    handleDisconnected,
  );
}

function classifyConfirmation(packet) {
  if (!packet.isValid) {
    return {
      confirmationId: null,
      isConfirmedMeasurement: false,
      isConfirmationStart: false,
    };
  }

  let isConfirmationStart = false;
  if (packet.stateCode === "S") {
    const receivedAtEpochMs = Date.now();
    isConfirmationStart =
      previousMeasurementStateCode !== "S" ||
      previousMeasurementMm !== packet.measurementMm ||
      lastConfirmationPacketAtEpochMs === null ||
      receivedAtEpochMs - lastConfirmationPacketAtEpochMs >
        CONFIRMATION_BURST_GAP_MS;
    if (isConfirmationStart || !currentConfirmationId) {
      currentConfirmationId = crypto.randomUUID();
    }
    lastConfirmationPacketAtEpochMs = receivedAtEpochMs;
  } else {
    currentConfirmationId = null;
    lastConfirmationPacketAtEpochMs = null;
  }

  previousMeasurementStateCode = packet.stateCode;
  previousMeasurementMm = packet.measurementMm;
  return {
    confirmationId:
      packet.stateCode === "S" ? currentConfirmationId : null,
    isConfirmedMeasurement: packet.stateCode === "S",
    isConfirmationStart,
  };
}

async function startNewCaptureSession() {
  setCaptureControlsBusy(true);

  try {
    await waitForPendingCaptureWrites();
    await finishCaptureSession(captureSession?.id);

    captureSession = await createCaptureSession({
      deviceName: selectedDevice?.name || null,
      serviceUuid: TAPE_SERVICE_UUID,
      notifyCharacteristicUuid: TAPE_NOTIFY_CHARACTERISTIC_UUID,
    });
    capturedPacketCount = 0;
    packetSequence = 0;
    lastPacketPerformanceMs = null;
    previousMeasurementStateCode = null;
    previousMeasurementMm = null;
    currentConfirmationId = null;
    lastConfirmationPacketAtEpochMs = null;
    confirmedTransferCount = 0;
    elements.transferCount.textContent = "0";
    elements.transferLog.replaceChildren();
    updateCaptureStats();
    elements.captureStatus.textContent =
      `Recording - session ${shortSessionId(captureSession.id)}`;
    elements.recordingDot.dataset.recording = "true";
    setCaptureControlsBusy(false);
    log(`Capture session started: ${captureSession.id}`);
  } catch (error) {
    elements.captureStatus.textContent =
      `IndexedDB error: ${error instanceof Error ? error.message : String(error)}`;
    elements.recordingDot.dataset.recording = "false";
    setCaptureControlsBusy(false, true);
    log("Raw capture could not start", { persist: false });
  }
}

function capturePacket(record) {
  if (!captureSession) {
    log("Packet received before IndexedDB was ready", { persist: false });
    return;
  }

  capturedPacketCount += 1;
  updateCaptureStats();
  queueCaptureWrite(addCaptureRecord(captureSession.id, record));
}

function captureEvent(eventType, message, detail = null) {
  if (!captureSession) {
    return;
  }

  const now = new Date();
  queueCaptureWrite(
    addCaptureRecord(captureSession.id, {
      kind: "event",
      eventType,
      receivedAt: now.toISOString(),
      receivedAtEpochMs: now.getTime(),
      performanceMs: roundMilliseconds(performance.now()),
      connectionState: selectedDevice?.gatt?.connected
        ? "connected"
        : "disconnected",
      documentVisibility: document.visibilityState,
      message,
      detail,
    }),
  );
}

function addManualMarker() {
  const timestamp = new Date().toISOString();
  log(`Tester marker ${timestamp}`, {
    eventType: "manual-marker",
    detail: {
      instruction: "Physical tape button action follows this marker",
    },
  });
  elements.captureStatus.textContent =
    "Marker saved - perform the physical tape action now";
}

function queueCaptureWrite(writePromise) {
  let trackedPromise;
  trackedPromise = writePromise
    .catch((error) => {
      elements.captureStatus.textContent =
        `Capture error: ${error instanceof Error ? error.message : String(error)}`;
      elements.recordingDot.dataset.recording = "false";
      log("Could not save the capture record", { persist: false });
    })
    .finally(() => {
      pendingCaptureWrites.delete(trackedPromise);
      updateCaptureStats();
    });
  pendingCaptureWrites.add(trackedPromise);
  updateCaptureStats();
}

async function exportCurrentCapture(format) {
  if (!captureSession) {
    return;
  }

  setCaptureControlsBusy(true);
  try {
    await waitForPendingCaptureWrites();
    const result = await exportAllCaptures(format);
    elements.captureStatus.textContent =
      `${format.toUpperCase()} exported - ${result.sessionCount} sessions, ${result.recordCount} records`;
    log(`Capture exported as ${format.toUpperCase()}`);
  } catch (error) {
    elements.captureStatus.textContent =
      `Export error: ${error instanceof Error ? error.message : String(error)}`;
    log("Could not export the capture", { persist: false });
  } finally {
    setCaptureControlsBusy(false);
  }
}

async function clearCaptureHistory() {
  const confirmed = window.confirm(
    "Delete every BLE capture session stored by this site?",
  );
  if (!confirmed) {
    return;
  }

  setCaptureControlsBusy(true);
  try {
    await waitForPendingCaptureWrites();
    await clearAllCaptures();
    captureSession = null;
    await startNewCaptureSession();
    log("Previous capture sessions deleted");
  } catch (error) {
    elements.captureStatus.textContent =
      `Delete error: ${error instanceof Error ? error.message : String(error)}`;
    setCaptureControlsBusy(false);
  }
}

function setCaptureControlsBusy(isBusy, storageFailed = false) {
  elements.addMarkerButton.disabled = isBusy || storageFailed;
  elements.newSessionButton.disabled = isBusy || storageFailed;
  elements.exportJsonButton.disabled =
    isBusy || storageFailed || !captureSession;
  elements.exportCsvButton.disabled =
    isBusy || storageFailed || !captureSession;
  elements.clearCapturesButton.disabled = isBusy || storageFailed;
}

function updateCaptureStats() {
  elements.captureStats.textContent =
    `Packets in this session: ${capturedPacketCount} - pending writes: ${pendingCaptureWrites.size}`;
}

async function waitForPendingCaptureWrites() {
  await Promise.allSettled([...pendingCaptureWrites]);
}

function setStatus(message, state) {
  elements.connectionStatus.textContent = message;
  elements.connectionStatus.dataset.state = state;
}

function setConnectionButtons(isBusy) {
  const isConnected = Boolean(selectedDevice?.gatt?.connected);
  const reconnectActive =
    !userRequestedDisconnect &&
    Boolean(reconnectTimer || reconnectPaused || reconnectAttempt > 0);
  elements.connectButton.disabled = isBusy || isConnected;
  elements.reselectButton.disabled = isBusy || isConnected || !selectedDevice;
  elements.disconnectButton.disabled =
    isBusy || (!isConnected && !reconnectActive);
  elements.disconnectButton.textContent = isConnected
    ? "Disconnect"
    : reconnectActive
      ? "Stop reconnect"
      : "Disconnect";
}

function showUnsupported(message) {
  elements.browserMessage.textContent = message;
  elements.connectButton.disabled = true;
  setStatus("Browser not supported", "error");
  log(message);
}

function handleError(context, error) {
  const errorDetail = errorDetails(error);
  const detail = `${errorDetail.name}: ${errorDetail.message}`;
  setStatus(context, "error");
  setConnectionButtons(false);
  log(`${context}: ${detail}`);
}

function errorDetails(error) {
  if (error instanceof Error || error instanceof DOMException) {
    return {
      name: error.name || "Error",
      message: error.message || String(error),
    };
  }
  return {
    name: "Error",
    message: String(error),
  };
}

function logTiming(label, startedAt) {
  log(`${label} in ${Math.round(performance.now() - startedAt)} ms`);
}

function log(message, options = {}) {
  const { persist = true, eventType = "diagnostic", detail = null } = options;
  const item = document.createElement("li");
  const time = document.createElement("time");
  const now = new Date();
  time.dateTime = now.toISOString();
  time.textContent = now.toLocaleTimeString();
  item.append(time, document.createTextNode(message));
  if (logPaused) {
    pausedLogEntries.push(item);
    updateLogStatus();
  } else {
    prependLogItem(item);
  }

  if (persist) {
    captureEvent(eventType, message, detail);
  }
}

function toggleLogPause() {
  logPaused = !logPaused;
  elements.pauseLogButton.textContent = logPaused ? "▶ Resume" : "⏸ Pause";
  elements.pauseLogButton.setAttribute("aria-pressed", String(logPaused));

  if (!logPaused) {
    for (const item of pausedLogEntries) {
      prependLogItem(item);
    }
    pausedLogEntries.length = 0;
  }
  updateLogStatus();
}

function prependLogItem(item) {
  elements.diagnosticLog.prepend(item);
  while (elements.diagnosticLog.childElementCount > MAX_VISIBLE_LOG_ENTRIES) {
    elements.diagnosticLog.lastElementChild.remove();
  }
}

function updateLogStatus() {
  elements.logStatus.textContent = logPaused
    ? `Paused - ${pausedLogEntries.length} queued; capture continues`
    : "Live";
}

function printable(value) {
  const printableValue = Array.from(value, (character) => {
    if (character === "\r") {
      return "\\r";
    }
    if (character === "\n") {
      return "\\n";
    }
    if (character === "\t") {
      return "\\t";
    }
    const code = character.codePointAt(0);
    return code < 32 || code === 127
      ? `\\x${code.toString(16).padStart(2, "0").toUpperCase()}`
      : character;
  }).join("");
  return printableValue || "-";
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function roundMilliseconds(value) {
  return Math.round(value * 1_000) / 1_000;
}

function shortSessionId(sessionId) {
  return sessionId.slice(0, 8);
}

function shortValue(value, length) {
  const text = String(value || "-");
  return text === "-" ? text : text.slice(0, length);
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-GB", {
    maximumFractionDigits: 1,
  }).format(value);
}
