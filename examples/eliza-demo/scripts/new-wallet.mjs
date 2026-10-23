// Creates two throwaway Base Sepolia wallets for the demo and prints .env lines. Test network only.
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
const agent = generatePrivateKey(), payee = privateKeyToAccount(generatePrivateKey()).address;
console.log(`DEMO_PRIVATE_KEY=${agent}`);
console.log(`# agent wallet address (send test USDC here): ${privateKeyToAccount(agent).address}`);
console.log(`KNOWN_PAYEES=${payee}`);
console.log(`BLOCKED_ADDRESSES=0x000000000000000000000000000000000000dEaD`);
