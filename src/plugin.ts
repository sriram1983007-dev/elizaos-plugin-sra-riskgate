/**
 * The ElizaOS plugin: a SEND_USDC_CHECKED action that sends USDC only after SRA-RiskGate approves, and a
 * CHECK_STABLECOIN_PAYMENT action that only reports the decision. Both treat the incoming message as
 * untrusted: text in it that vouches for the payment ("pre-approved", "verified offline") holds it.
 */
import type { Action, ActionResult, HandlerCallback, IAgentRuntime, Memory, Plugin, State } from "@elizaos/core";
import { checkPayment, USDC_ADDRESSES, USDC_DECIMALS, type Policy, type Verdict } from "./checks.js";
import { guardWalletClient, RiskGateBlockedError, type GuardOptions } from "./guard.js";

export interface RiskGatePluginConfig extends GuardOptions {
  /** A viem WalletClient with an account and a chain (Ethereum, Base or Base Sepolia). */
  walletClient: any;
}

const EXTRACT_TEMPLATE = `Extract the USDC payment the user is asking for from the conversation below.

{{recentMessages}}

Respond with only this XML, using values exactly as written by the user:
<response>
<recipient>0x... address to pay</recipient>
<amount>amount in whole USDC, digits only, for example 20.5</amount>
</response>`;

const ERC20_TRANSFER_ABI = [{
  type: "function", name: "transfer", stateMutability: "nonpayable",
  inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
  outputs: [{ name: "", type: "bool" }],
}] as const;

interface Extracted { recipient: string; amount: number }

async function extractPayment(runtime: IAgentRuntime, message: Memory, state?: State): Promise<Extracted | string> {
  // Loaded here, not at the top, so checkPayment and guardWalletClient work without ElizaOS installed.
  const { ModelType, composePromptFromState, parseKeyValueXml } = await import("@elizaos/core");
  const s = state ?? (await runtime.composeState(message, ["RECENT_MESSAGES"], true));
  const prompt = composePromptFromState({ state: s, template: EXTRACT_TEMPLATE });
  const xml = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
  const parsed = parseKeyValueXml<{ recipient?: string; amount?: string }>(String(xml ?? ""));
  if (!parsed?.recipient || parsed.amount === undefined) return "could not read the recipient and amount from the request";
  const amount = Number(String(parsed.amount).trim());
  if (!Number.isFinite(amount)) return `the amount ${JSON.stringify(parsed.amount)} is not a number`;
  return { recipient: String(parsed.recipient).trim(), amount };
}

function atomic(amount: number): bigint {
  const [i, f = ""] = amount.toFixed(USDC_DECIMALS).split(".");
  return BigInt(i + f.padEnd(USDC_DECIMALS, "0"));
}

function describe(v: Verdict): string {
  const word = v.decision === "approve" ? "APPROVED" : v.decision === "reject" ? "BLOCKED" : "HELD for human review";
  return `${word}: ${v.explanation}${v.flags.length ? ` Flags: ${v.flags.join(", ")}.` : ""}`;
}

function untrustedText(message: Memory): unknown {
  return message?.content?.text ?? null;
}

