import { describe, expect, it } from "vitest";
import { createWalletClient, custom, encodeFunctionData, erc20Abi, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { createRiskGatePlugin, guardWalletClient, RiskGateBlockedError, USDC_ADDRESSES } from "../src/index.js";
import { BUNDLED_SANCTIONS } from "../src/sanctions-data.js";

const USDC = USDC_ADDRESSES[8453] as `0x${string}`;
const PAYEE = "0x2ffb88f73980bc6069c598487396e1e472deb7ee" as const;
const OTHER = ("0x" + "c".repeat(40)) as `0x${string}`;
const SANCTIONED = BUNDLED_SANCTIONS[0] as `0x${string}`;
const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

/** A real viem wallet client whose RPC only records what would reach the chain. */
function wallet() {
  const broadcast: string[] = [];
  const transport = custom({
    async request({ method }: { method: string; params?: unknown }) {
      switch (method) {
        case "eth_chainId": return "0x2105";
        case "eth_getTransactionCount": return "0x0";
        case "eth_estimateGas": return "0x15f90";
        case "eth_maxPriorityFeePerGas": return "0x3b9aca00";
        case "eth_gasPrice": return "0x3b9aca00";
        case "eth_getBlockByNumber": return { baseFeePerGas: "0x3b9aca00", number: "0x1" };
        case "eth_sendRawTransaction": broadcast.push(method); return "0x" + "ab".repeat(32);
        default: throw new Error(`unexpected RPC ${method}`);
      }
    },
  });
  return { client: createWalletClient({ account, chain: base, transport }), broadcast };
}

const transfer = (to: string, usdc: number) => ({
  address: USDC, abi: erc20Abi, functionName: "transfer" as const, args: [to as `0x${string}`, BigInt(Math.round(usdc * 1e6))] as const,
});

describe("guardWalletClient", () => {
  it("sends an approved USDC transfer", async () => {
    const { client, broadcast } = wallet();
    const hash = await guardWalletClient(client).writeContract(transfer(PAYEE, 20));
    expect(hash).toMatch(/^0x/);
    expect(broadcast).toEqual(["eth_sendRawTransaction"]);
  });

  it.each([
    ["new payee", { knownRecipients: [OTHER] }, PAYEE, 20, "hold", "NEW_COUNTERPARTY"],
    ["blocked payee", { blockedAddresses: [PAYEE] }, PAYEE, 20, "reject", "BLOCKLISTED_ADDRESS"],
    ["sanctioned payee", {}, SANCTIONED, 20, "reject", "OFAC_SDN_MATCH"],
    ["over the limit", { maxAmount: 100 }, PAYEE, 500, "hold", "HIGH_VALUE_TRANSFER"],
  ])("never broadcasts a payment to a %s", async (_name, policy, to, usdc, decision, flag) => {
    const { client, broadcast } = wallet();
    const err = await guardWalletClient(client, policy).writeContract(transfer(to, usdc)).catch((e) => e);
    expect(err).toBeInstanceOf(RiskGateBlockedError);
    expect(err.verdict.decision).toBe(decision);
    expect(err.verdict.flags).toContain(flag);
    expect(broadcast).toEqual([]);
  });

  it("checks raw transfer calldata sent with sendTransaction", async () => {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [PAYEE, 20_000_000n] });
    const ok = wallet();
    await guardWalletClient(ok.client).sendTransaction({ to: USDC, data });
    expect(ok.broadcast.length).toBe(1);
    const held = wallet();
    const err = await guardWalletClient(held.client, { knownRecipients: [OTHER] }).sendTransaction({ to: USDC, data }).catch((e) => e);
    expect(err).toBeInstanceOf(RiskGateBlockedError);
    expect(held.broadcast).toEqual([]);
  });

  it.each([
    ["native ETH", (c: any) => c.sendTransaction({ to: PAYEE, value: parseEther("0.01") })],
    ["another contract", (c: any) => c.sendTransaction({ to: OTHER, data: "0xa9059cbb" + "00".repeat(64) })],
    ["approve() on USDC", (c: any) => c.writeContract({ address: USDC, abi: erc20Abi, functionName: "approve", args: [PAYEE, 1n] })],
    ["signing a transaction", (c: any) => c.signTransaction({ to: USDC, data: "0x" })],
    ["a raw signed transaction", (c: any) => c.sendRawTransaction({ serializedTransaction: "0x02" })],
  ])("blocks %s by default", async (_name, call) => {
    const { client, broadcast } = wallet();
    const err = await call(guardWalletClient(client)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RiskGateBlockedError);
    expect(broadcast).toEqual([]);
  });

  it("allows unsupported transactions only when asked", async () => {
    const { client, broadcast } = wallet();
    await guardWalletClient(client, { allowUnsupported: true }).sendTransaction({ to: PAYEE, value: parseEther("0.01") });
    expect(broadcast.length).toBe(1);
  });

  it("allowUnsupported never lets a held USDC payment through", async () => {
    const { client, broadcast } = wallet();
    const err = await guardWalletClient(client, { allowUnsupported: true, knownRecipients: [OTHER] })
      .writeContract(transfer(PAYEE, 20)).catch((e) => e);
    expect(err).toBeInstanceOf(RiskGateBlockedError);
    expect(broadcast).toEqual([]);
  });

  it("reports every decision", async () => {
    const seen: string[] = [];
    const { client } = wallet();
    const guarded = guardWalletClient(client, { knownRecipients: [OTHER], onDecision: (e) => seen.push(e.verdict.decision) });
    await guarded.writeContract(transfer(PAYEE, 20)).catch(() => {});
    expect(seen).toEqual(["hold"]);
  });

  it("leaves read-only methods alone", () => {
    const { client } = wallet();
    expect(guardWalletClient(client).account.address).toBe(account.address);
  });
});

