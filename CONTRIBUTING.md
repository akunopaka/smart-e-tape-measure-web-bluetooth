# 🤝 Contributing

> 🐙 **Canonical repository:**
> [akunopaka/smart-e-tape-measure-web-bluetooth](https://github.com/akunopaka/smart-e-tape-measure-web-bluetooth)

Found a smart tape measure that behaves differently? Good. Unexpected packets
are evidence, not an inconvenience. Small, reproducible contributions are
welcome. 🧪

## 🧾 Before opening an issue

Include:

- tape model and firmware revision, if visible;
- operating system and browser version;
- the exact physical action and displayed value;
- the smallest relevant raw HEX or ASCII packet sequence;
- whether the result also reproduces in nRF Connect.

Reports from models other than the RF-BMF01 are especially useful. Include the
advertised name and complete service/characteristic UUIDs, but never publish a
device-specific MAC address.

Remove email addresses, page URLs, browser-provided device identifiers, and any
other personal data from exported captures before attaching them.

## 🛠️ Code changes

1. Keep the browser app dependency-free unless a dependency solves a measured
   problem that the platform cannot.
2. Keep user-facing text, code, comments, tests, and documentation in English.
3. Preserve unknown fields and raw packets; do not turn an inference into a
   protocol fact without repeatable evidence.
4. Do not add writes to the undocumented characteristic without a documented,
   controlled test and a clear safety case.
5. Run `npm test` before opening a pull request.

Protocol changes should include one focused decoder test and an update to
`docs/protocol.md`.
