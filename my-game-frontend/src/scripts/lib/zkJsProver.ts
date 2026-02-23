import { Buffer } from 'node:buffer';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Noir } from '@noir-lang/noir_js';
import { UltraHonkBackend } from '@aztec/bb.js';

export type Guess4 = [number, number, number, number];
export type Salt16 = [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number
];

export type TurnProofInput = {
  sessionId: number;
  guessId: number;
  commitmentDec: string;
  guess: Guess4;
  exact: number;
  partial: number;
  secret: Guess4;
  salt: Salt16;
};

type NoirProofResult = {
  proof: Uint8Array;
};

type NoirExecutionResult = {
  witness: Uint8Array;
};

type NoirInstance = {
  execute: (inputs: Record<string, unknown>) => Promise<NoirExecutionResult>;
};

type CompiledCircuit = {
  bytecode: string;
};

let cachedCircuit: CompiledCircuit | null = null;
let cachedBackend: UltraHonkBackend | null = null;

function assertCond(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function packGuess(guess: Guess4): number {
  return ((guess[0] << 24) | (guess[1] << 16) | (guess[2] << 8) | guess[3]) >>> 0;
}

function findCircuitJsonPath(): string {
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

function loadCircuit(): CompiledCircuit {
  if (cachedCircuit) return cachedCircuit;
  const path = findCircuitJsonPath();
  cachedCircuit = JSON.parse(readFileSync(path, 'utf8')) as CompiledCircuit;
  return cachedCircuit;
}

function getBackend(bytecode: string): UltraHonkBackend {
  if (!cachedBackend) {
    cachedBackend = new UltraHonkBackend(bytecode);
  }
  return cachedBackend;
}

function encodeField(value: bigint): Buffer {
  assertCond(value >= 0n, `field value must be non-negative, got ${value.toString()}`);
  const out = Buffer.alloc(32, 0);
  let x = value;
  for (let i = 31; i >= 0 && x > 0n; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function buildPublicInputs(input: TurnProofInput): Buffer {
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

function buildProofBlob(publicInputs: Buffer, proof: Buffer): Buffer {
  assertCond(publicInputs.length % 32 === 0, `public_inputs length must be multiple of 32, got ${publicInputs.length}`);
  assertCond(proof.length % 32 === 0, `proof length must be multiple of 32, got ${proof.length}`);
  const totalFields = (publicInputs.length + proof.length) / 32;
  const header = Buffer.alloc(4);
  header.writeUInt32BE(totalFields, 0);
  return Buffer.concat([header, publicInputs, proof]);
}

export async function proveTurnWithJs(input: TurnProofInput): Promise<Buffer> {
  const circuit = loadCircuit();
  const noir = new Noir(circuit as never) as unknown as NoirInstance;
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
  const proofResult = await backend.generateProof(witness, { keccak: true }) as NoirProofResult;
  const publicInputs = buildPublicInputs(input);
  return buildProofBlob(publicInputs, Buffer.from(proofResult.proof));
}
