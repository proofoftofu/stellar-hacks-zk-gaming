#!/usr/bin/env bun

/**
 * Deploy script for Soroban contracts to testnet
 *
 * Deploys Soroban contracts to testnet
 * Returns the deployed contract IDs
 */

import { $ } from "bun";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEnvFile, getEnvValue } from './utils/env';
import { getWorkspaceContracts, listContractNames, selectContracts } from "./utils/contracts";

type StellarKeypair = {
  publicKey(): string;
  secret(): string;
};

type StellarKeypairFactory = {
  random(): StellarKeypair;
  fromSecret(secret: string): StellarKeypair;
};

async function loadKeypairFactory(): Promise<StellarKeypairFactory> {
  try {
    const sdk = await import("@stellar/stellar-sdk");
    return sdk.Keypair;
  } catch (error) {
    console.warn("⚠️  @stellar/stellar-sdk is not installed. Running `bun install`...");
    try {
      await $`bun install`;
      const sdk = await import("@stellar/stellar-sdk");
      return sdk.Keypair;
    } catch (installError) {
      console.error("❌ Failed to load @stellar/stellar-sdk.");
      console.error("Run `bun install` in the repository root, then retry.");
      process.exit(1);
    }
  }
}

function usage() {
  console.log(`
Usage: bun run deploy [--local] [contract-name...]

Examples:
  bun run deploy
  bun run deploy --local
  bun run deploy number-guess
  bun run deploy twenty-one number-guess
`);
}

const rawArgs = process.argv.slice(2);
const isLocal = rawArgs.includes("--local");
const args = rawArgs.filter((a) => a !== "--local");

const NETWORK = isLocal ? 'local' : 'testnet';
const RPC_URL = isLocal ? 'http://localhost:8000/soroban/rpc' : 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = isLocal
  ? 'Standalone Network ; February 2017'
  : 'Test SDF Network ; September 2015';
const HORIZON_URL = isLocal ? 'http://localhost:8000' : 'https://horizon-testnet.stellar.org';
const FRIENDBOT_URL = isLocal ? 'http://localhost:8000/friendbot' : 'https://friendbot.stellar.org';
const EXISTING_GAME_HUB_TESTNET_CONTRACT_ID = 'CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG';
const ULTRAHONK_VERIFIER_KEY = "ultrahonk-verifier";
const ULTRAHONK_VERIFIER_MANIFEST_PATH =
  "zk/ultrahonk_soroban_contract/contracts/ultrahonk-soroban-contract/Cargo.toml";
const ULTRAHONK_VERIFIER_WASM_CANDIDATES = [
  "zk/ultrahonk_soroban_contract/target/wasm32v1-none/release/ultrahonk_soroban_contract.wasm",
  "zk/ultrahonk_soroban_contract/contracts/guess-the-puzzle/ultrahonk_soroban_contract.wasm",
];
const FORCE_REBUILD_ULTRAHONK_VERIFIER = true;
const FORCE_REDEPLOY_ULTRAHONK_VERIFIER = true;
const ULTRAHONK_VK_JSON_CANDIDATES = [
  "zk/my-game-circuit/public/my-game_vk.json",
  "zk/my-game-circuit/target/vk_fields.json",
  "zk/ultrahonk_soroban_contract/public/circuits/sudoku_vk.json",
  "zk/ultrahonk_soroban_contract/circuits/target/vk_fields.json",
];
const ULTRAHONK_VK_BIN_CANDIDATES = [
  "zk/my-game-circuit/public/my-game.vk",
  "zk/my-game-circuit/target/vk",
  "zk/ultrahonk_soroban_contract/circuits/target/vk",
];

if (isLocal) {
  try {
    await $`stellar network health --network local`.quiet();
  } catch {
    console.error("❌ Local network is not healthy.");
    console.error("Start it first with: stellar container start local --limits unlimited");
    process.exit(1);
  }
}

