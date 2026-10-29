/**
 * Check EIP-712 typed data before the agent signs it: the TypeScript port of sra-riskgate's
 * `check_authorization`.
 *
 * In x402 on EVM chains the agent pays by signing an EIP-3009 `TransferWithAuthorization`, not by sending a
 * transaction, and anyone holding that signature can move the USDC until it expires. A signed EIP-2612
 * `Permit` (or a Permit2 permit) is worse: it lets someone else spend the wallet's tokens later. So the typed
 * data itself is checked: a USDC authorization on a supported chain, from the agent's wallet, current and
 * short-lived, then the decoded payment goes through `checkPayment`. Circle Gateway batched payments
 * (domain `GatewayWalletBatched`, Circle's GatewayWallet contract) get their own validity limit.
 * Never throws; anything unexpected is a hold.
 */
import { checkPayment, USDC_ADDRESSES, USDC_DECIMALS, type Policy, type Verdict } from "./checks.js";

export const DEFAULT_MAX_VALIDITY_SECONDS = 3600;
/** Circle's SDK signs Gateway payments for 7 days + 100 s; Gateway rejects less than 3 days. */
export const DEFAULT_MAX_GATEWAY_VALIDITY_SECONDS = 8 * 86_400;
export const GATEWAY_MIN_VALIDITY_SECONDS = 3 * 86_400;
export const GATEWAY_BATCHED_DOMAIN = "GatewayWalletBatched";

const GATEWAY_MAINNET = "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE";
const GATEWAY_TESTNET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
/** Circle's GatewayWallet contract, per chain (https://developers.circle.com/gateway/references/contract-addresses). */
export const GATEWAY_WALLET_ADDRESSES: Record<number, string> = {
  1: GATEWAY_MAINNET, 8453: GATEWAY_MAINNET, 84532: GATEWAY_TESTNET,
};

const AUTH_FIELDS: Array<[string, string]> = [["from", "address"], ["to", "address"], ["value", "uint256"],
  ["validAfter", "uint256"], ["validBefore", "uint256"], ["nonce", "bytes32"]];
const AUTH_TYPES = new Set(["TransferWithAuthorization", "ReceiveWithAuthorization"]);
const PERMIT2_TYPES = new Set(["PermitSingle", "PermitBatch", "PermitTransferFrom", "PermitBatchTransferFrom",
  "PermitWitnessTransferFrom", "PermitBatchWitnessTransferFrom"]);
const UNLIMITED = 2n ** 255n;
const UINT256 = 2n ** 256n;
const CLOCK_SKEW_SECONDS = 60;

export interface AuthorizationOptions extends Policy {
  /** The agent's own address; the message's `from` must match it. */
  sender?: string;
  /** The chain the wallet is on; the domain's `chainId` must match it. */
  chainId?: number;
  /** Current Unix time in seconds; defaults to the clock. */
  nowSeconds?: number;
  maxValiditySeconds?: number;
  maxGatewayValiditySeconds?: number;
  /** For `checkPayment`: the payment request's own text, scanned for self-asserted claims. */
  untrustedRequest?: unknown;
  pegDeviationPct?: number | null;
}

function hold(flags: string[], why: string): Verdict {
  return { decision: "hold", riskScore: 0.65, flags, explanation: `SRA-RiskGate cannot approve this authorization: ${why}`.slice(0, 500), requiredActions: ["manual_review"] };
}

/** A uint from a number, bigint or decimal / 0x-hex string; throws otherwise. */
function toBig(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new Error("not an integer");
    return BigInt(v);
  }
  if (typeof v === "string" && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(v.trim())) return BigInt(v.trim());
  throw new Error("not an integer");
}

const isAddress = (a: unknown): a is string => typeof a === "string" && /^0[xX][0-9a-fA-F]{40}$/.test(a);
const isBytes32 = (n: unknown): boolean => typeof n === "string" && /^0[xX][0-9a-fA-F]{64}$/.test(n);
const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();

