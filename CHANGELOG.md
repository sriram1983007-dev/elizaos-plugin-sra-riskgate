# Changelog

## 0.1.1 — 2026-10-22
- Fixed: importing the package without `@elizaos/core` installed failed with `ERR_MODULE_NOT_FOUND`, so
  `checkPayment` and `guardWalletClient` could not be used outside ElizaOS as documented. ElizaOS is now
  loaded only when the plugin's actions run. CI installs the packed package with only viem to check this.
- Fixed: `CHECK_STABLECOIN_PAYMENT` threw if the model call failed while reading the request; it now
  reports a hold (`CHECK_FAILED`), like `SEND_USDC_CHECKED`.

## 0.1.0 — 2026-10-22
- First release. `guardWalletClient()` checks every transaction a viem wallet client would broadcast:
  USDC transfers are decoded and checked, everything else is blocked unless `allowUnsupported` is set.
- ElizaOS plugin `createRiskGatePlugin()` with `SEND_USDC_CHECKED` (sends only on approve, through the
  guarded client) and `CHECK_STABLECOIN_PAYMENT` (reports only).
- `checkPayment()`: the sra-riskgate 0.8.0 rules in TypeScript (OFAC SDN snapshot of 2026-10-01, blocklist,
  new-payee hold, limits, depeg, self-asserted claims), matching the Python SDK on 167 parity cases.
