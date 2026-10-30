import { describe, expect, it } from "vitest";
import { createWalletClient, custom, erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { findLookalike, guardWalletClient, RiskGateBlockedError, USDC_ADDRESSES } from "../src/index.js";

const PAYEE = "0x2ffb88f73980bc6069c598487396e1e472deb7ee";
const FAKE = ("0x2ffb" + "0".repeat(32) + "b7ee") as `0x${string}`;
const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

describe("address poisoning (0.4.0)", () => {
  it("names the payee a look-alike imitates", () => {
    expect(findLookalike(FAKE, new Set([PAYEE]))).toEqual([PAYEE, 4, 4]);
    expect(findLookalike(PAYEE, new Set([PAYEE]))).toBeNull();
    expect(findLookalike(FAKE, null)).toBeNull();
  });

  it("the wallet guard never broadcasts a payment to a look-alike, even with allowUnsupported", async () => {
    const reached: string[] = [];
    const transport = custom({ async request({ method }: { method: string }) { if (method === "eth_getCode") return "0x"; reached.push(method); throw new Error(method); } });
    const client = createWalletClient({ account, chain: base, transport });
    const err = await guardWalletClient(client, { knownRecipients: [PAYEE], allowUnsupported: true })
      .writeContract({ address: USDC_ADDRESSES[8453] as `0x${string}`, abi: erc20Abi, functionName: "transfer", args: [FAKE, 1_000_000n] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RiskGateBlockedError);
    expect((err as RiskGateBlockedError).verdict.decision).toBe("reject");
    expect((err as RiskGateBlockedError).verdict.flags).toEqual(["LOOKALIKE_RECIPIENT"]);
    expect(reached).toEqual([]);
  });
});
