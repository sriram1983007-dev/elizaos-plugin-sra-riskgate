/**
 * Enforce SRA-RiskGate at the wallet: every transaction is checked right before it is broadcast.
 *
 * Wrap the viem wallet client your agent signs with. A USDC `transfer` (via `sendTransaction` calldata
 * or `writeContract`) is decoded and checked; it is only sent on `approve`. Everything else the wallet
 * could do (native ETH transfers, other contract calls, raw or pre-signed transactions, signing) is
 * blocked unless you opt in, so nothing reaches the chain unchecked by accident.
 *
 * A `sendCalls` batch (EIP-5792) is checked call by call: it is sent only if every call is a USDC transfer
 * and every payee's total, and the batch total, pass the checks.
 *
 * Typed-data signatures (`signTypedData`) are checked too: a USDC x402 authorization (EIP-3009, or Circle
 * Gateway's batched form) gets the payment checks and a validity limit, and any permit (EIP-2612 or Permit2)
 * is held as a token approval, even with `allowUnsupported`. Other typed data and `signMessage` are blocked
 * unless you opt in with `allowUnsupported`.
 *
 * EIP-7702 code delegation (an `authorizationList`, a type-4 transaction, or `signAuthorization`) hands
 * control of the account to contract code, so it is always held, even with `allowUnsupported`.
 */
import { checkAccountCode, checkPayment, isUsdc, type Policy, type Verdict } from "./checks.js";
import { checkAuthorization, isApprovalSignature } from "./authorization.js";

export class RiskGateBlockedError extends Error {
  constructor(public readonly verdict: Verdict) {
    super(`${verdict.decision === "reject" ? "BLOCKED" : "HELD for human review"}: ${verdict.explanation} Flags: ${verdict.flags.join(", ")}. Transaction NOT sent.`);
    this.name = "RiskGateBlockedError";
  }
}

