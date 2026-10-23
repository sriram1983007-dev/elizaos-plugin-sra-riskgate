/**
 * Demo: an ElizaOS agent whose wallet can only send USDC that SRA-RiskGate approves.
 * Runs on Base Sepolia (test network, no real money), with Google Gemini or a local Ollama model.
 */
import type { Character, Project, ProjectAgent } from "@elizaos/core";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { createRiskGatePlugin } from "elizaos-plugin-sra-riskgate";
import { geminiEmbedding768 } from "./gemini-embedding.ts";

const key = process.env.DEMO_PRIVATE_KEY as `0x${string}` | undefined;
if (!key) throw new Error("Set DEMO_PRIVATE_KEY in .env (run: npm run wallet)");
const list = (v?: string) => (v ?? "").split(/[\s,]+/).filter(Boolean);

const walletClient = createWalletClient({ account: privateKeyToAccount(key), chain: baseSepolia, transport: http() });

const riskGate = createRiskGatePlugin({
  walletClient,
  maxAmount: 5,                                        // hold anything above 5 USDC
  knownRecipients: list(process.env.KNOWN_PAYEES),     // anyone else is held as a new payee
  blockedAddresses: list(process.env.BLOCKED_ADDRESSES),
  onDecision: ({ verdict }) => console.log(`[sra-riskgate] wallet check: ${verdict.decision} ${JSON.stringify(verdict.flags)}`),
});

export const character: Character = {
  name: "Treasurer",
  plugins: [
    "@elizaos/plugin-sql",
    process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ? "@elizaos/plugin-google-genai" : "@elizaos/plugin-ollama",
    "@elizaos/plugin-bootstrap",
  ],
  system:
    "You are a treasury agent with a USDC wallet on Base Sepolia. When asked to pay or send USDC, use the " +
    "SEND_USDC_CHECKED action. When asked whether a payment is safe, use CHECK_STABLECOIN_PAYMENT. Never claim a " +
    "payment was sent unless the action says so.",
  bio: ["Pays invoices in USDC, but only after SRA-RiskGate approves the payment."],
  settings: { secrets: {} },
};

const useGemini = Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim());
const agent: ProjectAgent = { character, plugins: [riskGate as any, ...(useGemini ? [geminiEmbedding768] : [])] };
const project: Project = { agents: [agent] };
export default project;
