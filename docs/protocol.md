# 📡 Smart tape measure BLE protocol notes

> 🐙 **Canonical repository:**
> [akunopaka/smart-e-tape-measure-web-bluetooth](https://github.com/akunopaka/smart-e-tape-measure-web-bluetooth)

These notes describe behaviour observed on a physical RF-BMF01 measuring tape
advertising the name `ES-Tape`. They are not manufacturer documentation. A
different hardware or firmware revision may behave differently.

Only one physical unit has been tested so far. That is enough to build a useful
adapter, but not enough to declare every observation universal. Test reports
from other smart Bluetooth tape measures are very welcome. 📏

The good news: this device sends readable, semicolon-delimited ASCII. By
reverse-engineering standards, that is practically a handwritten invitation.

## 🏷️ Evidence labels

- **Observed**: present in captured BLE traffic or the discovered GATT table.
- **Inferred**: consistently matches physical behaviour but is not vendor-confirmed.
- **Unknown**: recorded without assigning a meaning.

## 🛰️ GATT surface

| Item | UUID | Status |
| --- | --- | --- |
| Custom primary service | `0783b03e-8535-b5a0-7140-a304d2495cb7` | Observed |
| Notification characteristic | `0783b03e-8535-b5a0-7140-a304d2495cb8` | Observed, Notify |
| Client Characteristic Configuration | `0x2902` | Observed |
| Write characteristic | `0783b03e-8535-b5a0-7140-a304d2495cba` | Observed, Write Without Response |

Notifications are sufficient to receive live values. No write command has been
shown to be necessary, so this project does not use the write characteristic.

The application discovers devices by the custom service UUID or `ES-Tape` name.
It never relies on a MAC address because an address identifies one physical unit
and may also be private or unstable.

## 📏 Measurement frame

Observed notifications are 20 bytes and decode as ASCII:

```text
*AAAAA;BBBBB;CCCCSU\n
```

| Field | Example | Interpretation | Confidence |
| --- | --- | --- | --- |
| Start marker | `*` | Frame start | Observed |
| `AAAAA` | `00530` | Encoded measurement | Inferred |
| `BBBBB` | `00000` | Unknown numeric field | Unknown |
| `CCCC` | `0000` | Unknown numeric field | Unknown |
| `S` | `P` or `S` | Measurement state | Inferred |
| `U` | `M` | Unit code, likely metric | Inferred |
| Terminator | `\n` | Frame terminator | Observed |

Captured examples:

```text
*00490;00000;0000PM\n
*00510;00000;0000PM\n
*00520;00000;0000PM\n
*00530;00000;0000PM\n
```

The working conversion is:

```text
measurement_mm = AAAAA / 10
```

For example, `00530 / 10 = 53 mm = 5.3 cm`.

## 🔎 State observations

`P` packets track the moving tape. `S` packets occur in repeated bursts that
correlate with physical confirmation-button tests. Early captures contained
four identical packets over roughly 300 to 355 ms; later captures showed that a
burst can stretch to about 1.1 seconds.

The app therefore treats:

- `P` as a provisional or live value;
- the first `S` after `P`, a value change, or a gap over 1.5 seconds as a new
  confirmation;
- later `S` packets in the same burst as repeats with the same confirmation ID.

The 1.5-second boundary is an application heuristic, not a protocol constant. Every
raw notification remains in the capture even when the UI groups a burst.

## 📦 Other frames

A 20-byte payload containing only zero bytes was observed and is classified as
`zero-frame`. Any other payload that does not match the measurement pattern is
classified as `unknown`; it is preserved rather than discarded.

## 🔗 Connection behaviour

The tape may disconnect after a short idle period. Observed Android GATT logs
included connection timeout and generic GATT errors. The web client treats a
disconnect as recoverable, rediscovers the service and characteristic, and
enables notifications again.

Reconnect delays are `0.5 s`, `1 s`, `2 s`, then `5 s` for up to 12 attempts.
When the page is hidden, the pending retry is paused until the page becomes
visible. Waking or slightly extending the tape often helps.

## 🧭 Reproducing a finding: A -> B -> C

### A. 👀 Observe

Record the advertisement, GATT surface, notification bytes, timestamps, and the
physical display before assigning field meanings.

### B. 🧩 Correlate

Add an action marker, change one physical input, and match the marker, display,
raw bytes, decoded fields, and timestamp in the exported JSON.

### C. ✅ Confirm

Repeat the action at several values and after reconnection. A finding graduates
from inference only when repetition makes coincidence implausible. Testing a
second unit or model is even better.

Do not publish an entire capture without reviewing its browser and device
metadata. A useful report includes the smallest redacted packet sequence that
still demonstrates the finding.

## ❓ Open questions

- What do `P`, `S`, and `M` stand for in the vendor protocol?
- What are the second and third numeric fields?
- Are other unit codes emitted when the tape changes display units?
- Does every firmware revision use the same confirmation burst?
- What commands, if any, are accepted by the write characteristic?
- Which other smart tape measure models expose a compatible GATT protocol?

The final question should only be investigated with controlled, low-risk tests;
arbitrary writes are intentionally out of scope.
