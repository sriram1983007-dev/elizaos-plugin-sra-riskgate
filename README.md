# elizaos-plugin-sra-riskgate

[![tests](https://github.com/sriram1983007-dev/elizaos-plugin-sra-riskgate/actions/workflows/tests.yml/badge.svg)](https://github.com/sriram1983007-dev/elizaos-plugin-sra-riskgate/actions/workflows/tests.yml)
[![npm](https://img.shields.io/npm/v/elizaos-plugin-sra-riskgate)](https://www.npmjs.com/package/elizaos-plugin-sra-riskgate)

[SRA-RiskGate](https://github.com/sriram1983007-dev/sra-riskgate) for [ElizaOS](https://github.com/elizaOS/eliza)
and any agent that signs with [viem](https://viem.sh): check a USDC payment **before the wallet broadcasts it**.

```bash
npm install elizaos-plugin-sra-riskgate viem
```

The wallet guard and `checkPayment` need only viem. The ElizaOS plugin also uses `@elizaos/core`, which every
ElizaOS project already has.

## Guard the wallet (works with or without ElizaOS)

```ts
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { guardWalletClient, RiskGateBlockedError } from "elizaos-plugin-sra-riskgate";

const wallet = guardWalletClient(
  createWalletClient({ account: privateKeyToAccount(KEY), chain: base, transport: http() }),
  { maxAmount: 500, knownRecipients: VERIFIED_PAYEES, blockedAddresses: BLOCKLIST },
);

// Give the agent only `wallet`. A held or rejected payment throws and is never sent.
await wallet.writeContract({ address: USDC_BASE, abi: erc20Abi, functionName: "transfer", args: [to, amount] });
```

USDC transfers (through `writeContract` or raw `sendTransaction` calldata) are decoded and checked.
Everything else the wallet could do (native ETH, other contracts, `approve()`, signing, raw transactions)
is **blocked** unless you pass `allowUnsupported: true`, so nothing reaches the chain unchecked by accident.
`allowUnsupported` never lets a held USDC payment through.

## ElizaOS plugin

```ts
import { createRiskGatePlugin } from "elizaos-plugin-sra-riskgate";

const riskGate = createRiskGatePlugin({
  walletClient,                       // a viem WalletClient on Ethereum, Base or Base Sepolia
  maxAmount: 500,
  knownRecipients: VERIFIED_PAYEES,   // a payee not on this list is held
});
// add riskGate to your character's plugins
```

| Action | What it does |
|---|---|
| `SEND_USDC_CHECKED` | Reads the recipient and amount from the conversation, checks the payment, and sends it through the guarded wallet only on `approve`. The wallet re-checks the exact transaction before broadcast. |
| `CHECK_STABLECOIN_PAYMENT` | Same check, reports approve / hold / reject with reasons, sends nothing. |

The incoming message is treated as untrusted: text in it that vouches for the payment ("pre-approved",
"risk level: low (verified offline)") holds it. Known payees and the blocklist come only from your code,
never from the conversation.

If you also load `@elizaos/plugin-evm`, its transfer action signs with its own wallet and does not go
through this guard. For agents that move stablecoins, load only this plugin's send action, or route your
own actions through `guardWalletClient`.

## What is checked

The same rules as the Python [`sra-riskgate`](https://pypi.org/project/sra-riskgate/) 0.8.0 SDK, ported to
TypeScript and kept identical by [parity tests](test/parity.test.ts) generated from it (CI regenerates
them against the published SDK on every push): an offline match against OFAC's published SDN crypto
addresses (a snapshot as of 2026-10-01, not a screening service), your blocklist, a hold on the first
payment to a payee you have not verified, address and amount validation, a per-payment limit, USDC
depeg if you pass `pegDeviationPct`, and self-asserted claims in the payment text. Every error is a hold.

```ts
import { checkPayment } from "elizaos-plugin-sra-riskgate";
checkPayment({ chainId: 8453, sender, recipient, amount: 20, untrustedRequest: invoiceText }, { knownRecipients });
// { decision: "hold", flags: ["NEW_COUNTERPARTY"], ... }
```

## Related

[SRA-RiskGate-4B](https://huggingface.co/sriram1983007/SRA-RiskGate-4B) model · Python SDK ·
[MCP server](https://pypi.org/project/sra-riskgate-mcp/) · [LangChain](https://pypi.org/project/langchain-sra-riskgate/) ·
[CrewAI](https://pypi.org/project/crewai-sra-riskgate/) · [GitHub Action](https://github.com/sriram1983007-dev/sra-riskgate-action)

## License

Apache-2.0