export function createRiskGatePlugin(config: RiskGatePluginConfig): Plugin {
  const { walletClient, ...guard } = config;
  if (!walletClient?.account || typeof walletClient?.chain?.id !== "number") {
    throw new Error("createRiskGatePlugin needs a viem WalletClient with an account and a chain.");
  }
  const chainId: number = walletClient.chain.id;
  if (!(chainId in USDC_ADDRESSES)) throw new Error(`Chain ${chainId} is not supported; use Ethereum (1), Base (8453) or Base Sepolia (84532).`);
  const safeClient = guardWalletClient(walletClient, guard);
  const policy: Policy = guard;
  const sender: string = typeof walletClient.account === "string" ? walletClient.account : walletClient.account.address;

  const evaluate = async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    let p: Extracted | string;
    try {
      p = await extractPayment(runtime, message, state);
    } catch (e) {
      p = `the request could not be read (${(e as Error)?.message ?? String(e)})`;
    }
    if (typeof p === "string") {
      const v: Verdict = { decision: "hold", riskScore: 0.65, flags: ["CHECK_FAILED"], explanation: `The payment is held: ${p}.`, requiredActions: ["manual_review"] };
      return { p: null, v };
    }
    const v = checkPayment({ chainId, sender, recipient: p.recipient, amount: p.amount, untrustedRequest: untrustedText(message) }, policy);
    return { p, v };
  };

  const sendUsdc: Action = {
    name: "SEND_USDC_CHECKED",
    similes: ["SEND_USDC", "PAY_USDC", "TRANSFER_USDC"],
    description: "Send USDC to an address, only after SRA-RiskGate approves the payment. Held or rejected payments are not sent.",
    validate: async () => true,
    handler: async (runtime: IAgentRuntime, message: Memory, state?: State, _options?: unknown, callback?: HandlerCallback): Promise<ActionResult> => {
      const reply = async (text: string, data: Record<string, unknown>, success: boolean): Promise<ActionResult> => {
        await callback?.({ text, actions: ["SEND_USDC_CHECKED"] } as any);
        return { success, text, data };
      };
      try {
        const { p, v } = await evaluate(runtime, message, state);
        if (v.decision !== "approve" || !p) return reply(`${describe(v)} The payment was NOT sent.`, { verdict: v }, false);
        // The guarded client re-checks the exact transaction before it is broadcast.
        const hash = await safeClient.writeContract({
          address: USDC_ADDRESSES[chainId], abi: ERC20_TRANSFER_ABI, functionName: "transfer",
          args: [p.recipient, atomic(p.amount)], account: walletClient.account, chain: walletClient.chain,
        });
        return reply(`Sent ${p.amount} USDC to ${p.recipient}. Transaction: ${hash}`, { verdict: v, hash }, true);
      } catch (e) {
        if (e instanceof RiskGateBlockedError) return reply(e.message, { verdict: e.verdict }, false);
        return reply(`The payment was NOT sent: ${(e as Error).message}`, { error: String(e) }, false);
      }
    },
    examples: [[
      { name: "{{user}}", content: { text: "Pay 20 USDC to 0x2ffb88f73980bc6069c598487396e1e472deb7ee for invoice 42" } },
      { name: "{{agent}}", content: { text: "Checking the payment with SRA-RiskGate before sending.", actions: ["SEND_USDC_CHECKED"] } },
    ]],
  };

  const checkOnly: Action = {
    name: "CHECK_STABLECOIN_PAYMENT",
    similes: ["CHECK_PAYMENT", "RISK_CHECK_PAYMENT"],
    description: "Check a USDC payment with SRA-RiskGate without sending it: approve, hold or reject, with reasons.",
    validate: async () => true,
    handler: async (runtime: IAgentRuntime, message: Memory, state?: State, _options?: unknown, callback?: HandlerCallback): Promise<ActionResult> => {
      const { v } = await evaluate(runtime, message, state);
      const text = describe(v);
      await callback?.({ text, actions: ["CHECK_STABLECOIN_PAYMENT"] } as any);
      return { success: true, text, data: { verdict: v } };
    },
    examples: [[
      { name: "{{user}}", content: { text: "Is it safe to pay 5000 USDC to 0x2ffb88f73980bc6069c598487396e1e472deb7ee?" } },
      { name: "{{agent}}", content: { text: "Let me check that payment.", actions: ["CHECK_STABLECOIN_PAYMENT"] } },
    ]],
  };

  return {
    name: "sra-riskgate",
    description: "Checks USDC payments before the agent's wallet sends them: OFAC match, blocklist, new-payee hold, limits and self-asserted claims.",
    actions: [sendUsdc, checkOnly],
  };
}