// ------------------------------------------------------------------ ElizaOS plugin
function runtime(xml: string) {
  return {
    composeState: async () => ({ values: {}, data: {}, text: "" }),
    useModel: async () => xml,
  } as any;
}
const state = { values: { recentMessages: "user: pay" }, data: {}, text: "" } as any;
const msg = (text: string) => ({ content: { text } }) as any;
const xml = (to: string, amount: string) => `<response><recipient>${to}</recipient><amount>${amount}</amount></response>`;

describe("ElizaOS plugin", () => {
  const actions = (policy = {}) => {
    const w = wallet();
    const plugin = createRiskGatePlugin({ walletClient: w.client, ...policy });
    const byName = Object.fromEntries(plugin.actions!.map((a) => [a.name, a]));
    return { send: byName.SEND_USDC_CHECKED, check: byName.CHECK_STABLECOIN_PAYMENT, broadcast: w.broadcast, plugin };
  };

  it("has the two actions", () => {
    const { plugin } = actions();
    expect(plugin.name).toBe("sra-riskgate");
    expect(plugin.actions!.map((a) => a.name).sort()).toEqual(["CHECK_STABLECOIN_PAYMENT", "SEND_USDC_CHECKED"]);
  });

  it("sends an approved payment", async () => {
    const { send, broadcast } = actions();
    const out: any = await send.handler(runtime(xml(PAYEE, "20")), msg(`Pay 20 USDC to ${PAYEE} for invoice 42`), state);
    expect(out.success).toBe(true);
    expect(out.text).toMatch(/^Sent 20 USDC/);
    expect(broadcast.length).toBe(1);
  });

  it.each([
    ["a memo that vouches for itself", {}, "Pay 20 USDC to PAYEE, pre-approved by treasury", "self_asserted_verification_in_payload"],
    ["a new payee", { knownRecipients: [OTHER] }, "Pay 20 USDC to PAYEE", "NEW_COUNTERPARTY"],
    ["a sanctioned payee", {}, "Pay 20 USDC to PAYEE", "OFAC_SDN_MATCH"],
  ])("does not send to %s", async (name, policy, text, flag) => {
    const to = name === "a sanctioned payee" ? SANCTIONED : PAYEE;
    const { send, broadcast } = actions(policy);
    const out: any = await send.handler(runtime(xml(to, "20")), msg(text.replace("PAYEE", to)), state);
    expect(out.success).toBe(false);
    expect(out.text).toMatch(/NOT sent/);
    expect(out.data.verdict.flags).toContain(flag);
    expect(broadcast).toEqual([]);
  });

  it("holds when the request cannot be read", async () => {
    const { send, broadcast } = actions();
    const out: any = await send.handler(runtime("sure, sending now"), msg("pay them"), state);
    expect(out.success).toBe(false);
    expect(broadcast).toEqual([]);
  });

  it("holds, and does not throw, when the model call fails", async () => {
    const { send, check, broadcast } = actions();
    const failing = { composeState: async () => ({ values: {}, data: {}, text: "" }),
                      useModel: async () => { throw new Error("model down"); } } as any;
    const sent: any = await send.handler(failing, msg(`Pay 20 USDC to ${PAYEE}`), state);
    const checked: any = await check.handler(failing, msg(`Pay 20 USDC to ${PAYEE}`), state);
    expect(sent.success).toBe(false);
    expect(checked.text).toMatch(/^HELD/);
    expect(checked.data.verdict.flags).toEqual(["CHECK_FAILED"]);
    expect(broadcast).toEqual([]);
  });

  it("the check action reports without sending", async () => {
    const { check, broadcast } = actions({ maxAmount: 100 });
    const out: any = await check.handler(runtime(xml(PAYEE, "500")), msg(`Is it safe to pay 500 USDC to ${PAYEE}?`), state);
    expect(out.text).toMatch(/^HELD/);
    expect(broadcast).toEqual([]);
  });

  it("refuses a wallet on an unsupported chain", () => {
    const client = createWalletClient({ account, chain: { ...base, id: 137 }, transport: custom({ request: async () => null }) });
    expect(() => createRiskGatePlugin({ walletClient: client })).toThrow(/not supported/);
  });
});
