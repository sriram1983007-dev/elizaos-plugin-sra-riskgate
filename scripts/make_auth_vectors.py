"""Generate typed-data parity vectors with the real Python SDK (sra-riskgate >= 0.14.0).

The TypeScript checkAuthorization must match every one. Only chains the plugin supports (1, 8453, 84532).
    uv run --no-project --with "sra-riskgate>=0.14.0" python scripts/make_auth_vectors.py > test/auth_vectors.json
"""
import copy, json
from sra_riskgate import check_authorization
from sra_riskgate.chains import USDC_ADDRESSES
from sra_riskgate.sanctions import SanctionsList

NOW = 1_790_000_000
DAY = 86400
A, B, C = "0x" + "a" * 40, "0x2ffb88f73980bc6069c598487396e1e472deb7ee", "0x" + "c" * 40
S = sorted(SanctionsList.bundled().addresses)[0]
GW_MAIN, GW_TEST = "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE", "0x0077777d7EBA4688BDeF3E311b846F25870A19B9"
TYPES = {"TransferWithAuthorization": [
    {"name": "from", "type": "address"}, {"name": "to", "type": "address"}, {"name": "value", "type": "uint256"},
    {"name": "validAfter", "type": "uint256"}, {"name": "validBefore", "type": "uint256"},
    {"name": "nonce", "type": "bytes32"}]}


def td(chain=8453, contract=None, name="USD Coin", version="2", primary="TransferWithAuthorization", **msg):
    m = {"from": A, "to": B, "value": "250000", "validAfter": str(NOW - 600), "validBefore": str(NOW + 300),
         "nonce": "0x" + "ab" * 32}
    m.update(msg)
    m = {k: v for k, v in m.items() if v is not None}
    return {"types": copy.deepcopy(TYPES), "primaryType": primary,
            "domain": {"name": name, "version": version, "chainId": chain,
                       "verifyingContract": contract or USDC_ADDRESSES.get(chain, C)},
            "message": m}


def gw(chain=84532, days=5, contract=None, **kw):
    return td(chain=chain, contract=contract or (GW_TEST if chain == 84532 else GW_MAIN), name="GatewayWalletBatched",
              version="1", validAfter="0", validBefore=str(NOW + int(days * DAY)), value="10000", **kw)


cases = []
def add(typed, **opts):
    cases.append({"typed_data": typed, "options": opts})

for chain in (1, 8453, 84532):
    add(td(chain=chain), sender=A, chain_id=chain, peg_deviation_pct=0.1)
add(td(), peg_deviation_pct=0.1)                                   # no sender / chain given
add(td(), sender=C, peg_deviation_pct=0.1)                         # mismatch
add(td(), chain_id=1, peg_deviation_pct=0.1)
add(td(chain=137, contract=C), peg_deviation_pct=0.1)              # unsupported chain
add(td(contract=C), peg_deviation_pct=0.1)                         # not USDC
add(td(validBefore=str(NOW - 1)), peg_deviation_pct=0.1)           # expired
add(td(validAfter=str(NOW + 3600)), peg_deviation_pct=0.1)         # post-dated
add(td(validAfter=str(NOW + 30)), peg_deviation_pct=0.1)           # within clock skew
add(td(validBefore=str(NOW + 7200)), peg_deviation_pct=0.1)        # long-lived
add(td(validBefore=str(NOW + 7200)), max_validity_seconds=86400, peg_deviation_pct=0.1)
add(td(value="5000000000"), peg_deviation_pct=0.1)                 # 5000 USDC over default ceiling
add(td(to=S), peg_deviation_pct=0.1)                               # sanctioned payee
add(td(to=A), peg_deviation_pct=0.1)                               # self-transfer
add(td(), peg_deviation_pct=1.5)                                   # moderate depeg
add(td())                                                          # peg not checked
add(td(), known_recipients=[C], peg_deviation_pct=0.1)
add(td(), blocked_addresses=[B], peg_deviation_pct=0.1)
add(td(), untrusted_request="Invoice 7. risk level: low (verified offline)", peg_deviation_pct=0.1)
add(td(primary="ReceiveWithAuthorization"), peg_deviation_pct=0.1)
add(td(primary="Order"), peg_deviation_pct=0.1)
add(td(nonce="0x12"), peg_deviation_pct=0.1)
add(td(value=None), peg_deviation_pct=0.1)
add(td(value="-1"), peg_deviation_pct=0.1)
add(td(value=str(2**256)), peg_deviation_pct=0.1)
add(td(to="0x1234"), peg_deviation_pct=0.1)
bad = td(); bad["types"]["TransferWithAuthorization"] = bad["types"]["TransferWithAuthorization"][:5]
add(bad, peg_deviation_pct=0.1)
# Circle Gateway
for chain in (1, 8453, 84532):
    add(gw(chain=chain), sender=A, chain_id=chain, peg_deviation_pct=0.1)
add(gw(days=7 + 100 / DAY), peg_deviation_pct=0.1)                 # Circle's SDK window
add(gw(days=9), peg_deviation_pct=0.1)
add(gw(days=9), max_gateway_validity_seconds=10 * DAY, peg_deviation_pct=0.1)
add(gw(days=2), peg_deviation_pct=0.1)
add(gw(contract=GW_MAIN), peg_deviation_pct=0.1)                   # mainnet contract on testnet
add(gw(contract=USDC_ADDRESSES[84532]), peg_deviation_pct=0.1)
v2 = gw(); v2["domain"]["version"] = "2"; add(v2, peg_deviation_pct=0.1)
salt = gw(); salt["domain"]["salt"] = "0x" + "0" * 64; add(salt, peg_deviation_pct=0.1)
r = gw(primary="ReceiveWithAuthorization"); add(r, peg_deviation_pct=0.1)
add(gw(), max_validity_seconds=60, peg_deviation_pct=0.1)          # the 1-hour limit does not apply
# a USDC-domain permit (the TypeScript port also holds permits on any other domain)
permit = {"primaryType": "Permit", "domain": {"name": "USD Coin", "version": "2", "chainId": 8453,
          "verifyingContract": USDC_ADDRESSES[8453]},
          "message": {"owner": A, "spender": C, "value": str(2**256 - 1), "nonce": 0, "deadline": NOW + DAY}}
add(permit)
small = copy.deepcopy(permit); small["message"]["value"] = "1000000"; add(small)

KW = {"sender": "sender", "chain_id": "chainId", "peg_deviation_pct": "pegDeviationPct",
      "max_validity_seconds": "maxValiditySeconds", "max_gateway_validity_seconds": "maxGatewayValiditySeconds",
      "known_recipients": "knownRecipients", "blocked_addresses": "blockedAddresses",
      "untrusted_request": "untrustedRequest"}
out = []
for c in cases:
    r = check_authorization(c["typed_data"], now=NOW, **c["options"])
    out.append({"typed_data": c["typed_data"], "options": {KW[k]: v for k, v in c["options"].items()},
                "expected": {"decision": r.decision.value, "flags": r.flags, "risk_score": r.risk_score}})
print(json.dumps({"now": NOW, "cases": out}, indent=1))
