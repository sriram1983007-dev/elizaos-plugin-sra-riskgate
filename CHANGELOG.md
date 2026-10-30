# Changelog

## 0.5.0 — 2026-10-29
- **Already-delegated accounts are stopped.** Before every guarded call the guard reads its own account's code
  (`eth_getCode`). An EIP-7702 delegation designator (`0xef0100` + address) to a contract not in the new
  `expectedDelegates` option stops everything with `ACCOUNT_DELEGATED`, which `allowUnsupported` does not bypass:
  an authorization signed outside the guarded client leaves exactly this trace. Unreadable code stops with
  `ACCOUNT_CODE_UNREADABLE`; `checkAccountCode: false` skips the read. Suggested by Carlos (Bloqarl) on DEV.to.
- `checkPayment` takes `accountCode` and `expectedDelegates` too, matching `sra-riskgate` 0.16.0 (parity vectors
  regenerated, 162 cases). New exports `checkAccountCode()`, `delegateFromCode()`, `DELEGATED_FLAG`.
- Changed: the guard now makes one `eth_getCode` read per guarded call. Wallet clients whose transport cannot
  answer it need `checkAccountCode: false`.

## 0.4.0 — 2026-10-28
- **Address-poisoning check**, matching `sra-riskgate` 0.15.0: with `knownRecipients` set, a recipient that is not
  known but imitates a known payee (at least 7 matching hex characters, at least 3 at each end) is rejected as
  `LOOKALIKE_RECIPIENT`, naming the payee it imitates. It applies to every payment the guard checks (transfers,
  batches, x402 authorizations), and `allowUnsupported` does not bypass it. New exports `findLookalike()` and
  `LOOKALIKE_FLAG`. Parity vectors regenerated from the Python SDK 0.15.0 (150 cases).

## 0.3.0 — 2026-10-27
- Fixed: the wallet guard did not wrap `signTypedData` or `signMessage`, so an agent could sign an unlimited USDC
  permit, or a long-lived x402 authorization, through the guarded client unchecked. Now:
  - a USDC x402 authorization (EIP-3009, and Circle Gateway batched payments on Circle's GatewayWallet contract)
    gets the payment checks and a validity limit (`maxValiditySeconds`, default 1 hour;
    `maxGatewayValiditySeconds`, default 8 days);
  - any EIP-2612 or Permit2 permit is held as `TOKEN_APPROVAL` (plus `UNLIMITED_APPROVAL`), which
    `allowUnsupported` does not bypass;
  - other typed data and `signMessage` are blocked unless `allowUnsupported` is set.
- New export `checkAuthorization()`, the port of the Python SDK's `check_authorization`, with parity vectors
  generated from the Python SDK (`scripts/make_auth_vectors.py`, `test/auth_vectors.json`).

## 0.2.0 — 2026-10-26
- `sendCalls` (EIP-5792 call batches) is now checked instead of always blocked. Each call, raw calldata or
  ABI-encoded, must be a USDC transfer; payments to the same payee are added up before `checkPayment`, so splitting
  a payment does not get it under `maxAmount`, and a batch whose total is over `maxAmount` is held
  (`HIGH_VALUE_TRANSFER`). Any other call blocks the batch and is named in the explanation.
- Changed: with `allowUnsupported`, USDC transfers inside a `sendCalls` batch are now checked too (before, the
  whole batch went through unchecked).
- `onDecision` receives `payments` for a batch.

## 0.1.3 — 2026-10-25
- Fixed: the wallet guard ignored EIP-7702 `authorizationList`, so a USDC transfer that also delegated the
  account to contract code was approved, and `signAuthorization` was not guarded at all. Any delegation
  (an `authorizationList`, a type-4 transaction, a raw `0x04…` transaction, or `signAuthorization`) is now
  held with flag `CODE_DELEGATION`, which `allowUnsupported` does not bypass. New export `delegationHold()`.
  Thanks to Carlos (Bloqarl) on DEV.to for the question that found this.

## 0.1.2 — 2026-10-22
- Added a complete demo agent in `examples/eliza-demo` (ElizaOS 1.7.2, Base Sepolia, Gemini or Ollama), and
  its results in the README.
- Added a logo and banner (`images/`), and `agentConfig` in `package.json` for the ElizaOS plugin registry.
  No code changes.

## 0.1.1 — 2026-10-22
- Fixed: importing the package without `@elizaos/core` installed failed with `ERR_MODULE_NOT_FOUND`, so
  `checkPayment` and `guardWalletClient` could not be used outside ElizaOS as documented. ElizaOS is now
  loaded only when the plugin's actions run. CI installs the packed package with only viem to check this.
- Fixed: `CHECK_STABLECOIN_PAYMENT` threw if the model call failed while reading the request; it now
  reports a hold (`CHECK_FAILED`), like `SEND_USDC_CHECKED`.
- `npm pack` now builds `dist/` first (a `prepack` script), so a packed tarball always contains the code.

## 0.1.0 — 2026-10-22
- First release. `guardWalletClient()` checks every transaction a viem wallet client would broadcast:
  USDC transfers are decoded and checked, everything else is blocked unless `allowUnsupported` is set.
- ElizaOS plugin `createRiskGatePlugin()` with `SEND_USDC_CHECKED` (sends only on approve, through the
  guarded client) and `CHECK_STABLECOIN_PAYMENT` (reports only).
- `checkPayment()`: the sra-riskgate 0.8.0 rules in TypeScript (OFAC SDN snapshot of 2026-10-01, blocklist,
  new-payee hold, limits, depeg, self-asserted claims), matching the Python SDK on 167 parity cases.