function findUltraHonkVerifierWasmPath(): string | null {
  for (const candidate of ULTRAHONK_VERIFIER_WASM_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function inspectWasmProtocolVersion(wasmPath: string): Promise<number | null> {
  try {
    const out = await $`stellar contract inspect --wasm ${wasmPath}`.text();
    const m = out.match(/Protocol Version:\s*(\d+)/);
    if (!m) return null;
    return Number.parseInt(m[1], 10);
  } catch {
    return null;
  }
}

function findUltraHonkVkJsonPath(explicitPath: string): string | null {
  if (explicitPath && existsSync(explicitPath)) return explicitPath;
  for (const candidate of ULTRAHONK_VK_JSON_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function findUltraHonkVkBinPath(explicitPath: string): string | null {
  if (explicitPath && existsSync(explicitPath)) return explicitPath;
  for (const candidate of ULTRAHONK_VK_BIN_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function accountExists(address: string): Promise<boolean> {
  try {
    const res = await fetch(`${HORIZON_URL}/accounts/${address}`, { method: 'GET' });
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`Horizon error ${res.status} checking ${address}`);
    return true;
  } catch {
    // Local container setups may not expose Horizon on the same endpoint.
    return false;
  }
}

async function ensureFunded(address: string): Promise<void> {
  if (!isLocal && await accountExists(address)) return;

  console.log(`💰 Funding ${address} via friendbot...`);
  const friendbotCandidates = [
    `${FRIENDBOT_URL}?addr=${address}`,
    `${FRIENDBOT_URL}?address=${address}`,
  ];

  for (const url of friendbotCandidates) {
    try {
      const fundRes = await fetch(url, { method: 'GET' });
      if (fundRes.ok) {
        if (isLocal) return;
        for (let attempt = 0; attempt < 8; attempt++) {
          await new Promise((r) => setTimeout(r, 500));
          if (await accountExists(address)) return;
        }
      }
    } catch {
      // Try next funding endpoint variant.
    }
  }

  if (isLocal) {
    // Localnet friendbot may have funded successfully even without Horizon visibility.
    // If friendbot route is unavailable, this remains a hard failure.
    throw new Error(`Failed to fund ${address} on localnet friendbot (${FRIENDBOT_URL})`);
  }

  throw new Error(`Funded ${address} but it still doesn't appear on Horizon yet`);
}

async function networkContractExists(contractId: string): Promise<boolean> {
  const tmpPath = join(tmpdir(), `stellar-contract-${contractId}.wasm`);
  try {
    await $`stellar --no-cache -q contract fetch --id ${contractId} --network ${NETWORK} --out-file ${tmpPath}`;
    return true;
  } catch {
    return false;
  } finally {
    try {
      await unlink(tmpPath);
    } catch {
      // Ignore missing temp file
    }
  }
}

async function wasmHasFunction(wasmPath: string, functionName: string): Promise<boolean> {
  try {
    const out = await $`stellar contract inspect --wasm ${wasmPath}`.text();
    return out.includes(`Function: ${functionName}`);
  } catch {
    return false;
  }
}

if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

console.log(`🚀 Deploying contracts to Stellar ${isLocal ? "localnet" : "testnet"}...\n`);
const Keypair = await loadKeypairFactory();

const allContracts = await getWorkspaceContracts();
const selection = selectContracts(allContracts, args);
if (selection.unknown.length > 0 || selection.ambiguous.length > 0) {
  console.error("❌ Error: Unknown or ambiguous contract names.");
  if (selection.unknown.length > 0) {
    console.error("Unknown:");
    for (const name of selection.unknown) console.error(`  - ${name}`);
  }
  if (selection.ambiguous.length > 0) {
    console.error("Ambiguous:");
    for (const entry of selection.ambiguous) {
      console.error(`  - ${entry.target}: ${entry.matches.join(", ")}`);
    }
  }
  console.error(`\nAvailable contracts: ${listContractNames(allContracts)}`);
  process.exit(1);
}

const contracts = selection.contracts;
const mock = allContracts.find((c) => c.isMockHub);
if (!mock) {
  console.error("❌ Error: mock-game-hub contract not found in workspace members");
  process.exit(1);
}

const needsMock = contracts.some((c) => !c.isMockHub);
const deployMockRequested = contracts.some((c) => c.isMockHub);
const shouldEnsureMock = deployMockRequested || needsMock;

// Check required WASM files exist for selected contracts (non-mock first)
const missingWasm: string[] = [];
for (const contract of contracts) {
  if (contract.isMockHub) continue;
  if (!await Bun.file(contract.wasmPath).exists()) missingWasm.push(contract.wasmPath);
}
if (missingWasm.length > 0) {
  console.error("❌ Error: Missing WASM build outputs:");
  for (const p of missingWasm) console.error(`  - ${p}`);
  console.error("\nRun 'bun run build [contract-name]' first");
  process.exit(1);
}

// Create three testnet identities: admin, player1, player2
// Admin signs deployments directly via secret key (no CLI identity required).
// Player1 and player2 are keypairs for frontend dev use.
const walletAddresses: Record<string, string> = {};
const walletSecrets: Record<string, string> = {};

// Load existing secrets from .env if available
let existingSecrets: Record<string, string | null> = {
  player1: null,
  player2: null,
};

const existingEnv = await readEnvFile('.env');
for (const identity of ['player1', 'player2']) {
  const key = `VITE_DEV_${identity.toUpperCase()}_SECRET`;
  const v = getEnvValue(existingEnv, key);
  if (v && v !== 'NOT_AVAILABLE') existingSecrets[identity] = v;
}

// Load existing deployment info so partial deploys can preserve other IDs.
const existingContractIds: Record<string, string> = {};
let existingDeployment: any = null;
if (existsSync("deployment.json")) {
  try {
    const parsedDeployment = await Bun.file("deployment.json").json();
    const deploymentNetwork = parsedDeployment?.network as string | undefined;
    const sameNetwork =
      deploymentNetwork === NETWORK ||
      (!deploymentNetwork && !isLocal); // old files are assumed testnet

    if (sameNetwork) {
      existingDeployment = parsedDeployment;
      if (existingDeployment?.contracts && typeof existingDeployment.contracts === "object") {
        Object.assign(existingContractIds, existingDeployment.contracts);
      } else {
        // Backwards compatible fallback
        if (existingDeployment?.mockGameHubId) existingContractIds["mock-game-hub"] = existingDeployment.mockGameHubId;
        if (existingDeployment?.twentyOneId) existingContractIds["twenty-one"] = existingDeployment.twentyOneId;
        if (existingDeployment?.numberGuessId) existingContractIds["number-guess"] = existingDeployment.numberGuessId;
      }
    }
  } catch (error) {
    console.warn("⚠️  Warning: Failed to parse deployment.json, continuing...");
  }
}

if (!isLocal) {
  for (const contract of allContracts) {
    if (existingContractIds[contract.packageName]) continue;
    const envId = getEnvValue(existingEnv, `VITE_${contract.envKey}_CONTRACT_ID`);
    if (envId) existingContractIds[contract.packageName] = envId;
  }
  if (!existingContractIds[ULTRAHONK_VERIFIER_KEY]) {
    const verifierEnvId = getEnvValue(existingEnv, "VITE_ULTRAHONK_VERIFIER_CONTRACT_ID");
    if (verifierEnvId) existingContractIds[ULTRAHONK_VERIFIER_KEY] = verifierEnvId;
  }
}

// Handle admin identity (needs to be in Stellar CLI for deployment)
console.log('Setting up admin identity...');
console.log('📝 Generating new admin identity...');
const adminKeypair = Keypair.random();

walletAddresses.admin = adminKeypair.publicKey();

try {
  await ensureFunded(walletAddresses.admin);
  console.log('✅ admin funded');
} catch (error) {
  console.error('❌ Failed to ensure admin is funded. Deployment cannot proceed.');
  process.exit(1);
}

// Handle player identities (don't need to be in CLI, just keypairs)
for (const identity of ['player1', 'player2']) {
  console.log(`Setting up ${identity}...`);

  let keypair: Keypair;
  if (existingSecrets[identity]) {
    console.log(`✅ Using existing ${identity} from .env`);
    keypair = Keypair.fromSecret(existingSecrets[identity]!);
  } else {
    console.log(`📝 Generating new ${identity}...`);
    keypair = Keypair.random();
  }

  walletAddresses[identity] = keypair.publicKey();
  walletSecrets[identity] = keypair.secret();
  console.log(`✅ ${identity}: ${keypair.publicKey()}`);

  // Ensure player accounts exist on selected network (even if reusing keys from .env)
  try {
    await ensureFunded(keypair.publicKey());
    console.log(`✅ ${identity} funded\n`);
  } catch (error) {
    console.warn(`⚠️  Warning: Failed to ensure ${identity} is funded, continuing anyway...`);
  }
}

// Save to deployment.json and .env for setup script to use
console.log("🔐 Player secret keys will be saved to .env (gitignored)\n");

console.log("💼 Wallet addresses:");
console.log(`  Admin:   ${walletAddresses.admin}`);
console.log(`  Player1: ${walletAddresses.player1}`);
console.log(`  Player2: ${walletAddresses.player2}\n`);

// Use admin secret for contract deployment
const adminAddress = walletAddresses.admin;
const adminSecret = adminKeypair.secret();

const deployed: Record<string, string> = { ...existingContractIds };

// Ensure mock Game Hub exists so we can pass it into game constructors.
let mockGameHubId = existingContractIds[mock.packageName] || "";
if (shouldEnsureMock) {
  const candidateMockIds = [
    existingContractIds[mock.packageName],
    existingDeployment?.mockGameHubId,
    ...(isLocal ? [] : [EXISTING_GAME_HUB_TESTNET_CONTRACT_ID]),
  ].filter(Boolean) as string[];

  for (const candidate of candidateMockIds) {
    if (await networkContractExists(candidate)) {
      mockGameHubId = candidate;
      break;
    }
  }

  if (mockGameHubId) {
    deployed[mock.packageName] = mockGameHubId;
    console.log(`✅ Using existing ${mock.packageName} on ${NETWORK}: ${mockGameHubId}\n`);
  } else {
    if (!await Bun.file(mock.wasmPath).exists()) {
      console.error("❌ Error: Missing WASM build output for mock-game-hub:");
      console.error(`  - ${mock.wasmPath}`);
      console.error("\nRun 'bun run build mock-game-hub' first");
      process.exit(1);
    }

    console.warn(`⚠️  ${mock.packageName} not found on ${NETWORK}. Deploying a new one...`);
    console.log(`Deploying ${mock.packageName}...`);
    try {
      const result =
        await $`stellar contract deploy --wasm ${mock.wasmPath} --source-account ${adminSecret} --network ${NETWORK}`.text();
      mockGameHubId = result.trim();
      deployed[mock.packageName] = mockGameHubId;
      console.log(`✅ ${mock.packageName} deployed: ${mockGameHubId}\n`);
    } catch (error) {
      console.error(`❌ Failed to deploy ${mock.packageName}:`, error);
      process.exit(1);
    }
  }
}

const deploysMyGame = contracts.some((c) => c.packageName === "my-game");
let ultrahonkVerifierId = existingContractIds[ULTRAHONK_VERIFIER_KEY] || "";
let ultrahonkVkHash = existingDeployment?.ultrahonkVkHash || "";
if (deploysMyGame) {
  const candidateVerifierIds = isLocal
    ? []
    : [
        getEnvValue(existingEnv, "ULTRAHONK_VERIFIER_CONTRACT_ID"),
        getEnvValue(existingEnv, "VITE_ULTRAHONK_VERIFIER_CONTRACT_ID"),
        existingContractIds[ULTRAHONK_VERIFIER_KEY],
        existingDeployment?.ultrahonkVerifierId,
      ].filter(Boolean) as string[];

  if (!FORCE_REDEPLOY_ULTRAHONK_VERIFIER) {
    for (const candidate of candidateVerifierIds) {
      if (await networkContractExists(candidate)) {
        ultrahonkVerifierId = candidate;
        break;
      }
    }
  } else {
    ultrahonkVerifierId = "";
  }

  if (ultrahonkVerifierId) {
    deployed[ULTRAHONK_VERIFIER_KEY] = ultrahonkVerifierId;
    console.log(`✅ Using existing ${ULTRAHONK_VERIFIER_KEY} on ${NETWORK}: ${ultrahonkVerifierId}\n`);
  } else {
    if (FORCE_REDEPLOY_ULTRAHONK_VERIFIER) {
      console.log(`♻️  Forcing fresh ${ULTRAHONK_VERIFIER_KEY} deployment on ${NETWORK} to avoid stale verifier code.`);
    }
    let verifierWasmPath = findUltraHonkVerifierWasmPath();
    const verifierHasSetVkBytes =
      verifierWasmPath ? await wasmHasFunction(verifierWasmPath, "set_vk_bytes") : false;
    let verifierWasmProtocol = verifierWasmPath
      ? await inspectWasmProtocolVersion(verifierWasmPath)
      : null;
    const needsVerifierBuild =
      FORCE_REBUILD_ULTRAHONK_VERIFIER ||
      !verifierWasmPath ||
      !verifierHasSetVkBytes ||
      (verifierWasmProtocol !== null && verifierWasmProtocol < 25);

    if (needsVerifierBuild) {
      if (!verifierHasSetVkBytes) {
        console.log("Building UltraHonk verifier WASM with set_vk_bytes support...");
      } else {
        console.log("Building protocol-25 UltraHonk verifier WASM...");
      }
      try {
        await $`stellar contract build --manifest-path ${ULTRAHONK_VERIFIER_MANIFEST_PATH}`.quiet();
      } catch (error) {
        console.error("❌ Failed to build UltraHonk verifier contract:", error);
        process.exit(1);
      }
      verifierWasmPath = findUltraHonkVerifierWasmPath();
      const rebuiltHasSetVkBytes =
        verifierWasmPath ? await wasmHasFunction(verifierWasmPath, "set_vk_bytes") : false;
      if (!rebuiltHasSetVkBytes) {
        console.error("❌ Rebuilt verifier WASM still does not expose set_vk_bytes.");
        console.error(`  WASM: ${verifierWasmPath || "(missing)"}`);
        process.exit(1);
      }
      verifierWasmProtocol = verifierWasmPath
        ? await inspectWasmProtocolVersion(verifierWasmPath)
        : null;
    }

    if (!verifierWasmPath) {
      console.error("❌ Error: UltraHonk verifier WASM not found.");
      console.error("Looked in:");
      for (const p of ULTRAHONK_VERIFIER_WASM_CANDIDATES) console.error(`  - ${p}`);
      console.error("\nAlternatively set ULTRAHONK_VERIFIER_CONTRACT_ID in .env to reuse an existing deployed verifier.");
      process.exit(1);
    }
    if (verifierWasmProtocol !== null && verifierWasmProtocol < 25) {
      console.error(`❌ Error: Selected verifier WASM is built for protocol ${verifierWasmProtocol}, which is too old for current network.`);
      console.error(`  WASM: ${verifierWasmPath}`);
      console.error("Expected protocol 25+ after auto-build but got older output.");
      process.exit(1);
    }

    console.log(`Deploying ${ULTRAHONK_VERIFIER_KEY}...`);
    try {
      const result =
        await $`stellar contract deploy --wasm ${verifierWasmPath} --source-account ${adminSecret} --network ${NETWORK}`.text();
      ultrahonkVerifierId = result.trim();
      deployed[ULTRAHONK_VERIFIER_KEY] = ultrahonkVerifierId;
      console.log(`✅ ${ULTRAHONK_VERIFIER_KEY} deployed: ${ultrahonkVerifierId}\n`);
    } catch (error) {
      console.error(`❌ Failed to deploy ${ULTRAHONK_VERIFIER_KEY}:`, error);
      process.exit(1);
    }
  }

  const vkBinPathFromEnv = getEnvValue(existingEnv, "ULTRAHONK_VK_BIN_PATH");
  const vkJsonPathFromEnv = getEnvValue(existingEnv, "ULTRAHONK_VK_JSON_PATH");
  const vkBinPath = findUltraHonkVkBinPath(vkBinPathFromEnv);
  const vkJsonPath = findUltraHonkVkJsonPath(vkJsonPathFromEnv);

  if (!vkBinPath && !vkJsonPath) {
    console.error("❌ Error: UltraHonk VK not found (binary or JSON).");
    if (vkBinPathFromEnv) console.error(`  - ULTRAHONK_VK_BIN_PATH=${vkBinPathFromEnv} (missing)`);
    if (vkJsonPathFromEnv) console.error(`  - ULTRAHONK_VK_JSON_PATH=${vkJsonPathFromEnv} (missing)`);
    console.error("Looked for binary VK in:");
    for (const p of ULTRAHONK_VK_BIN_CANDIDATES) console.error(`  - ${p}`);
    console.error("Looked for JSON VK in:");
    for (const p of ULTRAHONK_VK_JSON_CANDIDATES) console.error(`  - ${p}`);
    process.exit(1);
  }

  let vkSet = false;

  // Prefer binary VK. This is the native format consumed by ultrahonk_soroban_verifier.
  if (vkBinPath) {
    let vkHex = "";
    try {
      const vkBytes = Buffer.from(await Bun.file(vkBinPath).arrayBuffer());
      if (vkBytes.length === 0) {
        console.error(`❌ Binary VK file is empty: ${vkBinPath}`);
        process.exit(1);
      }
      vkHex = vkBytes.toString("hex");
    } catch (error) {
      console.error(`❌ Failed reading binary VK file at ${vkBinPath}:`, error);
      process.exit(1);
    }

    console.log(`Setting verifier VK (binary) from: ${vkBinPath}`);
    try {
      const setVkResult =
        await $`stellar contract invoke --id ${ultrahonkVerifierId} --source-account ${adminSecret} --network ${NETWORK} -- set_vk_bytes --vk ${vkHex}`.text();
      ultrahonkVkHash = setVkResult.trim();
      vkSet = true;
      console.log(`✅ Verifier VK set (hash: ${ultrahonkVkHash})\n`);
    } catch (error) {
      const errText = String(error);
      const missingBinarySetter =
        errText.includes("unrecognized subcommand 'set_vk_bytes'") ||
        errText.includes("function not found");
      if (!missingBinarySetter || !vkJsonPath) {
        console.error(`❌ Failed to set binary VK on ${ULTRAHONK_VERIFIER_KEY}:`, error);
        process.exit(1);
      }
      console.warn("⚠️  Deployed verifier does not expose set_vk_bytes; falling back to set_vk (JSON)...");
    }
  }

  if (!vkSet && vkJsonPath) {
    let vkJsonRaw = "";
    try {
      vkJsonRaw = await Bun.file(vkJsonPath).text();
    } catch (error) {
      console.error(`❌ Failed reading VK JSON file at ${vkJsonPath}:`, error);
      process.exit(1);
    }

    let vkJsonMinified = vkJsonRaw.trim();
    try {
      vkJsonMinified = JSON.stringify(JSON.parse(vkJsonRaw));
    } catch {
      // Keep raw contents if not strict JSON parseable; verifier will validate format.
    }

    if (!vkJsonMinified) {
      console.error(`❌ VK JSON file is empty: ${vkJsonPath}`);
      process.exit(1);
    }
    // Soroban implicit CLI parses JSON-like tokens. Our VK payload begins with `[` so
    // we must force it to be interpreted as a string literal.
    const vkJsonCliString = JSON.stringify(vkJsonMinified);

    console.log(`Setting verifier VK (JSON) from: ${vkJsonPath}`);
    try {
      const setVkResult =
        await $`stellar contract invoke --id ${ultrahonkVerifierId} --source-account ${adminSecret} --network ${NETWORK} -- set_vk --vk-json ${vkJsonCliString}`.text();
      ultrahonkVkHash = setVkResult.trim();
      vkSet = true;
      console.log(`✅ Verifier VK set (hash: ${ultrahonkVkHash})\n`);
    } catch (error) {
      console.error(`❌ Failed to set JSON VK on ${ULTRAHONK_VERIFIER_KEY}:`, error);
      process.exit(1);
    }
  }

  if (!vkSet) {
    console.error("❌ Failed to set verifier VK from available sources.");
    process.exit(1);
  }
}

for (const contract of contracts) {
  if (contract.isMockHub) continue;

  console.log(`Deploying ${contract.packageName}...`);
  try {
    if (contract.packageName === "my-game") {
      const hasSetVerifier = await wasmHasFunction(contract.wasmPath, "set_verifier");
      if (!hasSetVerifier) {
        console.warn("⚠️  Local my-game WASM does not include set_verifier. Rebuilding my-game...");
        await $`stellar contract build --manifest-path ${contract.manifestPath}`.quiet();
      }
    }

    console.log("  Installing WASM...");
    const installResult =
      await $`stellar contract install --wasm ${contract.wasmPath} --source-account ${adminSecret} --network ${NETWORK}`.text();
    const wasmHash = installResult.trim();
    console.log(`  WASM hash: ${wasmHash}`);

    console.log("  Deploying and initializing...");
    const deployResult =
      await $`stellar contract deploy --wasm-hash ${wasmHash} --source-account ${adminSecret} --network ${NETWORK} -- --admin ${adminAddress} --game-hub ${mockGameHubId}`.text();
    const contractId = deployResult.trim();
    deployed[contract.packageName] = contractId;
    if (contract.packageName === "my-game") {
      if (!ultrahonkVerifierId) {
        console.error("❌ my-game requires a verifier contract, but none is configured.");
        process.exit(1);
      }
      console.log(`  Configuring verifier: ${ultrahonkVerifierId}`);
      await $`stellar contract invoke --id ${contractId} --source-account ${adminSecret} --network ${NETWORK} -- set_verifier --verifier ${ultrahonkVerifierId}`.quiet();
      console.log("  ✅ Verifier configured");
    }
    console.log(`✅ ${contract.packageName} deployed: ${contractId}\n`);
  } catch (error) {
    console.error(`❌ Failed to deploy ${contract.packageName}:`, error);
    process.exit(1);
  }
}

console.log("🎉 Deployment complete!\n");
console.log("Contract IDs:");
const outputContracts = new Set<string>();
for (const contract of contracts) outputContracts.add(contract.packageName);
if (shouldEnsureMock) outputContracts.add(mock.packageName);
for (const contract of allContracts) {
  if (!outputContracts.has(contract.packageName)) continue;
  const id = deployed[contract.packageName];
  if (id) console.log(`  ${contract.packageName}: ${id}`);
}
if (deploysMyGame && ultrahonkVerifierId) {
  console.log(`  ${ULTRAHONK_VERIFIER_KEY}: ${ultrahonkVerifierId}`);
}

const twentyOneId = deployed["twenty-one"] || "";
const numberGuessId = deployed["number-guess"] || "";

const deploymentContracts = allContracts.reduce<Record<string, string>>((acc, contract) => {
  acc[contract.packageName] = deployed[contract.packageName] || "";
  return acc;
}, {});

const deploymentInfo = {
  mockGameHubId,
  twentyOneId,
  numberGuessId,
  ultrahonkVerifierId,
  ultrahonkVkHash,
  contracts: deploymentContracts,
  network: NETWORK,
  rpcUrl: RPC_URL,
  networkPassphrase: NETWORK_PASSPHRASE,
  wallets: {
    admin: walletAddresses.admin,
    player1: walletAddresses.player1,
    player2: walletAddresses.player2,
  },
  deployedAt: new Date().toISOString(),
};

await Bun.write('deployment.json', JSON.stringify(deploymentInfo, null, 2) + '\n');
console.log("\n✅ Wrote deployment info to deployment.json");

const contractEnvLines = allContracts
  .map((c) => `VITE_${c.envKey}_CONTRACT_ID=${deploymentContracts[c.packageName] || ""}`)
  .join("\n");

const envContent = `# Auto-generated by deploy script
# Do not edit manually - run 'bun run deploy' (or 'bun run setup') to regenerate
# WARNING: This file contains secret keys. Never commit to git!

VITE_SOROBAN_RPC_URL=${RPC_URL}
VITE_NETWORK_PASSPHRASE=${NETWORK_PASSPHRASE}
${contractEnvLines}
VITE_ULTRAHONK_VERIFIER_CONTRACT_ID=${ultrahonkVerifierId}

# Dev wallet addresses for testing
VITE_DEV_ADMIN_ADDRESS=${walletAddresses.admin}
VITE_DEV_PLAYER1_ADDRESS=${walletAddresses.player1}
VITE_DEV_PLAYER2_ADDRESS=${walletAddresses.player2}

# Dev wallet secret keys (WARNING: Never commit this file!)
VITE_DEV_PLAYER1_SECRET=${walletSecrets.player1}
VITE_DEV_PLAYER2_SECRET=${walletSecrets.player2}
`;

await Bun.write('.env', envContent + '\n');
console.log("✅ Wrote secrets to .env (gitignored)");

export { mockGameHubId, deployed };
