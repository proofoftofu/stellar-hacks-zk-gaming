import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { Keypair, TransactionBuilder, hash } from '@stellar/stellar-sdk';
import { Client as MyGameClient } from '../games/my-game/bindings';

type EnvMap = Record<string, string>;
type Guess4 = [number, number, number, number];
type Salt16 = [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number
];

type TurnProofInput = {
  sessionId: number;
  guessId: number;
  commitmentDec: string;
  guess: Guess4;
  exact: number;
  partial: number;
  secret: Guess4;
  salt: Salt16;
};

function parseEnv(content: string): EnvMap {
  const out: EnvMap = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    out[key] = value;
  }
  return out;
}

function loadRootEnv(): EnvMap {
  const candidates = [
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), '../.env'),
    resolve(process.cwd(), '../../.env'),
  ];
  for (const envPath of candidates) {
    try {
      const content = readFileSync(envPath, 'utf8');
      const parsed = parseEnv(content);
      if (parsed.VITE_MY_GAME_CONTRACT_ID) return parsed;
    } catch {
      // Try next path.
    }
  }
  throw new Error('Could not find workspace .env with VITE_MY_GAME_CONTRACT_ID');
}

function must(env: EnvMap, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

function signerFor(source: Keypair, all: Record<string, Keypair>) {
  return {
    signTransaction: async (txXdr: string, opts?: { networkPassphrase?: string }) => {
      if (!opts?.networkPassphrase) throw new Error('signTransaction missing networkPassphrase');
      const tx = TransactionBuilder.fromXDR(txXdr, opts.networkPassphrase);
      tx.sign(source);
      return { signedTxXdr: tx.toXDR() };
    },
    signAuthEntry: async (preimageXdr: string, opts?: { address?: string }) => {
      const address = opts?.address;
      if (!address) throw new Error('signAuthEntry missing address');
      const kp = all[address];
      if (!kp) throw new Error(`No keypair for auth address: ${address}`);
      const payload = hash(Buffer.from(preimageXdr, 'base64'));
      const sig = kp.sign(payload);
      return { signedAuthEntry: Buffer.from(sig).toString('base64') };
    },
  };
}

function signAuthEntryWith(
  signerKp: Keypair,
  expectedAddress: string,
): (preimageXdr: string, opts?: { address?: string }) => Promise<{ signedAuthEntry: string }> {
  return async (preimageXdr: string, opts?: { address?: string }) => {
    const address = opts?.address;
    if (address && address !== expectedAddress) {
      throw new Error(`signAuthEntry address mismatch: expected ${expectedAddress}, got ${address}`);
    }
    const payload = hash(Buffer.from(preimageXdr, 'base64'));
    const sig = signerKp.sign(payload);
    return { signedAuthEntry: Buffer.from(sig).toString('base64') };
  };
}

function appendU32Field(out: number[], value: number) {
  const field = new Uint8Array(32);
  const v = value >>> 0;
  field[28] = (v >>> 24) & 0xff;
  field[29] = (v >>> 16) & 0xff;
  field[30] = (v >>> 8) & 0xff;
  field[31] = v & 0xff;
  out.push(...field);
}

function appendGuessField(out: number[], guess: Uint8Array) {
  const field = new Uint8Array(32);
  field[28] = guess[0] ?? 0;
  field[29] = guess[1] ?? 0;
  field[30] = guess[2] ?? 0;
  field[31] = guess[3] ?? 0;
  out.push(...field);
}

function buildPublicInputs(
  sessionId: number,
  guessId: number,
  commitment: Uint8Array,
  guess: Uint8Array,
  exact: number,
  partial: number,
): Buffer {
  const out: number[] = [];
  appendU32Field(out, sessionId);
  appendU32Field(out, guessId);
  out.push(...commitment);
  appendGuessField(out, guess);
  appendU32Field(out, exact);
  appendU32Field(out, partial);
  return Buffer.from(out);
}

function buildSyntheticProofBlob(publicInputs: Buffer): Buffer {
  const proofFields = 440;
  const totalFields = proofFields + publicInputs.length / 32;
  const header = Buffer.alloc(4);
  header.writeUInt32BE(totalFields, 0);
  const proof = Buffer.alloc(proofFields * 32, 1);
  return Buffer.concat([header, publicInputs, proof]);
}

function buildProofBlobFromBb(publicInputs: Buffer, proof: Buffer): Buffer {
  if (publicInputs.length % 32 !== 0) {
    throw new Error(`public_inputs length must be multiple of 32, got ${publicInputs.length}`);
  }
  if (proof.length % 32 !== 0) {
    throw new Error(`proof length must be multiple of 32, got ${proof.length}`);
  }
  const totalFields = (publicInputs.length + proof.length) / 32;
  const header = Buffer.alloc(4);
  header.writeUInt32BE(totalFields, 0);
  return Buffer.concat([header, publicInputs, proof]);
}

function toTomlArray(values: number[]): string {
  return `[${values.map((v) => `"${v}"`).join(', ')}]`;
}

function packGuess(guess: Guess4): number {
  return ((guess[0] << 24) | (guess[1] << 16) | (guess[2] << 8) | guess[3]) >>> 0;
}

function computeFeedback(secret: Guess4, guess: Guess4): { exact: number; partial: number } {
  let exact = 0;
  for (let i = 0; i < 4; i++) {
    if (secret[i] === guess[i]) exact += 1;
  }
  let totalMatches = 0;
  for (let d = 1; d <= 6; d++) {
    const secretCount = secret.filter((x) => x === d).length;
    const guessCount = guess.filter((x) => x === d).length;
    totalMatches += Math.min(secretCount, guessCount);
  }
  return { exact, partial: totalMatches - exact };
}

function blakeCommitment(secret: Guess4, salt: Salt16): string {
  const preimage = Buffer.from([...secret, ...salt]);
  const digest = createHash('blake2s256').update(preimage).digest();
  let value = 0n;
  for (let i = 0; i < 31; i++) {
    value = (value << 8n) + BigInt(digest[i]);
  }
  return value.toString();
}

function commitmentFieldBytes(commitmentDec: string): Buffer {
  const v = BigInt(commitmentDec);
  const out = Buffer.alloc(32, 0);
  let x = v;
  for (let i = 31; i >= 0 && x > 0n; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function findCircuitDir(): string {
  const candidates = [
    resolve(process.cwd(), 'zk/my-game-circuit'),
    resolve(process.cwd(), '../zk/my-game-circuit'),
    resolve(process.cwd(), '../../zk/my-game-circuit'),
  ];
  for (const p of candidates) {
    if (existsSync(resolve(p, 'Nargo.toml'))) return p;
  }
  throw new Error('Could not find zk/my-game-circuit (missing Nargo.toml)');
}

function buildProverToml(input: TurnProofInput): string {
  return [
    '# Auto-generated by test-proof.ts',
    `session_id = "${input.sessionId}"`,
    `guess_id = "${input.guessId}"`,
    `commitment = "${input.commitmentDec}"`,
    `guess_packed = "${packGuess(input.guess)}"`,
    `exact = "${input.exact}"`,
    `partial = "${input.partial}"`,
    `salt = ${toTomlArray(input.salt)}`,
    `secret = ${toTomlArray(input.secret)}`,
    `guess = ${toTomlArray(input.guess)}`,
    '',
  ].join('\n');
}

function runCmd(cmd: string, args: string[], cwd: string) {
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

function proveTurn(input: TurnProofInput): Buffer {
  const circuitDir = findCircuitDir();
  const proverTomlPath = resolve(circuitDir, 'Prover.toml');
  const previousToml = existsSync(proverTomlPath) ? readFileSync(proverTomlPath, 'utf8') : null;
  try {
    writeFileSync(proverTomlPath, buildProverToml(input), 'utf8');
    runCmd('nargo', ['execute'], circuitDir);
    runCmd('bb', ['prove', '-b', 'target/my_game.json', '-w', 'target/my_game.gz', '-o', 'target', '--scheme', 'ultra_honk', '--oracle_hash', 'keccak'], circuitDir);
    const proof = Buffer.from(readFileSync(resolve(circuitDir, 'target/proof')));
    const publicInputs = Buffer.from(readFileSync(resolve(circuitDir, 'target/public_inputs')));
    return buildProofBlobFromBb(publicInputs, proof);
  } finally {
    if (previousToml !== null) {
      writeFileSync(proverTomlPath, previousToml, 'utf8');
    }
  }
}

function classifyFailure(error: unknown): string {
  const text = String(error);
  if (text.includes('InvalidProof') || text.includes('Contract, #11')) return 'InvalidProof';
  if (text.includes('InvalidPublicInputs') || text.includes('Contract, #10')) return 'InvalidPublicInputs';
  if (text.includes('VerifierNotSet') || text.includes('Contract, #13')) return 'VerifierNotSet';
  if (text.includes('Budget') || text.includes('ExceededLimit')) return 'BudgetExceeded';
  return 'Unknown';
}

function findContractCodes(error: unknown): number[] {
  const text = String(error);
  const matches = [...text.matchAll(/Error\(Contract,\s*#(\d+)\)/g)];
  return matches.map((m) => Number(m[1]));
}

function parseSessionIdArg(argv: string[]): number {
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('-')) continue;
    const n = Number(arg);
    if (Number.isInteger(n) && n >= 0 && n <= 0xffff_ffff) {
      return n;
    }
  }
  return Date.now() % 1_000_000_000;
}

async function run() {
  const env = loadRootEnv();
  const rpcUrl = must(env, 'VITE_SOROBAN_RPC_URL');
  const networkPassphrase = must(env, 'VITE_NETWORK_PASSPHRASE');
  const contractId = must(env, 'VITE_MY_GAME_CONTRACT_ID');
  const p1Secret = must(env, 'VITE_DEV_PLAYER1_SECRET');
  const p2Secret = must(env, 'VITE_DEV_PLAYER2_SECRET');

  const p1 = Keypair.fromSecret(p1Secret);
  const p2 = Keypair.fromSecret(p2Secret);
  const allowHttp = rpcUrl.startsWith('http://');
  const keyByAddress: Record<string, Keypair> = {
    [p1.publicKey()]: p1,
    [p2.publicKey()]: p2,
  };

  const player1Client = new MyGameClient({
    contractId,
    rpcUrl,
    networkPassphrase,
    allowHttp,
    publicKey: p1.publicKey(),
    ...signerFor(p1, keyByAddress),
  });

  const player2Client = new MyGameClient({
    contractId,
    rpcUrl,
    networkPassphrase,
    allowHttp,
    publicKey: p2.publicKey(),
    ...signerFor(p2, keyByAddress),
  });

  const startClient = new MyGameClient({
    contractId,
    rpcUrl,
    networkPassphrase,
    allowHttp,
    publicKey: p2.publicKey(),
    ...signerFor(p2, keyByAddress),
  });

  const mode = process.argv.includes('--valid') ? 'valid' : 'smoke';
  let sessionId = parseSessionIdArg(process.argv);
  const stake = 100_0000000n;
  let commitment: Buffer<ArrayBufferLike> = Buffer.alloc(32, 7);
  let guess: Buffer<ArrayBufferLike> = Buffer.from([1, 2, 3, 4]);
  let exact = 1;
  let partial = 1;
  let expectedGuessId = 0;
  let validProofBlob: Buffer | null = null;
  let runtimeProofInput: TurnProofInput | null = null;

  if (mode === 'valid') {
    const secret: Guess4 = [1, 2, 3, 4];
    const salt: Salt16 = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26];
    const guessArr: Guess4 = [1, 2, 3, 4];
    const feedback = computeFeedback(secret, guessArr);
    const commitmentDec = blakeCommitment(secret, salt);

    expectedGuessId = 0;
    commitment = commitmentFieldBytes(commitmentDec);
    guess = Buffer.from(guessArr);
    exact = feedback.exact;
    partial = feedback.partial;

    // defer proving until we know actual on-chain guess_id; then create proof runtime.
    runtimeProofInput = {
      sessionId,
      guessId: 0,
      commitmentDec,
      guess: guessArr,
      exact,
      partial,
      secret,
      salt,
    };
  }

  console.log(`Mode: ${mode}`);
  console.log(`Using contract: ${contractId}`);
  console.log(`Session ID: ${sessionId}`);
  const verifierTx = await player1Client.get_verifier();
  const verifierSim = await verifierTx.simulate();
  const verifier = verifierSim.result;
  if (!verifier) {
    throw new Error('my-game verifier is not configured (set_verifier missing)');
  }
  console.log(`Verifier: ${verifier}`);

  console.log('1) start_game (2-player auth)');
  const startTx = await startClient.start_game({
    session_id: sessionId,
    player1: p1.publicKey(),
    player2: p2.publicKey(),
    player1_points: stake,
    player2_points: stake,
  });
  const whoNeeds = startTx.needsNonInvokerSigningBy();
  console.log(`   non-invoker auth needed by: ${whoNeeds.length ? whoNeeds.join(', ') : '(none)'}`);
  if (whoNeeds.includes(p1.publicKey())) {
    await startTx.signAuthEntries({
      address: p1.publicKey(),
      signAuthEntry: signAuthEntryWith(p1, p1.publicKey()),
    });
  }
  await startTx.signAndSend();

  console.log('2) commit_code (player1)');
  const commitTx = await player1Client.commit_code({
    session_id: sessionId,
    commitment,
  });
  await commitTx.signAndSend();

  console.log('3) submit_guess (player2)');
  const guessTx = await player2Client.submit_guess({
    session_id: sessionId,
    guess,
  });
  await guessTx.signAndSend();

  const gameTx = await player1Client.get_game({ session_id: sessionId });
  const gameSim = await gameTx.simulate();
  if (!gameSim.result.isOk()) {
    throw new Error(`get_game failed after submit_guess: ${String(gameSim.result)}`);
  }
  const game = gameSim.result.unwrap();
  if (game.pending_guess_id === undefined || game.pending_guess_id === null) {
    throw new Error('No pending_guess_id after submit_guess');
  }
  const guessId = Number(game.pending_guess_id);
  console.log(`   guess_id=${guessId}`);

  if (mode === 'valid') {
    if (!runtimeProofInput) throw new Error('Internal error: runtime proof input missing');
    runtimeProofInput.guessId = guessId;
    if (guessId !== expectedGuessId) {
      throw new Error(`guess_id mismatch: on-chain ${guessId}, expected ${expectedGuessId}`);
    }
    validProofBlob = proveTurn(runtimeProofInput);

    console.log('4) submit_feedback_proof with runtime-generated proof blob');
    const validTx = await player1Client.submit_feedback_proof({
      session_id: sessionId,
      guess_id: guessId,
      exact,
      partial,
      proof_blob: validProofBlob,
    });
    await validTx.signAndSend();
    console.log('✅ Valid proof accepted by my-game contract.');
    return;
  }

  console.log('4) submit_feedback_proof with synthetic proof blob');
  const publicInputs = buildPublicInputs(sessionId, guessId, commitment, guess, exact, partial);
  const proofBlob = buildSyntheticProofBlob(publicInputs);

  console.log('   4a) guard check: expect InvalidPublicInputs');
  const wrongPublicInputs = buildPublicInputs(
    sessionId,
    guessId,
    commitment,
    guess,
    exact + 1,
    partial,
  );
  const wrongBlob = buildSyntheticProofBlob(wrongPublicInputs);
  try {
    const guardTx = await player1Client.submit_feedback_proof({
      session_id: sessionId,
      guess_id: guessId,
      exact,
      partial,
      proof_blob: wrongBlob,
    });
    await guardTx.signAndSend();
    console.log('❌ Guard check unexpectedly passed.');
    process.exit(1);
  } catch (error) {
    const kind = classifyFailure(error);
    if (kind !== 'InvalidPublicInputs') {
      console.error(`❌ Guard check failed with unexpected error: ${kind}`);
      console.error(String(error));
      process.exit(1);
    }
    console.log('   ✅ InvalidPublicInputs guard works');
  }

  console.log('   4b) verifier path check: expect InvalidProof or BudgetExceeded');

  try {
    const proofTx = await player1Client.submit_feedback_proof({
      session_id: sessionId,
      guess_id: guessId,
      exact,
      partial,
      proof_blob: proofBlob,
    });
    await proofTx.signAndSend();
    console.log('✅ Proof accepted (unexpected for synthetic proof).');
  } catch (error) {
    const kind = classifyFailure(error);
    if (kind === 'InvalidProof') {
      console.log('✅ Proof path reached verifier. Synthetic proof correctly rejected as InvalidProof.');
      return;
    }
    if (kind === 'BudgetExceeded') {
      console.log('✅ Proof path reached verifier, but execution exceeded testnet budget (expected for heavy verifier).');
      return;
    }
    console.error(`❌ submit_feedback_proof failed with ${kind}`);
    console.error(String(error));
    process.exit(1);
  }
}

run().catch((error) => {
  console.error('❌ proof smoke test failed');
  console.error(String(error));
  const codes = findContractCodes(error);
  if (codes.length > 0) {
    console.error(`Detected contract error codes: ${codes.join(', ')}`);
    if (codes.includes(11) && codes.includes(1)) {
      console.error('Hint: my-game InvalidProof (#11) wrapped verifier VkParseError (#1). Redeploy verifier + set binary VK again.');
    }
  }
  process.exit(1);
});
