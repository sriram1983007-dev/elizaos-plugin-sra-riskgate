/**
 * Enforce SRA-RiskGate at the wallet: every transaction is checked right before it is broadcast.
 *
 * Wrap the viem wallet client your agent signs with. A USDC `transfer` (via `sendTransaction` calldata
 * or `writeContract`) is decoded and checked; it is only sent on `approve`. Everything else the wallet
 * could do (native ETH transfers, other contract calls, raw or pre-signed transactions, signing) is
 * blocked unless you opt in, so nothing reaches the chain unchecked by accident.
 */
import { checkPayment, isUsdc, type Policy, type Verdict } from "./checks.js";

export class RiskGateBlockedError extends Error {
  constructor(public readonly verdict: Verdict) {
    super(`${verdict.decision === "reject" ? "BLOCKED" : "HELD for human review"}: ${verdict.explanation} Flags: ${verdict.flags.join(", ")}. Transaction NOT sent.`);
    this.name = "RiskGateBlockedError";
  }
}

export interface GuardOptions extends Policy {
  /** Allow transactions that are not USDC transfers (native ETH, swaps, other contracts). Default false. */
  allowUnsupported?: boolean;
  /** Called with every decision, for logging or audit. */
  onDecision?: (event: { method: string; verdict: Verdict; payment?: DecodedPayment }) => void;
}

export interface DecodedPayment { chainId: number; sender: string; recipient: string; amount: number }

const TRANSFER = "a9059cbb";

/** Recipient and whole-USDC amount from ERC-20 transfer calldata, or null if it is something else. */
export function decodeTransferCalldata(data: unknown): { recipient: string; atomic: bigint } | null {
  if (typeof data !== "string") return null;
  const h = data.toLowerCase().replace(/^0x/, "");
  if (h.length !== 8 + 64 + 64 || !/^[0-9a-f]+$/.test(h) || h.slice(0, 8) !== TRANSFER) return null;
  if (h.slice(8, 32) !== "0".repeat(24)) return null;
  return { recipient: "0x" + h.slice(32, 72), atomic: BigInt("0x" + h.slice(72)) };
}

function toUsdc(atomic: bigint): number {
  const s = atomic.toString().padStart(7, "0");
  return Number(`${s.slice(0, -6)}.${s.slice(-6)}`);
}

function accountAddress(client: any, args: any): string | undefined {
  const a = args?.account ?? client?.account;
  return typeof a === "string" ? a : a?.address;
}

function held(reason: string): Verdict {
  return { decision: "hold", riskScore: 0.65, flags: ["CHECK_FAILED"], explanation: reason, requiredActions: ["manual_review"] };
}

/** The payment a transaction would make, or a reason it cannot be checked. */
function decode(method: string, client: any, args: any): DecodedPayment | string {
  const chainId: number | undefined = args?.chain?.id ?? client?.chain?.id;
  const sender = accountAddress(client, args);
  if (typeof chainId !== "number") return "the wallet has no chain set";
  if (!sender) return "the wallet has no account set";
  if (method === "sendTransaction") {
    if (args?.value !== undefined && BigInt(args.value) !== 0n) return "native-token transfers are not checked";
    if (!isUsdc(chainId, args?.to)) return `only USDC transfers are checked; this transaction goes to ${args?.to}`;
    const t = decodeTransferCalldata(args?.data);
    if (!t) return "the calldata is not an ERC-20 transfer";
    return { chainId, sender, recipient: t.recipient, amount: toUsdc(t.atomic) };
  }
  if (method === "writeContract") {
    if (!isUsdc(chainId, args?.address)) return `only USDC transfers are checked; this call goes to ${args?.address}`;
    if (args?.functionName !== "transfer" || !Array.isArray(args?.args) || args.args.length !== 2) {
      return `only USDC transfer() is checked; got ${String(args?.functionName)}()`;
    }
    if (args?.value !== undefined && BigInt(args.value) !== 0n) return "a USDC transfer must not carry native value";
    return { chainId, sender, recipient: String(args.args[0]), amount: toUsdc(BigInt(args.args[1])) };
  }
  return `${method} cannot be checked`;
}

const GUARDED = new Set(["sendTransaction", "writeContract", "sendRawTransaction", "signTransaction",
  "sendCalls", "deployContract"]);

/** Check a transaction without sending it. */
export function checkTransaction(client: any, method: string, args: any, options: GuardOptions = {}): Verdict {
  let payment: DecodedPayment | string;
  try {
    payment = decode(method, client, args);
  } catch (e) {
    payment = `the transaction could not be read (${(e as Error).message})`;
  }
  const verdict = typeof payment === "string"
    ? held(`SRA-RiskGate cannot check this transaction: ${payment}.`)
    : checkPayment({ chainId: payment.chainId, sender: payment.sender, recipient: payment.recipient, amount: payment.amount }, options);
  options.onDecision?.({ method, verdict, payment: typeof payment === "string" ? undefined : payment });
  return verdict;
}

/**
 * Wrap a viem WalletClient so every transaction is checked before it is broadcast. Held or rejected
 * transactions throw RiskGateBlockedError and are never sent. Give your agent only the wrapped client.
 */
export function guardWalletClient<T extends object>(client: T, options: GuardOptions = {}): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string" || !GUARDED.has(prop) || typeof value !== "function") return value;
      return async (args: any, ...rest: unknown[]) => {
        const verdict = checkTransaction(target, prop, args, options);
        const unsupported = verdict.flags.length === 1 && verdict.flags[0] === "CHECK_FAILED" && verdict.explanation.startsWith("SRA-RiskGate cannot check");
        if (verdict.decision !== "approve" && !(unsupported && options.allowUnsupported)) {
          throw new RiskGateBlockedError(verdict);
        }
        return (value as Function).call(target, args, ...rest);
      };
    },
  });
}
