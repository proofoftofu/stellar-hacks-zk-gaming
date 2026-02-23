import { Buffer } from 'node:buffer';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Noir } from '@noir-lang/noir_js';
import { UltraHonkBackend } from '@aztec/bb.js';

let cachedCircuit = null;
let cachedBackend = null;
let cachedCrsPath = null;

function assertCond(condition, message) {
  if (!condition) throw new Error(message);
}

function packGuess(guess) {
  return ((guess[0] << 24) | (guess[1] << 16) | (guess[2] << 8) | guess[3]) >>> 0;
}

function findCircuitJsonPath() {
  const envPath = process.env.ZK_CIRCUIT_JSON_PATH;
  if (envPath && existsSync(envPath)) return envPath;

  const candidates = [
    resolve(process.cwd(), 'my-game-circuit/target/my_game.json'),
    resolve(process.cwd(), 'my-game-circuit/my_game.json'),
    resolve(process.cwd(), 'api/zk/my_game.json'),
    resolve(process.cwd(), 'zk/my-game-circuit/target/my_game.json'),
    resolve(process.cwd(), '../zk/my-game-circuit/target/my_game.json'),
    resolve(process.cwd(), '../../zk/my-game-circuit/target/my_game.json'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    'Could not find my_game.json circuit artifact. Set ZK_CIRCUIT_JSON_PATH or place file in api/zk/my_game.json.',
  );
}

function loadCircuit() {
  if (cachedCircuit) return cachedCircuit;
  const path = findCircuitJsonPath();
  cachedCircuit = JSON.parse(readFileSync(path, 'utf8'));
  return cachedCircuit;
}

function getBackend(bytecode) {
  if (!cachedBackend) {
    const crsPath = process.env.BB_CRS_PATH || '/tmp/.bb-crs';
    mkdirSync(crsPath, { recursive: true });
    cachedCrsPath = crsPath;
    cachedBackend = new UltraHonkBackend(bytecode, { crsPath });
  }
  return cachedBackend;
}

function encodeField(value) {
  assertCond(value >= 0n, `field value must be non-negative, got ${value.toString()}`);
  const out = Buffer.alloc(32, 0);
  let x = value;
  for (let i = 31; i >= 0 && x > 0n; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function buildPublicInputs(input) {
  const packed = packGuess(input.guess);
  return Buffer.concat([
    encodeField(BigInt(input.sessionId >>> 0)),
    encodeField(BigInt(input.guessId >>> 0)),
    encodeField(BigInt(input.commitmentDec)),
    encodeField(BigInt(packed)),
    encodeField(BigInt(input.exact >>> 0)),
    encodeField(BigInt(input.partial >>> 0)),
  ]);
}

function buildProofBlob(publicInputs, proof) {
  assertCond(publicInputs.length % 32 === 0, `public_inputs length must be multiple of 32, got ${publicInputs.length}`);
  assertCond(proof.length % 32 === 0, `proof length must be multiple of 32, got ${proof.length}`);
  const totalFields = (publicInputs.length + proof.length) / 32;
  const header = Buffer.alloc(4);
  header.writeUInt32BE(totalFields, 0);
  return Buffer.concat([header, publicInputs, proof]);
}

export async function proveTurnWithJs(input) {
  // Vercel lambdas only allow writes under /tmp. bb.js defaults to $HOME/.bb-crs.
  if (!process.env.HOME || process.env.HOME.startsWith('/var/task')) {
    process.env.HOME = '/tmp';
  }
  if (!process.env.BB_CRS_PATH) {
    process.env.BB_CRS_PATH = '/tmp/.bb-crs';
  }
  if (cachedCrsPath !== process.env.BB_CRS_PATH) {
    cachedBackend = null;
    cachedCrsPath = null;
  }

  const circuit = loadCircuit();
  const noir = new Noir(circuit);
  const noirInputs = {
    session_id: input.sessionId,
    guess_id: input.guessId,
    commitment: input.commitmentDec,
    guess_packed: packGuess(input.guess),
    exact: input.exact,
    partial: input.partial,
    salt: [...input.salt],
    secret: [...input.secret],
    guess: [...input.guess],
  };
  const { witness } = await noir.execute(noirInputs);
  const backend = getBackend(circuit.bytecode);
  const proofResult = await backend.generateProof(witness, { keccak: true });
  const publicInputs = buildPublicInputs(input);
  return buildProofBlob(publicInputs, Buffer.from(proofResult.proof));
}
