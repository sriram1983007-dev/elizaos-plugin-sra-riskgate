import { describe, expect, it } from "vitest";
import { createWalletClient, custom, encodeFunctionData, erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { checkTransaction, guardWalletClient, RiskGateBlockedError, USDC_ADDRESSES } from "../src/index.js";
import { BUNDLED_SANCTIONS } from "../src/sanctions-data.js";

const USDC = USDC_ADDRESSES[8453] as `0x${string}`;
const PAYEE = "0x2ffb88f73980bc6069c598487396e1e472deb7ee" as const;
const PAYEE2 = ("0x" + "e".repeat(40)) as `0x${string}`;
const OTHER = ("0x" + "c".repeat(40)) as `0x${string}`;
const SANCTIONED = BUNDLED_SANCTIONS[0] as `0x${string}`;
const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

const raw = (to: string, usdc: number) => ({
  to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to as `0x${string}`, BigInt(Math.round(usdc * 1e6))] }),
});
const abiCall = (to: string, usdc: number) => ({
  to: USDC, abi: erc20Abi, functionName: "transfer" as const, args: [to as `0x${string}`, BigInt(Math.round(usdc * 1e6))] as const,
});

function wallet() {
  const sent: unknown[] = [];
  const transport = custom({ async request({ method }: { method: string }) { throw new Error(`RPC ${method} must not be reached`); } });
  const client: any = createWalletClient({ account, chain: base, transport });
  // sendCalls (EIP-5792) is a wallet action in newer viem; stand one in so the guard is exercised either way.
  client.sendCalls = async (args: unknown) => { sent.push(args); return { id: "0x01" }; };
  return { client, sent };
}

async function send(calls: unknown[], options = {}) {
  const { client, sent } = wallet();
  const err = await guardWalletClient(client, options).sendCalls({ calls }).catch((e: unknown) => e);
  return { err: err as RiskGateBlockedError | { id: string }, sent };
}

describe("sendCalls batches", () => {
  it("sends a batch of approved USDC transfers, raw or ABI-encoded", async () => {
    const { err, sent } = await send([raw(PAYEE, 5), abiCall(PAYEE2, 2.5)]);
    expect(err).toEqual({ id: "0x01" });
    expect(sent.length).toBe(1);
  });

  it("explains an approved batch", () => {
    const v = checkTransaction({ account, chain: base }, "sendCalls", { calls: [raw(PAYEE, 5), raw(PAYEE2, 2.5)] });
    expect(v.decision).toBe("approve");
    expect(v.explanation).toContain("7.5 USDC to 2 payees");
  });

  it.each([
    ["a sanctioned payee", [raw(PAYEE, 1), raw(SANCTIONED, 1)], {}, "reject", "OFAC_SDN_MATCH"],
    ["a payee over the limit", [raw(PAYEE, 1), raw(PAYEE2, 20)], { maxAmount: 10 }, "hold", "HIGH_VALUE_TRANSFER"],
    ["an unknown payee", [raw(PAYEE, 1), raw(OTHER, 1)], { knownRecipients: [PAYEE] }, "hold", "NEW_COUNTERPARTY"],
  ])("blocks a batch with %s", async (_name, calls, options, decision, flag) => {
    const { err, sent } = await send(calls, options);
    expect(err).toBeInstanceOf(RiskGateBlockedError);
    expect((err as RiskGateBlockedError).verdict.decision).toBe(decision);
    expect((err as RiskGateBlockedError).verdict.flags).toContain(flag);
    expect(sent).toEqual([]);
  });

  it("adds up payments to one payee, so a large payment cannot be split", async () => {
    const calls = Array.from({ length: 5 }, () => raw(PAYEE, 3));
    const { err, sent } = await send(calls, { maxAmount: 10 });
    expect((err as RiskGateBlockedError).verdict.flags).toContain("HIGH_VALUE_TRANSFER");
    expect((err as RiskGateBlockedError).verdict.explanation).toContain("15");
    expect(sent).toEqual([]);
  });

  it("holds a batch whose total is over the limit, even when each payee is under it", async () => {
    const { err, sent } = await send([raw(PAYEE, 6), raw(PAYEE2, 6)], { maxAmount: 10 });
    expect((err as RiskGateBlockedError).verdict.flags).toEqual(["HIGH_VALUE_TRANSFER"]);
    expect(sent).toEqual([]);
  });

  it("blocks a batch with any call that is not a USDC transfer, and names it", async () => {
    const approve = { to: USDC, abi: erc20Abi, functionName: "approve" as const, args: [OTHER, 2n ** 256n - 1n] as const };
    const { err, sent } = await send([raw(PAYEE, 1), approve]);
    expect((err as RiskGateBlockedError).verdict.flags).toEqual(["CHECK_FAILED"]);
    expect((err as RiskGateBlockedError).verdict.explanation).toContain("call 2 of 2");
    expect(sent).toEqual([]);
  });

  it("allowUnsupported lets other calls through but still checks the USDC transfers in the batch", async () => {
    const other = { to: OTHER, data: "0x12345678" };
    const ok = await send([raw(PAYEE, 1), other], { allowUnsupported: true });
    expect(ok.sent.length).toBe(1);
    const bad = await send([raw(SANCTIONED, 1), other], { allowUnsupported: true });
    expect((bad.err as RiskGateBlockedError).verdict.decision).toBe("reject");
    expect(bad.sent).toEqual([]);
  });

  it.each([[[]], [undefined]])("holds an empty or missing batch (%j)", async (calls) => {
    const { client, sent } = wallet();
    const err = await guardWalletClient(client).sendCalls({ calls }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RiskGateBlockedError);
    expect(sent).toEqual([]);
  });

  it("holds a batch call carrying native value", async () => {
    const { err } = await send([{ ...raw(PAYEE, 1), value: 1n }]);
    expect((err as RiskGateBlockedError).verdict.flags).toEqual(["CHECK_FAILED"]);
  });

  it("reports every payment in the batch", () => {
    const seen: number[] = [];
    checkTransaction({ account, chain: base }, "sendCalls", { calls: [raw(PAYEE, 1), raw(PAYEE2, 2)] },
      { onDecision: (e) => seen.push(e.payments?.length ?? -1) });
    expect(seen).toEqual([2]);
  });
});