function fields(types: any, name: string): Array<[string, string]> | null {
  try {
    return (types[name] as any[]).map((f) => [f.name, f.type] as [string, string]);
  } catch {
    return null;
  }
}

function hours(seconds: number): string {
  return seconds >= 2 * 86_400 ? `${(seconds / 86_400).toFixed(2)} days` : `${(seconds / 3600).toFixed(1)} hours`;
}

/** True when the typed data grants an allowance rather than making one payment. */
export function isApprovalSignature(typedData: any): boolean {
  const primary = typedData?.primaryType;
  return primary === "Permit" || PERMIT2_TYPES.has(primary) || typedData?.domain?.name === "Permit2";
}

export function checkAuthorization(typedData: unknown, options: AuthorizationOptions = {}): Verdict {
  try {
    let td: any = typedData;
    if (typeof td === "string") {
      try {
        td = JSON.parse(td);
      } catch {
        return hold(["INVALID_AUTHORIZATION"], "the typed data is not valid JSON.");
      }
    }
    if (!td || typeof td !== "object") return hold(["INVALID_AUTHORIZATION"], "the typed data is not an object.");
    const { domain, message, primaryType, types } = td;
    if (!domain || typeof domain !== "object" || !message || typeof message !== "object" || typeof primaryType !== "string") {
      return hold(["INVALID_AUTHORIZATION"], "domain, message and primaryType are required.");
    }

    // Allowances first: whatever the domain, a permit lets someone else spend the wallet's tokens later.
    if (isApprovalSignature(td)) {
      const flags = ["TOKEN_APPROVAL"];
      let why = primaryType === "Permit"
        ? "it is an EIP-2612 permit, which lets another address spend this wallet's tokens later."
        : "it is a Permit2 permit, which lets another address spend this wallet's tokens.";
      const amount = message.value ?? message.details?.amount ?? message.permitted?.amount;
      try {
        if (amount !== undefined && toBig(amount) >= UNLIMITED) {
          flags.push("UNLIMITED_APPROVAL");
          why += " The value is effectively unlimited.";
        }
      } catch { /* unreadable amount: still an approval */ }
      const spender = message.spender;
      if (spender) why += ` Spender: ${spender}.`;
      return hold(flags, why);
    }

    let chain: number;
    try {
      if (domain.chainId === undefined || domain.chainId === null || typeof domain.chainId === "boolean") throw new Error();
      chain = Number(toBig(domain.chainId));
    } catch {
      return hold(["INVALID_AUTHORIZATION"], `domain chainId ${JSON.stringify(domain.chainId)} is not a number.`);
    }
    if (options.chainId !== undefined && options.chainId !== chain) {
      return hold(["AUTHORIZATION_MISMATCH"], `it is for chain ${chain}, not ${options.chainId}.`);
    }
    if (!(chain in USDC_ADDRESSES)) return hold(["UNSUPPORTED_CHAIN"], `chain ${chain} is not checked.`);
    const contract = domain.verifyingContract;
    const gateway = domain.name === GATEWAY_BATCHED_DOMAIN;
    if (gateway) {
      if (!same(contract, GATEWAY_WALLET_ADDRESSES[chain])) {
        return hold(["UNSUPPORTED_ASSET"], `it names Circle Gateway's ${GATEWAY_BATCHED_DOMAIN} domain but is for contract ${contract}, not Circle's GatewayWallet on chain ${chain} (${GATEWAY_WALLET_ADDRESSES[chain]}).`);
      }
      if (String(domain.version) !== "1" || domain.salt !== undefined) {
        return hold(["UNSUPPORTED_ASSET"], `only USDC Gateway payments (domain version "1", no salt) are checked; this is version ${JSON.stringify(domain.version)}, which Gateway uses for EURC and cirBTC.`);
      }
      if (primaryType !== "TransferWithAuthorization") {
        return hold(["UNSUPPORTED_SIGNATURE"], `only TransferWithAuthorization is checked on the Gateway domain; this is ${primaryType}.`);
      }
    } else if (!same(contract, USDC_ADDRESSES[chain])) {
      return hold(["UNSUPPORTED_ASSET"], `it is for contract ${contract}, which is not the USDC contract on chain ${chain} (${USDC_ADDRESSES[chain]}).`);
    }
    if (!AUTH_TYPES.has(primaryType)) {
      return hold(["UNSUPPORTED_SIGNATURE"], `only USDC TransferWithAuthorization is checked; this is ${primaryType}.`);
    }
    if (types !== undefined && JSON.stringify(fields(types, primaryType)) !== JSON.stringify(AUTH_FIELDS)) {
      return hold(["INVALID_AUTHORIZATION"], `the ${primaryType} type definition is not the USDC (EIP-3009) one.`);
    }

    const { from, to, nonce } = message;
    if (!isAddress(from) || !isAddress(to)) return hold(["INVALID_AUTHORIZATION"], "from and to must be 20-byte hex addresses.");
    if (!isBytes32(nonce)) return hold(["INVALID_AUTHORIZATION"], "nonce must be 32 bytes of hex.");
    if (options.sender !== undefined && !same(options.sender, from)) {
      return hold(["AUTHORIZATION_MISMATCH"], `it is from ${from}, not ${options.sender}.`);
    }
    if ([message.value, message.validAfter, message.validBefore].some((v) => v === undefined || v === null)) {
      return hold(["INVALID_AUTHORIZATION"], "value, validAfter and validBefore are required.");
    }
    let value: bigint, validAfter: bigint, validBefore: bigint;
    try {
      [value, validAfter, validBefore] = [toBig(message.value), toBig(message.validAfter), toBig(message.validBefore)];
    } catch {
      return hold(["INVALID_AUTHORIZATION"], "value, validAfter and validBefore must be integers.");
    }
    if ([value, validAfter, validBefore].some((v) => v < 0n || v >= UINT256)) {
      return hold(["INVALID_AUTHORIZATION"], "value, validAfter and validBefore must be uint256.");
    }

    const t = options.nowSeconds ?? Date.now() / 1000;
    const before = Number(validBefore), after = Number(validAfter);
    if (before <= t) return hold(["AUTHORIZATION_EXPIRED"], `validBefore ${validBefore} has already passed.`);
    if (after > t + CLOCK_SKEW_SECONDS) {
      return hold(["AUTHORIZATION_NOT_YET_VALID"], `validAfter ${validAfter} is in the future, so this is a post-dated payment.`);
    }
    const lifetime = before - Math.max(t, after);
    const limit = gateway
      ? options.maxGatewayValiditySeconds ?? DEFAULT_MAX_GATEWAY_VALIDITY_SECONDS
      : options.maxValiditySeconds ?? DEFAULT_MAX_VALIDITY_SECONDS;
    if (lifetime > limit) {
      return hold(["LONG_LIVED_AUTHORIZATION"], `it stays valid for ${hours(lifetime)}, more than the ${hours(limit)} limit${gateway ? " for Circle Gateway payments" : ""}; anyone holding the signature can submit it until then.`);
    }
    if (gateway && before - t < GATEWAY_MIN_VALIDITY_SECONDS) {
      return hold(["GATEWAY_VALIDITY_TOO_SHORT"], `Circle Gateway requires a batched authorization to stay valid for at least three days, and this one expires in ${hours(before - t)}, so Gateway would reject it.`);
    }

    const s = value.toString().padStart(USDC_DECIMALS + 1, "0");
    const amount = Number(`${s.slice(0, -USDC_DECIMALS)}.${s.slice(-USDC_DECIMALS)}`);
    return checkPayment({ chainId: chain, sender: from, recipient: to, amount,
      untrustedRequest: options.untrustedRequest, pegDeviationPct: options.pegDeviationPct } as any, options);
  } catch (e) {
    return { decision: "hold", riskScore: 0.65, flags: ["CHECK_FAILED"], requiredActions: ["manual_review"],
      explanation: `The authorization check failed (${(e as Error)?.name ?? "Error"}), so it is held.` };
  }
}
