import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createWalletClient, custom, erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { checkAuthorization, checkTransaction, guardWalletClient, RiskGateBlockedError, USDC_ADDRESSES } from "../src/index.js";

const vectors = JSON.parse(readFileSync(new URL("./auth_vectors.json", import.meta.url), "utf8"));

describe("typed-data parity with the Python sra-riskgate SDK", () => {
  it.each(vectors.cases.map((c: any, i: number) => [i, c]))("case %i", (_i, c: any) => {
    const r = checkAuthorization(c.typed_data, { ...c.options, nowSeconds: vectors.now });
    expect({ decision: r.decision, flags: r.flags, risk_score: r.riskScore }).toEqual(c.expected);
  });
});

const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const USDC = USDC_ADDRESSES[8453] as `0x${string}`;
const PAYEE = "0x2ffb88f73980bc6069c598487396e1e472deb7ee" as const;
const SPENDER = ("0x" + "c".repeat(40)) as `0x${string}`;
const now = () => Math.floor(Date.now() / 1000);

function wallet() {
  const reached: string[] = [];
  const transport = custom({ async request({ method }: { method: string }) { reached.push(method); throw new Error(`RPC ${method}`); } });
  return { client: createWalletClient({ account, chain: base, transport }), reached };
}

const authTypes = { TransferWithAuthorization: [
  { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] } as const;

const x402 = (validFor = 300, to: `0x${string}` = PAYEE) => ({
  domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC },
  types: authTypes, primaryType: "TransferWithAuthorization" as const,
  message: { from: account.address, to, value: 250_000n, validAfter: BigInt(now() - 600),
             validBefore: BigInt(now() + validFor), nonce: ("0x" + "ab".repeat(32)) as `0x${string}` },
});

const permit = (domainName = "USD Coin") => ({
  domain: { name: domainName, version: "2", chainId: 8453, verifyingContract: USDC },
  types: { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" },
    { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
  primaryType: "Permit" as const,
  message: { owner: account.address, spender: SPENDER, value: 2n ** 256n - 1n, nonce: 0n, deadline: 2n ** 40n },
});

describe("guardWalletClient: signTypedData and signMessage", () => {
  it("signs an approved x402 authorization (a real viem signature)", async () => {
    const { client } = wallet();
    const sig = await guardWalletClient(client, { pegDeviationPct: 0.1 } as any).signTypedData(x402() as any);
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it.each([
    ["an unlimited USDC permit", () => permit(), ["TOKEN_APPROVAL", "UNLIMITED_APPROVAL"]],
    ["a permit for another token", () => ({ ...permit("Other"), domain: { ...permit().domain, name: "Other", verifyingContract: SPENDER } }), ["TOKEN_APPROVAL", "UNLIMITED_APPROVAL"]],
    ["a Permit2 permit", () => ({ domain: { name: "Permit2", chainId: 8453, verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3" },
      types: { PermitSingle: [{ name: "spender", type: "address" }, { name: "sigDeadline", type: "uint256" }] },
      primaryType: "PermitSingle", message: { spender: SPENDER, sigDeadline: 2n ** 40n } }), ["TOKEN_APPROVAL"]],
    ["a long-lived authorization", () => x402(86_400), ["LONG_LIVED_AUTHORIZATION"]],
  ])("holds %s, even with allowUnsupported", async (_name, make, flags) => {
    for (const options of [{}, { allowUnsupported: true }]) {
      const { client, reached } = wallet();
      const err = await guardWalletClient(client, options).signTypedData(make() as any).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RiskGateBlockedError);
      expect((err as RiskGateBlockedError).verdict.flags).toEqual(flags);
      expect(reached).toEqual([]);
    }
  });

  it("runs the payment checks on the decoded authorization", () => {
    const v = checkTransaction({ account, chain: base }, "signTypedData", x402(300, SPENDER), { knownRecipients: [PAYEE] });
    expect(v.flags).toContain("NEW_COUNTERPARTY");
  });

  it("holds typed data it cannot judge, unless allowUnsupported", async () => {
    const order = { domain: { name: "Exchange", version: "1", chainId: 8453, verifyingContract: SPENDER },
      types: { Order: [{ name: "id", type: "uint256" }] }, primaryType: "Order", message: { id: 1n } };
    const { client } = wallet();
    const err = await guardWalletClient(client).signTypedData(order as any).catch((e: unknown) => e);
    expect((err as RiskGateBlockedError).verdict.flags).toEqual(["CHECK_FAILED"]);
    const sig = await guardWalletClient(client, { allowUnsupported: true }).signTypedData(order as any);
    expect(sig).toMatch(/^0x/);
  });

  it("holds signMessage unless allowUnsupported", async () => {
    const { client } = wallet();
    const err = await guardWalletClient(client).signMessage({ message: "login" } as any).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RiskGateBlockedError);
    const sig = await guardWalletClient(client, { allowUnsupported: true }).signMessage({ message: "login" } as any);
    expect(sig).toMatch(/^0x/);
  });

  it("does not affect ordinary transfers", () => {
    const v = checkTransaction({ account, chain: base }, "writeContract",
      { address: USDC, abi: erc20Abi, functionName: "transfer", args: [PAYEE, 1_000_000n] });
    expect(v.decision).toBe("approve");
  });
});
