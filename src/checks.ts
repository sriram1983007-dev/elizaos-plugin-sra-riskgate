/**
 * The sra-riskgate payment rules, ported to TypeScript. Kept decision-for-decision identical to the
 * Python SDK (sra-riskgate 0.8.0) by parity tests generated from it. Every error is a hold.
 */
import { BUNDLED_AS_OF, BUNDLED_SANCTIONS } from "./sanctions-data.js";

export type Decision = "approve" | "hold" | "reject";

export interface Verdict {
  decision: Decision;
  riskScore: number;
  flags: string[];
  explanation: string;
  requiredActions: string[];
}

export interface PaymentCheck {
  chainId: number;
  sender: string;
  recipient: string;
  /** Whole USDC, for example 20.5 (not atomic units). */
  amount: number;
  token?: string;
  /** The payment request, memo or description exactly as received: string, object or array. */
  untrustedRequest?: unknown;
  /** USDC's deviation from $1.00 in percent, from your own price feed. Omit if unknown. */
  pegDeviationPct?: number | null;
}

export interface Policy {
  maxAmount?: number;
  depegHoldPct?: number;
  depegRejectPct?: number;
  checkSanctions?: boolean;
  /** Payees you have verified. When set (even empty), a payment to anyone else is held. */
  knownRecipients?: string[] | null;
  /** Always rejected, as sender or recipient. */
  blockedAddresses?: string[] | null;
  /** Flag SANCTIONS_LIST_STALE when the bundled list is older than this. null turns it off. */
  sanctionsMaxAgeDays?: number | null;
  /** Clock for the staleness check; defaults to now. */
  now?: () => Date;
}

export const USDC_DECIMALS = 6;
export const USDC_ADDRESSES: Record<number, string> = {
  1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  84532: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const NOTES = new Set(["PEG_NOT_CHECKED", "SANCTIONS_NOT_CHECKED", "ROUND_AMOUNT", "SANCTIONS_LIST_STALE"]);
export const CLAIMS_FLAG = "self_asserted_verification_in_payload";

export function isUsdc(chainId: number | null | undefined, asset: unknown): boolean {
  const expected = chainId == null ? undefined : USDC_ADDRESSES[chainId];
  return !!expected && String(asset).toLowerCase() === expected.toLowerCase();
}

function normaliseAddress(a: unknown): string | null {
  if (typeof a !== "string") return null;
  const s = a.trim();
  return ADDRESS.test(s) ? s.toLowerCase() : null;
}

/** Parse a policy address list. null/undefined = not configured. Throws on anything malformed. */
export function parseAddressList(name: string, value: unknown): Set<string> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || !Array.isArray(value)) {
    throw new Error(`${name} must be a list of addresses or null, got ${typeof value}.`);
  }
  const out = new Set<string>();
  for (const entry of value) {
    const n = normaliseAddress(entry);
    if (n === null) throw new Error(`${name} contains an entry that is not an EVM address: ${JSON.stringify(entry)}.`);
    out.add(n);
  }
  return out;
}

const SANCTIONS: Set<string> = new Set(BUNDLED_SANCTIONS);

