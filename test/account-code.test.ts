import { describe, expect, it } from "vitest";
import { createWalletClient, custom, erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { checkAccountCode, delegateFromCode, guardWalletClient, RiskGateBlockedError, USDC_ADDRESSES } from "../src/index.js";

const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const USDC = USDC_ADDRESSES[8453] as `0x${string}`;
const PAYEE = "0x2ffb88f73980bc6069c598487396e1e472deb7ee" as const;
const DELEGATE = "0x" + "d".repeat(40);
const DESIGNATOR = "0xef0100" + "d".repeat(40);

/** A wallet whose account code is `code` (or whose getCode fails), recording anything else that reaches the RPC. */
function wallet(code: string | Error) {
  const reached: string[] = [];
  const seen: string[] = [];
  const transport = custom({
    async request({ method, params }: { method: string; params?: any }) {
      if (method === "eth_getCode") {
        seen.push(String(params?.[0]).toLowerCase());
        if (code instanceof Error) throw code;
        return code;
      }
      reached.push(method);
      throw new Error(`RPC ${method} must not be reached`);
    },
  });
  return { client: createWalletClient({ account, chain: base, transport }), reached, seen };
}

const transfer = { address: USDC, abi: erc20Abi, functionName: "transfer" as const, args: [PAYEE, 1_000_000n] as const };

describe("already-delegated accounts (0.5.0)", () => {
  it("reads the designator", () => {
    expect(delegateFromCode(DESIGNATOR)).toBe(DELEGATE);
    expect(delegateFromCode(DESIGNATOR + "00")).toBeNull();
    expect(checkAccountCode("0x")).toBeNull();
    expect(checkAccountCode("0x6080604052")).toBeNull();
    expect(checkAccountCode(DESIGNATOR)?.flags).toEqual(["ACCOUNT_DELEGATED"]);
    expect(checkAccountCode(DESIGNATOR, [DELEGATE])).toBeNull();
    expect(checkAccountCode("0xzz")?.flags).toEqual(["INVALID_ACCOUNT_CODE"]);
  });

  it.each([
    ["a USDC transfer", (c: any) => c.writeContract(transfer)],
    ["a native send", (c: any) => c.sendTransaction({ to: PAYEE, value: 1n })],
    ["a message signature", (c: any) => c.signMessage({ message: "login" })],
  ])("stops %s from a delegated account, even with allowUnsupported", async (_name, call) => {
    const { client, reached, seen } = wallet(DESIGNATOR);
    const err = await call(guardWalletClient(client, { allowUnsupported: true })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RiskGateBlockedError);
    expect((err as RiskGateBlockedError).verdict.flags).toEqual(["ACCOUNT_DELEGATED"]);
    expect((err as RiskGateBlockedError).verdict.explanation).toContain(DELEGATE);
    expect(reached).toEqual([]);
    expect(seen).toEqual([account.address.toLowerCase()]);  // it read its own account's code
  });

  it("lets an expected delegate through", async () => {
    const { client } = wallet(DESIGNATOR);
    const sig = await guardWalletClient(client, { expectedDelegates: [DELEGATE], allowUnsupported: true })
      .signMessage({ message: "login" } as any);
    expect(sig).toMatch(/^0x/);
  });

  it("holds when the code cannot be read, unless the check is turned off", async () => {
    const { client } = wallet(new Error("rpc down"));
    const err = await guardWalletClient(client, { allowUnsupported: true }).signMessage({ message: "x" } as any).catch((e: unknown) => e);
    expect((err as RiskGateBlockedError).verdict.flags).toEqual(["ACCOUNT_CODE_UNREADABLE"]);
    const sig = await guardWalletClient(client, { allowUnsupported: true, checkAccountCode: false }).signMessage({ message: "x" } as any);
    expect(sig).toMatch(/^0x/);
  });
});
