import { describe, expect, it } from "vitest";
import { createWalletClient, custom, erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { checkTransaction, delegationHold, guardWalletClient, RiskGateBlockedError, USDC_ADDRESSES } from "../src/index.js";

const USDC = USDC_ADDRESSES[8453] as `0x${string}`;
const PAYEE = "0x2ffb88f73980bc6069c598487396e1e472deb7ee" as const;
const DELEGATE = ("0x" + "d".repeat(40)) as `0x${string}`;
const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const auth = (chainId: number) => ({ contractAddress: DELEGATE, address: DELEGATE, chainId, nonce: 0, r: "0x1", s: "0x1", yParity: 0 });

function wallet() {
  const reached: string[] = [];
  const transport = custom({ async request({ method }: { method: string }) { if (method === "eth_getCode") return "0x"; reached.push(method); throw new Error(`RPC ${method} must not be reached`); } });
  const client: any = createWalletClient({ account, chain: base, transport });
  // viem >= 2.22 has signAuthorization as a wallet action; stand one in so the guard is exercised either way.
  client.signAuthorization = async () => { reached.push("signAuthorization"); return auth(0); };
  return { client, reached };
}

const transfer = { address: USDC, abi: erc20Abi, functionName: "transfer" as const, args: [PAYEE, 20_000_000n] as const };

describe("EIP-7702 code delegation", () => {
  it.each([
    ["sendTransaction with an authorizationList", (c: any) => c.sendTransaction({ to: PAYEE, authorizationList: [auth(8453)] })],
    ["an approvable USDC transfer carrying an authorizationList", (c: any) => c.writeContract({ ...transfer, authorizationList: [auth(0)] })],
    ["a transaction marked type eip7702", (c: any) => c.sendTransaction({ to: PAYEE, type: "eip7702" })],
    ["signing a type-4 transaction", (c: any) => c.signTransaction({ to: PAYEE, authorizationList: [auth(8453)] })],
    ["a raw signed type-4 transaction", (c: any) => c.sendRawTransaction({ serializedTransaction: "0x04f8" })],
    ["signAuthorization", (c: any) => c.signAuthorization({ contractAddress: DELEGATE, chainId: 0 })],
  ])("holds %s, even with allowUnsupported", async (_name, call) => {
    for (const options of [{}, { allowUnsupported: true }]) {
      const { client, reached } = wallet();
      const err = await call(guardWalletClient(client, options)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RiskGateBlockedError);
      expect((err as RiskGateBlockedError).verdict.flags).toEqual(["CODE_DELEGATION"]);
      expect(reached).toEqual([]);
    }
  });

  it("names the delegate contract and chain-id-0 scope", () => {
    const v = checkTransaction({ account, chain: base }, "signAuthorization", { contractAddress: DELEGATE, chainId: 0 });
    expect(v.decision).toBe("hold");
    expect(v.explanation).toContain(DELEGATE);
    expect(v.explanation).toContain("every chain");
  });

  it("does not flag ordinary transactions", () => {
    expect(delegationHold("writeContract", transfer)).toBeNull();
    expect(delegationHold("sendTransaction", { to: PAYEE, authorizationList: [] })).toBeNull();
    expect(delegationHold("sendRawTransaction", { serializedTransaction: "0x02f8" })).toBeNull();
    expect(checkTransaction({ account, chain: base }, "writeContract", transfer).decision).toBe("approve");
  });
});