function verdict(decision: Decision, flags: string[], explanation: string, actions: string[], score?: number): Verdict {
  const riskScore = score ?? { approve: 0.05, hold: 0.65, reject: 1.0 }[decision];
  return { decision, riskScore, flags, explanation: explanation.slice(0, 500), requiredActions: actions };
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** floor(amount * 10^6) computed on the shortest decimal form, like Python's Decimal(str(x)). */
function atomicUnits(amount: number): bigint {
  let s = amount.toString();
  let exp = 0;
  const e = s.search(/e/i);
  if (e >= 0) { exp = parseInt(s.slice(e + 1), 10); s = s.slice(0, e); }
  const neg = s.startsWith("-");
  if (neg) s = s.slice(1);
  let [int, frac = ""] = s.split(".");
  let digits = int + frac;
  let point = int.length + exp + USDC_DECIMALS;
  if (point <= 0) return 0n;
  if (point > digits.length) digits = digits + "0".repeat(point - digits.length);
  const whole = BigInt(digits.slice(0, point) || "0");
  return neg ? -whole : whole;
}

function screen(set: Set<string> | null, sender: unknown, recipient: unknown): Array<[string, string]> {
  if (!set || set.size === 0) return [];
  const hits: Array<[string, string]> = [];
  for (const [party, addr] of [["recipient", recipient], ["sender", sender]] as const) {
    const n = normaliseAddress(addr);
    if (n !== null && set.has(n)) hits.push([party, n]);
  }
  return hits;
}

function ageDays(now: Date): number | null {
  const asOf = Date.parse(BUNDLED_AS_OF + "T00:00:00Z");
  if (Number.isNaN(asOf)) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((today - asOf) / 86_400_000);
}

/** Check a USDC payment before sending it. Never throws; anything unexpected becomes hold. */
export function checkPayment(p: PaymentCheck, policy: Policy = {}): Verdict {
  try {
    return checkPaymentInner(p, policy);
  } catch (e) {
    return verdict("hold", ["CHECK_FAILED"], `The payment check failed (${(e as Error)?.name ?? "Error"}), so the payment is held.`, ["manual_review"]);
  }
}

function checkPaymentInner(p: PaymentCheck, policy: Policy): Verdict {
  const maxAmount = policy.maxAmount ?? 1000;
  const holdPct = policy.depegHoldPct ?? 1;
  const rejectPct = policy.depegRejectPct ?? 5;
  const checkSanctions = policy.checkSanctions ?? true;
  const maxAge = policy.sanctionsMaxAgeDays === undefined ? 90 : policy.sanctionsMaxAgeDays;
  const config = (msg: string) => verdict("reject", ["CONFIGURATION_ERROR"], `The risk gate is misconfigured: ${msg}`, ["fix_configuration"]);

  for (const [name, v] of [["maxAmount", maxAmount], ["depegHoldPct", holdPct], ["depegRejectPct", rejectPct]] as const) {
    if (!isFiniteNumber(v)) return config(`${name} must be a finite number.`);
  }
  if (maxAmount <= 0) return config("maxAmount must be strictly greater than 0.");
  if (!(0 < holdPct && holdPct < rejectPct)) return config("Thresholds must satisfy 0 < depegHoldPct < depegRejectPct.");
  if (typeof checkSanctions !== "boolean") return config("checkSanctions must be true or false.");
  if (maxAge !== null && !(Number.isInteger(maxAge) && maxAge > 0)) return config("sanctionsMaxAgeDays must be a positive whole number or null.");
  let known: Set<string> | null, blocked: Set<string> | null;
  try {
    known = parseAddressList("knownRecipients", policy.knownRecipients);
    blocked = parseAddressList("blockedAddresses", policy.blockedAddresses);
  } catch (e) {
    return config((e as Error).message);
  }

  // 1. Sanctions, then your blocklist: who is on the other side comes first.
  const sanctioned = checkSanctions ? screen(SANCTIONS, p.sender, p.recipient) : [];
  if (sanctioned.length) {
    const who = sanctioned.map(([party, a]) => `${party} ${a}`).join(" and ");
    return verdict("reject", ["OFAC_SDN_MATCH", ...sanctioned.map(([party]) => `SANCTIONED_${party.toUpperCase()}`)],
      `The ${who} is on the OFAC SDN list (bundled snapshot, as of ${BUNDLED_AS_OF}). Do not pay. This is an exact address match, not a compliance determination; refer it to your compliance process.`,
      ["reject_payment", "refer_to_compliance"], 1.0);
  }
  const hits = screen(blocked, p.sender, p.recipient);
  if (hits.length) {
    const who = hits.map(([party, a]) => `${party} ${a}`).join(" and ");
    return verdict("reject", ["BLOCKLISTED_ADDRESS", ...hits.map(([party]) => `BLOCKLISTED_${party.toUpperCase()}`)],
      `The ${who} is on your blocked_addresses list. Do not pay.`, ["reject_payment"], 1.0);
  }

  // 2. Supported asset and chain.
  const token = p.token ?? "USDC";
  if (typeof token !== "string" || token.trim().toUpperCase() !== "USDC") {
    return verdict("hold", ["UNSUPPORTED_ASSET"], `Only USDC is checked; got ${JSON.stringify(token)}.`, ["manual_review"]);
  }
  if (typeof p.chainId !== "number" || !(p.chainId in USDC_ADDRESSES)) {
    return verdict("hold", ["UNSUPPORTED_CHAIN"], `Chain ${p.chainId} is not checked; supported chain ids: 1, 8453, 84532.`, ["manual_review"]);
  }

  // 3. Validation.
  const invalid = (msg: string) => verdict("reject", ["INVALID_PAYMENT"], `Payment failed validation: ${msg}`, ["reject_payment"]);
  const amount = p.amount;
  if (typeof amount !== "number") return invalid("amount must be a number.");
  for (const [field, v] of [["sender", p.sender], ["recipient", p.recipient]] as const) {
    if (typeof v !== "string" || !ADDRESS.test(v)) return invalid(`Invalid Ethereum address format: ${v}`);
  }
  if (Number.isNaN(amount) || !Number.isFinite(amount)) return invalid("Amount must be a finite numerical value.");
  if (amount <= 0) return invalid("Amount must be strictly greater than 0.");
  const sender = p.sender.toLowerCase(), recipient = p.recipient.toLowerCase();
  if (sender === ZERO_ADDRESS || recipient === ZERO_ADDRESS) return invalid("Zero address (0x0...0) is not permitted as sender or recipient.");
  if (atomicUnits(amount) < 1n) return invalid(`Amount ${amount} is below the smallest USDC unit (0.000001) and rounds to zero on-chain.`);
  if (sender === recipient) return invalid("Self-transfer detected: sender and recipient addresses cannot be identical.");

  // 4. Rules.
  const pegObserved = p.pegDeviationPct !== null && p.pegDeviationPct !== undefined;
  const peg = pegObserved ? (p.pegDeviationPct as number) : 0;
  if (typeof peg !== "number" || !Number.isFinite(peg)) {
    return verdict("reject", ["INVALID_PEG_VALUE"], "Peg deviation percentage is NaN or infinite.", ["reject_payment"], 1.0);
  }
  const dev = Math.abs(peg);
  if (dev >= rejectPct) {
    return verdict("reject", ["CRITICAL_DEPEG_EVENT"], `Peg deviation magnitude ${dev}% meets or exceeds rejection ceiling ${rejectPct}%.`,
      ["reject_payment", "halt_clearing"], 0.95);
  }
  const flags: string[] = [], reasons: string[] = [];
  if (dev >= holdPct) { flags.push("MODERATE_DEPEG"); reasons.push(`Peg deviation magnitude ${dev}% meets or exceeds hold threshold ${holdPct}%.`); }
  if (amount > maxAmount) { flags.push("HIGH_VALUE_TRANSFER"); reasons.push(`Transfer amount ${amount} exceeds single-transaction ceiling ${maxAmount}.`); }
  if (amount >= 10_000 && Number.isInteger(amount)) {
    flags.push("ROUND_AMOUNT");
    reasons.push(`Round amount of ${amount} USDC: large round-number transfers are a common transaction-monitoring signal. Informational only.`);
  }
  if (known !== null && !known.has(recipient)) {
    flags.push("NEW_COUNTERPARTY");
    reasons.push(`First payment to ${recipient}: it is not in knownRecipients. Confirm the payee through a channel you control, not the payment request, before adding it.`);
  }
  const age = checkSanctions && maxAge !== null ? ageDays((policy.now ?? (() => new Date()))()) : null;
  if (age !== null && maxAge !== null && age > maxAge) {
    flags.push("SANCTIONS_LIST_STALE");
    reasons.push(`The sanctions list is ${age} days old (as of ${BUNDLED_AS_OF}); addresses designated since then are not matched.`);
  }
  if (!pegObserved) { flags.push("PEG_NOT_CHECKED"); reasons.push("No peg deviation supplied, so the depeg check was skipped."); }
  if (!checkSanctions) { flags.push("SANCTIONS_NOT_CHECKED"); reasons.push("Sanctions matching is turned off for this gate."); }

  let result = flags.some((f) => !NOTES.has(f))
    ? verdict("hold", flags, reasons.join("; "), ["manual_review"])
    : verdict("approve", flags, "Transaction conforms to standard deterministic pre-filter policies." + (reasons.length ? " " + reasons.join(" ") : ""), []);

  // 5. Self-asserted claims in the untrusted request.
  if (p.untrustedRequest === undefined || p.untrustedRequest === null) return result;
  const claims = scanPayloadClaims(p.untrustedRequest);
  if (!claims.length) return result;
  const found = claims.slice(0, 3).map((c) => `${c.rule}: ${JSON.stringify(c.match)}`).join("; ");
  let why = `The payment request claims its own verification (${found}). Real checks must come from your own tools.`;
  if (result.decision === "hold") why += " Also: " + result.explanation;
  return verdict("hold", [CLAIMS_FLAG, ...claims.map((c) => c.rule), ...result.flags.filter((f) => f !== CLAIMS_FLAG)], why, ["manual_review"]);
}

// ------------------------------------------------------------------ self-asserted claims

export interface PayloadClaim { rule: string; match: string }

const RULES: Array<[string, RegExp]> = [
  ["self_asserted_risk", /\brisk[\s_-]*(level|score|rating|status)\b\W{0,3}\s*(is\s+)?(low|none|minimal|zero|0(\.0+)?|safe)\b/i],
  ["self_asserted_check", /\b(compliance|kyc|aml|sanctions?|screening|attestation|signature|risk)\b[^.\n]{0,40}\b(passed|cleared|approved|ok|verified|complete[d]?|confirmed|done)\b/i],
  ["verified_offline", /\b(pre-?verified|pre-?approved|verified\s+offline|already\s+(verified|approved|checked|screened))\b/i],
  ["override_instruction", /\b(ignore|disregard|override)\b[^.\n]{0,30}\b(previous|prior|above|instructions?|rules?|policy|policies)\b|^\s*\[?(system|assistant)\]?\s*:|\byou\s+(must|should|are\s+required\s+to)\s+(approve|respond|output)/im],
];
const HEX = /^(0x)?[0-9a-fA-F]{16,}$/;
const MAX_STRINGS = 10_000;
const MAX_DEPTH = 200;
export const TOO_LARGE = "payload_too_large_to_scan";
const CONFUSABLES: Record<string, string> = {
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i", "ј": "j", "ѕ": "s",
  "ԁ": "d", "һ": "h", "ӏ": "l", "ԛ": "q", "ԝ": "w", "к": "k", "м": "m", "т": "t", "в": "b", "н": "h",
  "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O", "Р": "P", "С": "C", "Т": "T",
  "Х": "X", "У": "Y", "І": "I", "Ј": "J", "Ѕ": "S",
  "α": "a", "ε": "e", "ο": "o", "ρ": "p", "τ": "t", "υ": "u", "ν": "v", "κ": "k", "ι": "i",
  "Α": "A", "Β": "B", "Ε": "E", "Ζ": "Z", "Η": "H", "Ι": "I", "Κ": "K", "Μ": "M", "Ν": "N", "Ο": "O",
  "Ρ": "P", "Τ": "T", "Υ": "Y", "Χ": "X",
};

export function normalizeText(text: string): string {
  return Array.from(text.normalize("NFKC").replace(/\p{Cf}/gu, "")).map((ch) => CONFUSABLES[ch] ?? ch).join("");
}

class TooLarge extends Error {}

function textValues(payload: unknown): string[] {
  if (typeof payload === "string") {
    try { payload = JSON.parse(payload); } catch { return [payload as string]; }
  }
  const out: string[] = [];
  const stack: Array<[unknown, number]> = [[payload, 0]];
  while (stack.length) {
    const [obj, depth] = stack.pop()!;
    if (depth > MAX_DEPTH) throw new TooLarge();
    if (typeof obj === "string") {
      const s = obj.trim();
      if (s && !HEX.test(s)) {
        out.push(obj);
        if (out.length > MAX_STRINGS) throw new TooLarge();
      }
    } else if (Array.isArray(obj)) {
      for (let i = obj.length - 1; i >= 0; i--) stack.push([obj[i], depth + 1]);
    } else if (obj && typeof obj === "object") {
      const vals = Object.values(obj as Record<string, unknown>);
      for (let i = vals.length - 1; i >= 0; i--) stack.push([vals[i], depth + 1]);
    }
  }
  return out;
}

/** Every self-asserted verification claim in the untrusted payload. Pass only the untrusted part. */
export function scanPayloadClaims(payload: unknown): PayloadClaim[] {
  let values: string[];
  try {
    values = textValues(payload);
  } catch (e) {
    if (e instanceof TooLarge) return [{ rule: TOO_LARGE, match: `more than ${MAX_STRINGS} text fields, or nested more than ${MAX_DEPTH} levels` }];
    throw e;
  }
  const text = normalizeText(values.join("\n"));
  const found: PayloadClaim[] = [];
  for (const [rule, re] of RULES) {
    const m = re.exec(text);
    if (m) found.push({ rule, match: m[0].slice(0, 120) });
  }
  return found;
}
