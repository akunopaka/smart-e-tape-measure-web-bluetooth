const DATABASE_NAME = "smart-tape-measure-packet-capture";
const DATABASE_VERSION = 1;
const SESSION_STORE = "sessions";
const RECORD_STORE = "records";

let databasePromise;

export async function createCaptureSession(metadata = {}) {
  const session = {
    id: crypto.randomUUID(),
    clientInstanceId: getClientInstanceId(),
    startedAt: new Date().toISOString(),
    endedAt: null,
    pageUrl: window.location.href,
    userAgent: navigator.userAgent,
    ...metadata,
  };

  const database = await openDatabase();
  await requestToPromise(
    database
      .transaction(SESSION_STORE, "readwrite")
      .objectStore(SESSION_STORE)
      .add(session),
  );

  return session;
}

function getClientInstanceId() {
  const storageKey = "smart-tape-measure-client-instance-id";
  let clientInstanceId = localStorage.getItem(storageKey);
  if (!clientInstanceId) {
    clientInstanceId = crypto.randomUUID();
    localStorage.setItem(storageKey, clientInstanceId);
  }
  return clientInstanceId;
}

export async function finishCaptureSession(sessionId) {
  if (!sessionId) {
    return;
  }

  const database = await openDatabase();
  const transaction = database.transaction(SESSION_STORE, "readwrite");
  const store = transaction.objectStore(SESSION_STORE);
  const session = await requestToPromise(store.get(sessionId));

  if (session && !session.endedAt) {
    session.endedAt = new Date().toISOString();
    await requestToPromise(store.put(session));
  }

  await transactionToPromise(transaction);
}

export async function addCaptureRecord(sessionId, record) {
  if (!sessionId) {
    throw new Error("Capture session is not initialised");
  }

  const database = await openDatabase();
  const storedRecord = {
    sessionId,
    ...record,
  };

  return requestToPromise(
    database
      .transaction(RECORD_STORE, "readwrite")
      .objectStore(RECORD_STORE)
      .add(storedRecord),
  );
}

export async function exportAllCaptures(format) {
  const payload = await readAllCaptures();
  const timestamp = payload.exportedAt
    .replaceAll(":", "-")
    .replace(/\.\d{3}Z$/, "Z");
  const baseName = `smart-tape-measure-captures-${timestamp}`;

  if (format === "json") {
    const json = JSON.stringify(payload, null, 2);
    downloadBlob(`${baseName}.json`, "application/json;charset=utf-8", json);
    return {
      sessionCount: payload.sessions.length,
      recordCount: payload.records.length,
    };
  }

  if (format === "csv") {
    const csv = recordsToCsv(payload.records);
    downloadBlob(`${baseName}.csv`, "text/csv;charset=utf-8", `\uFEFF${csv}`);
    return {
      sessionCount: payload.sessions.length,
      recordCount: payload.records.length,
    };
  }

  throw new Error(`Unsupported export format: ${format}`);
}

export async function clearAllCaptures() {
  const database = await openDatabase();
  const transaction = database.transaction(
    [SESSION_STORE, RECORD_STORE],
    "readwrite",
  );
  transaction.objectStore(SESSION_STORE).clear();
  transaction.objectStore(RECORD_STORE).clear();
  await transactionToPromise(transaction);
}

async function readAllCaptures() {
  const database = await openDatabase();
  const transaction = database.transaction(
    [SESSION_STORE, RECORD_STORE],
    "readonly",
  );
  const sessions = await requestToPromise(
    transaction.objectStore(SESSION_STORE).getAll(),
  );
  const records = await requestToPromise(
    transaction.objectStore(RECORD_STORE).getAll(),
  );
  await transactionToPromise(transaction);

  return {
    exportedAt: new Date().toISOString(),
    sessions,
    records,
  };
}

function openDatabase() {
  if (databasePromise) {
    return databasePromise;
  }

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(SESSION_STORE)) {
        database.createObjectStore(SESSION_STORE, { keyPath: "id" });
      }

      if (!database.objectStoreNames.contains(RECORD_STORE)) {
        const recordStore = database.createObjectStore(RECORD_STORE, {
          keyPath: "id",
          autoIncrement: true,
        });
        recordStore.createIndex("sessionId", "sessionId", { unique: false });
        recordStore.createIndex("kind", "kind", { unique: false });
        recordStore.createIndex(
          "receivedAtEpochMs",
          "receivedAtEpochMs",
          { unique: false },
        );
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      reject(new Error("IndexedDB upgrade is blocked by another open tab"));
    };
  });

  return databasePromise;
}

function recordsToCsv(records) {
  const columns = [
    "id",
    "sessionId",
    "kind",
    "sequence",
    "eventType",
    "receivedAt",
    "receivedAtEpochMs",
    "performanceMs",
    "sincePreviousPacketMs",
    "rawHex",
    "rawBase64",
    "rawBytes",
    "rawText",
    "isValid",
    "isZeroFrame",
    "packetType",
    "measurementMm",
    "secondaryField",
    "tertiaryField",
    "stateCode",
    "unitCode",
    "connectionEpisodeId",
    "confirmationId",
    "isConfirmedMeasurement",
    "isConfirmationStart",
    "deviceName",
    "deviceId",
    "documentVisibility",
    "connectionState",
    "message",
    "detail",
  ];

  const rows = records.map((record) =>
    columns.map((column) => {
      const value = record[column];
      if (value === null || value === undefined) {
        return "";
      }

      if (typeof value === "object") {
        return csvCell(JSON.stringify(value));
      }

      return csvCell(String(value));
    }),
  );

  return [
    columns.map(csvCell).join(","),
    ...rows.map((row) => row.join(",")),
  ].join("\r\n");
}

function csvCell(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function downloadBlob(filename, type, contents) {
  const blob = new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionToPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