export interface GuardOptions extends Policy {
  /** Allow transactions that are not USDC transfers (native ETH, swaps, other contracts). Default false. */
  allowUnsupported?: boolean;
  /** Longest an x402 authorization may stay valid before it is held. Default 3600 seconds. */
  maxValiditySeconds?: number;
  /** The same for Circle Gateway batched payments. Default 8 days. */
  maxGatewayValiditySeconds?: number;
  /**
   * Read the account's own code (eth_getCode) before every guarded call, and stop if it is delegated under
   * EIP-7702 to a contract not in `expectedDelegates` (ACCOUNT_DELEGATED). Default true.
   */
  checkAccountCode?: boolean;
  /** Called with every decision, for logging or audit. */
  onDecision?: (event: { method: string; verdict: Verdict; payment?: DecodedPayment; payments?: DecodedPayment[] }) => void;
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

const DELEGATION_METHODS = new Set(["signAuthorization", "experimental_signAuthorization"]);

function isType4(tx: any): boolean {
  const t = tx?.type;
  if (t === "eip7702" || t === 4 || t === 4n) return true;
  return typeof t === "string" && ["4", "0x4", "0x04"].includes(t.trim().toLowerCase());
}

function describeAuthorization(auth: any): string {
  const target = auth?.contractAddress ?? auth?.address;
  const chain = auth?.chainId;
  const where = chain === 0 || chain === 0n || chain === "0x0" ? "on every chain (chain id 0)" : chain !== undefined ? `on chain ${String(chain)}` : "";
  return [target ? `to contract ${String(target)}` : "", where].filter(Boolean).join(" ");
}

/** A hold for EIP-7702 code delegation, or null if the call does not delegate the account. */
export function delegationHold(method: string, args: any): Verdict | null {
  let detail: string | null = null;
  if (DELEGATION_METHODS.has(method)) {
    detail = `signing an EIP-7702 authorization ${describeAuthorization(args)}`.trim();
  } else if (method === "sendRawTransaction") {
    const raw = args?.serializedTransaction;
    if (typeof raw === "string" && raw.toLowerCase().startsWith("0x04")) detail = "a signed type-4 (EIP-7702) transaction";
  } else {
    const list = args?.authorizationList;
    if ((Array.isArray(list) && list.length > 0) || (list !== undefined && !Array.isArray(list)) || isType4(args)) {
      const parts = Array.isArray(list) ? list.map(describeAuthorization).filter(Boolean) : [];
      detail = `a transaction carrying an EIP-7702 authorizationList${parts.length ? ` (delegates ${parts.join("; ")})` : ""}`;
    }
  }
  if (!detail) return null;
  return {
    decision: "hold", riskScore: 0.95, flags: ["CODE_DELEGATION"],
    explanation: `SRA-RiskGate holds ${detail}: it lets contract code control every asset in the account, not one payment.`,
    requiredActions: ["manual_review"],
  };
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

const RANK: Record<string, number> = { approve: 0, hold: 1, reject: 2 };
const atomic = (usdc: number) => BigInt(Math.round(usdc * 1e6));

/**
 * Check a sendCalls batch: every call must be a USDC transfer. Payments are grouped by payee so a large payment
 * cannot be split into small ones, and the batch total must stay within maxAmount.
 */
function checkBatch(client: any, args: any, options: GuardOptions): { verdict: Verdict; payments?: DecodedPayment[] } {
  const calls = args?.calls;
  if (!Array.isArray(calls) || calls.length === 0) {
    return { verdict: held("SRA-RiskGate cannot check this transaction: the sendCalls batch has no calls.") };
  }
  const payments: DecodedPayment[] = [];
  const unsupported: string[] = [];
  calls.forEach((c: any, i: number) => {
    const base = { account: args?.account, chain: args?.chain };
    let r: DecodedPayment | string;
    try {
      r = c?.abi !== undefined || c?.functionName !== undefined
        ? decode("writeContract", client, { ...base, ...c, address: c?.address ?? c?.to })
        : decode("sendTransaction", client, { ...base, ...c });
    } catch (e) {
      r = `it could not be read (${(e as Error).message})`;
    }
    if (typeof r === "string") unsupported.push(`call ${i + 1} of ${calls.length}: ${r}`);
    else payments.push(r);
  });

  // Every payee's total goes through the full checks; the worst verdict wins.
  const byPayee = new Map<string, DecodedPayment>();
  for (const p of payments) {
    const key = p.recipient.toLowerCase();
    const prev = byPayee.get(key);
    byPayee.set(key, prev ? { ...prev, amount: Number(atomic(prev.amount) + atomic(p.amount)) / 1e6 } : { ...p });
  }
  let worst: Verdict | null = null;
  for (const p of byPayee.values()) {
    const v = checkPayment({ chainId: p.chainId, sender: p.sender, recipient: p.recipient, amount: p.amount }, options);
    if (!worst || RANK[v.decision] > RANK[worst.decision]) worst = v;
  }
  if (worst && worst.decision !== "approve") {
    return { verdict: { ...worst, explanation: `In a batch of ${calls.length} calls: ${worst.explanation}` }, payments };
  }
  const total = payments.reduce((sum, p) => sum + atomic(p.amount), 0n);
  const max = options.maxAmount ?? 1000;
  if (byPayee.size > 1 && Number(total) / 1e6 > max) {
    return {
      verdict: {
        decision: "hold", riskScore: 0.65, flags: ["HIGH_VALUE_TRANSFER"], requiredActions: ["manual_review"],
        explanation: `The batch sends ${Number(total) / 1e6} USDC in total to ${byPayee.size} payees, over the single-transaction ceiling ${max}.`,
      },
      payments,
    };
  }
  if (unsupported.length) {
    return { verdict: held(`SRA-RiskGate cannot check this transaction: ${unsupported.join("; ")}.`), payments };
  }
  const notes = worst?.flags ?? [];
  return {
    verdict: { decision: "approve", riskScore: worst?.riskScore ?? 0, flags: notes, requiredActions: [],
      explanation: `All ${calls.length} calls are USDC transfers that pass the checks (${Number(total) / 1e6} USDC to ${byPayee.size} payee${byPayee.size === 1 ? "" : "s"}).` },
    payments,
  };
}

const GUARDED = new Set(["sendTransaction", "writeContract", "sendRawTransaction", "signTransaction",
  "sendCalls", "deployContract", "signTypedData", "signMessage", ...DELEGATION_METHODS]);

const CANNOT_CHECK_FLAGS = new Set(["UNSUPPORTED_ASSET", "UNSUPPORTED_SIGNATURE", "UNSUPPORTED_CHAIN"]);

/** Typed data before signing: payments and permits are judged; anything else is "cannot check". */
function checkTypedData(client: any, args: any, options: GuardOptions): Verdict {
  const chainId: number | undefined = args?.chain?.id ?? client?.chain?.id;
  const v = checkAuthorization(args, { ...options, sender: accountAddress(client, args), chainId });
  if (v.decision === "hold" && v.flags.length === 1 && CANNOT_CHECK_FLAGS.has(v.flags[0]) && !isApprovalSignature(args)) {
    return held(`SRA-RiskGate cannot check this transaction: ${v.explanation.replace(/^SRA-RiskGate cannot approve this authorization: /, "")}`);
  }
  return v;
}

/** Check a transaction without sending it. */
export function checkTransaction(client: any, method: string, args: any, options: GuardOptions = {}): Verdict {
  // The paying account first: if someone else already controls it, nothing it signs is safe.
  if (options.accountCode !== undefined && options.accountCode !== null) {
    let compromised: Verdict | null;
    try {
      compromised = checkAccountCode(options.accountCode, options.expectedDelegates);
    } catch (e) {
      compromised = { decision: "reject", riskScore: 1, flags: ["CONFIGURATION_ERROR"], requiredActions: ["fix_configuration"],
        explanation: `The risk gate is misconfigured: ${(e as Error).message}` };
    }
    if (compromised) {
      options.onDecision?.({ method, verdict: compromised });
      return compromised;
    }
  }
  const delegation = delegationHold(method, args);
  if (delegation) {
    options.onDecision?.({ method, verdict: delegation });
    return delegation;
  }
  if (method === "signTypedData" || method === "signMessage") {
    const verdict = method === "signMessage"
      ? held("SRA-RiskGate cannot check this transaction: a raw message signature can authorise anything, so its meaning cannot be checked.")
      : checkTypedData(client, args, options);
    options.onDecision?.({ method, verdict });
    return verdict;
  }
  if (method === "sendCalls") {
    let r: { verdict: Verdict; payments?: DecodedPayment[] };
    try {
      r = checkBatch(client, args, options);
    } catch (e) {
      r = { verdict: held(`SRA-RiskGate cannot check this transaction: the batch could not be read (${(e as Error).message}).`) };
    }
    options.onDecision?.({ method, verdict: r.verdict, payments: r.payments });
    return r.verdict;
  }
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
        let opts = options;
        const address = accountAddress(target, args);
        if (options.checkAccountCode !== false && address && options.accountCode === undefined) {
          try {
            const code = await (target as any).request({ method: "eth_getCode", params: [address, "latest"] });
            opts = { ...options, accountCode: code ?? "0x" };
          } catch (e) {
            const verdict: Verdict = { decision: "hold", riskScore: 0.65, flags: ["ACCOUNT_CODE_UNREADABLE"], requiredActions: ["manual_review"],
              explanation: `SRA-RiskGate could not read this account's code (${(e as Error).message}) to check it is not delegated, so nothing is signed. Set checkAccountCode: false to skip this check.` };
            options.onDecision?.({ method: prop, verdict });
            throw new RiskGateBlockedError(verdict);
          }
        }
        const verdict = checkTransaction(target, prop, args, opts);
        const unsupported = verdict.flags.length === 1 && verdict.flags[0] === "CHECK_FAILED" && verdict.explanation.startsWith("SRA-RiskGate cannot check");
        if (verdict.decision !== "approve" && !(unsupported && options.allowUnsupported)) {
          throw new RiskGateBlockedError(verdict);
        }
        return (value as Function).call(target, args, ...rest);
      };
    },
  });
}
