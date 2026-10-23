import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkPayment, scanPayloadClaims } from "../src/checks.js";

const vectors = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url), "utf8"));
const AS_OF = Date.parse(vectors.as_of + "T12:00:00Z");

function toTs(input: Record<string, any>, nan: string[]) {
  const v = (k: string) => (nan.includes(k) ? NaN : input[k] === "Infinity" ? Infinity : input[k]);
  return {
    check: {
      chainId: v("chain_id"), sender: v("sender"), recipient: v("recipient"), amount: v("amount"),
      token: input.token, untrustedRequest: input.untrusted_request, pegDeviationPct: v("peg_deviation_pct"),
    },
    policy: {
      maxAmount: input.max_amount, depegHoldPct: input.depeg_hold_pct, depegRejectPct: input.depeg_reject_pct,
      checkSanctions: input.check_sanctions, knownRecipients: input.known_recipients, blockedAddresses: input.blocked_addresses,
    },
  };
}

describe("parity with the Python sra-riskgate SDK", () => {
  it.each(vectors.cases.map((c: any, i: number) => [i, c]))("case %i", (_i, c: any) => {
    const { check, policy } = toTs(c.input, c.nan);
    const now = () => new Date(AS_OF + c.days_after_as_of * 86_400_000);
    const r = checkPayment(check as any, { ...policy, now } as any);
    expect({ decision: r.decision, flags: r.flags, risk_score: r.riskScore }).toEqual(c.expected);
  });

  it.each(vectors.claims.map((c: any) => [JSON.stringify(c.text).slice(0, 40), c]))("claims %s", (_t, c: any) => {
    expect(scanPayloadClaims(c.text).map((x) => x.rule)).toEqual(c.rules);
  });
});
