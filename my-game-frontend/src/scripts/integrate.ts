import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Buffer } from 'node:buffer';
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

function assertCond(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function findContractErrorCodes(error: unknown): number[] {
  const text = String(error);
  const matches = [...text.matchAll(/Error\(Contract,\s*#(\d+)\)/g)];
  return matches.map((m) => Number(m[1]));
}

async function expectContractFailure(
  name: string,
  run: () => Promise<void>,
  expectedCodes: number[],
) {
  try {
    await run();
  } catch (error) {
    const codes = findContractErrorCodes(error);
    for (const code of expectedCodes) {
      if (codes.includes(code)) {
        console.log(`  ✅ ${name} rejected (contract #${code})`);
        return;
      }
    }
    throw new Error(
      `${name} failed with unexpected error. expected one of [${expectedCodes.join(', ')}], got [${codes.join(', ')}]\n${String(error)}`,
    );
  }
  throw new Error(`${name} unexpectedly succeeded`);
}

function expectProverFailure(name: string, run: () => void) {
  try {
    run();
  } catch {
    console.log(`  ✅ ${name} prover attempt rejected`);
    return;
  }
  throw new Error(`${name} prover attempt unexpectedly succeeded`);
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
    '# Auto-generated by integrate.ts',
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

function buildProofBlob(publicInputs: Buffer, proof: Buffer): Buffer {
  assertCond(publicInputs.length % 32 === 0, `public_inputs length must be multiple of 32, got ${publicInputs.length}`);
  assertCond(proof.length % 32 === 0, `proof length must be multiple of 32, got ${proof.length}`);
  const totalFields = (publicInputs.length + proof.length) / 32;
  const header = Buffer.alloc(4);
  header.writeUInt32BE(totalFields, 0);
  return Buffer.concat([header, publicInputs, proof]);
}

function parseU32Field(field: Buffer): number {
  return (
    ((field[28] ?? 0) << 24) |
    ((field[29] ?? 0) << 16) |
    ((field[30] ?? 0) << 8) |
    (field[31] ?? 0)
  ) >>> 0;
}

function assertPublicInputsMatch(input: TurnProofInput, publicInputs: Buffer) {
  assertCond(publicInputs.length === 192, `expected 192-byte public_inputs, got ${publicInputs.length}`);
  const sid = parseU32Field(publicInputs.subarray(0, 32));
  const gid = parseU32Field(publicInputs.subarray(32, 64));
  const commitment = publicInputs.subarray(64, 96);
  const guess = publicInputs.subarray(124, 128);
  const exact = parseU32Field(publicInputs.subarray(128, 160));
  const partial = parseU32Field(publicInputs.subarray(160, 192));
  assertCond(sid === input.sessionId, `public_inputs session_id mismatch: ${sid} != ${input.sessionId}`);
  assertCond(gid === input.guessId, `public_inputs guess_id mismatch: ${gid} != ${input.guessId}`);
  assertCond(commitment.equals(commitmentFieldBytes(input.commitmentDec)), 'public_inputs commitment mismatch');
  assertCond(Buffer.from(guess).equals(Buffer.from(input.guess)), 'public_inputs guess mismatch');
  assertCond(exact === input.exact, `public_inputs exact mismatch: ${exact} != ${input.exact}`);
  assertCond(partial === input.partial, `public_inputs partial mismatch: ${partial} != ${input.partial}`);
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
    assertPublicInputsMatch(input, publicInputs);
    return buildProofBlob(publicInputs, proof);
  } finally {
    if (previousToml !== null) {
      writeFileSync(proverTomlPath, previousToml, 'utf8');
    }
  }
}

async function fetchGameState(client: MyGameClient, sessionId: number) {
  const gameTx = await client.get_game({ session_id: sessionId });
  const gameSim = await gameTx.simulate();
  assertCond(gameSim.result.isOk(), `get_game failed for session ${sessionId}`);
  return gameSim.result.unwrap();
}

async function startGame(
  startClient: MyGameClient,
  player1Signer: Keypair,
  sessionId: number,
  player1: string,
  player2: string,
  stake: bigint,
) {
  const startTx = await startClient.start_game({
    session_id: sessionId,
    player1,
    player2,
    player1_points: stake,
    player2_points: stake,
  });
  const whoNeeds = startTx.needsNonInvokerSigningBy();
  if (whoNeeds.includes(player1)) {
    await startTx.signAuthEntries({
      address: player1,
      signAuthEntry: signAuthEntryWith(player1Signer, player1),
    });
  }
  await startTx.signAndSend();
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

  const stake = 100_0000000n;
  const secret: Guess4 = [1, 2, 3, 4];
  const salt: Salt16 = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26];
  const commitmentDec = blakeCommitment(secret, salt);
  const commitmentBytes = commitmentFieldBytes(commitmentDec);
  const baseSession = Number(process.argv[2] || ((Date.now() % 900_000_000) + 10_000_000));

  console.log(`Using contract: ${contractId}`);
  console.log(`Player1: ${p1.publicKey()}`);
  console.log(`Player2: ${p2.publicKey()}`);
  console.log(`Commitment(dec): ${commitmentDec}`);

  console.log('\nScenario 1: Player2 solves and wins');
  const solveSession = baseSession;
  const solveGuess: Guess4 = [1, 2, 3, 4];
  const solveFeedback = computeFeedback(secret, solveGuess);
  assertCond(solveFeedback.exact === 4, 'solve scenario should produce exact=4');

  await startGame(startClient, p1, solveSession, p1.publicKey(), p2.publicKey(), stake);
  await (await player1Client.commit_code({ session_id: solveSession, commitment: commitmentBytes })).signAndSend();
  await (await player2Client.submit_guess({ session_id: solveSession, guess: Buffer.from(solveGuess) })).signAndSend();

  const solveBefore = await fetchGameState(player1Client, solveSession);
  const solveGuessId = Number(solveBefore.pending_guess_id);
  assertCond(solveGuessId === 0, `solve scenario expected guess_id=0, got ${String(solveBefore.pending_guess_id)}`);

  const solveProofBlob = proveTurn({
    sessionId: solveSession,
    guessId: solveGuessId,
    commitmentDec,
    guess: solveGuess,
    exact: solveFeedback.exact,
    partial: solveFeedback.partial,
    secret,
    salt,
  });
  await (await player1Client.submit_feedback_proof({
    session_id: solveSession,
    guess_id: solveGuessId,
    exact: solveFeedback.exact,
    partial: solveFeedback.partial,
    proof_blob: solveProofBlob,
  })).signAndSend();

  const solveAfter = await fetchGameState(player1Client, solveSession);
  assertCond(!!solveAfter.ended, 'solve scenario: game should be ended');
  assertCond(!!solveAfter.solved, 'solve scenario: solved should be true');
  assertCond(solveAfter.winner === p2.publicKey(), 'solve scenario: winner should be player2');
  console.log('  ✅ Scenario 1 passed');

  console.log('\nScenario 2: Player2 fails 12 times and Player1 wins');
  const failSession = baseSession + 1;
  const failGuesses: Guess4[] = [
    [4, 3, 2, 1],
    [1, 2, 3, 5],
    [1, 2, 3, 6],
    [1, 2, 4, 5],
    [1, 2, 4, 6],
    [1, 2, 5, 6],
    [1, 3, 4, 5],
    [1, 3, 4, 6],
    [1, 3, 5, 6],
    [1, 4, 5, 6],
    [2, 3, 4, 5],
    [2, 3, 4, 6],
  ];

  await startGame(startClient, p1, failSession, p1.publicKey(), p2.publicKey(), stake);
  await (await player1Client.commit_code({ session_id: failSession, commitment: commitmentBytes })).signAndSend();

  for (let i = 0; i < failGuesses.length; i++) {
    const guess = failGuesses[i];
    const fb = computeFeedback(secret, guess);
    assertCond(!(fb.exact === 4), `fail scenario attempt ${i} unexpectedly solves`);

    await (await player2Client.submit_guess({ session_id: failSession, guess: Buffer.from(guess) })).signAndSend();
    const before = await fetchGameState(player1Client, failSession);
    const guessId = Number(before.pending_guess_id);
    assertCond(guessId === i, `fail scenario attempt ${i}: expected guess_id=${i}, got ${String(before.pending_guess_id)}`);

    const proofBlob = proveTurn({
      sessionId: failSession,
      guessId,
      commitmentDec,
      guess,
      exact: fb.exact,
      partial: fb.partial,
      secret,
      salt,
    });

    await (await player1Client.submit_feedback_proof({
      session_id: failSession,
      guess_id: guessId,
      exact: fb.exact,
      partial: fb.partial,
      proof_blob: proofBlob,
    })).signAndSend();
  }

  const failAfter = await fetchGameState(player1Client, failSession);
  assertCond(!!failAfter.ended, 'fail scenario: game should be ended');
  assertCond(!failAfter.solved, 'fail scenario: solved should be false');
  assertCond(failAfter.winner === p1.publicKey(), 'fail scenario: winner should be player1');
  assertCond(Number(failAfter.attempts_used) === 12, `fail scenario: attempts_used should be 12, got ${String(failAfter.attempts_used)}`);
  console.log('  ✅ Scenario 2 passed');

  console.log('\nScenario 3: Security bypass attempts are rejected');
  const attackSession = baseSession + 2;
  const attackGuess: Guess4 = [1, 2, 3, 5];
  const attackFeedback = computeFeedback(secret, attackGuess);

  await startGame(startClient, p1, attackSession, p1.publicKey(), p2.publicKey(), stake);
  await (await player1Client.commit_code({ session_id: attackSession, commitment: commitmentBytes })).signAndSend();

  await (await player2Client.submit_guess({ session_id: attackSession, guess: Buffer.from(attackGuess) })).signAndSend();
  await expectContractFailure(
    'double guess while pending feedback',
    async () => {
      await (await player2Client.submit_guess({ session_id: attackSession, guess: Buffer.from([4, 3, 2, 1]) })).signAndSend();
    },
    [6], // GuessPendingFeedback
  );

  const attackBefore = await fetchGameState(player1Client, attackSession);
  const attackGuessId = Number(attackBefore.pending_guess_id);

  // Try to prove a lie directly: this should fail during proving.
  const liedExact = attackFeedback.exact === 4 ? 3 : attackFeedback.exact + 1;
  const liedPartial = attackFeedback.partial;
  expectProverFailure(
    'prove a lie (wrong exact/partial)',
    () => {
      proveTurn({
        sessionId: attackSession,
        guessId: attackGuessId,
        commitmentDec,
        guess: attackGuess,
        exact: liedExact,
        partial: liedPartial,
        secret,
        salt,
      });
    },
  );

  const validAttackProof = proveTurn({
    sessionId: attackSession,
    guessId: attackGuessId,
    commitmentDec,
    guess: attackGuess,
    exact: attackFeedback.exact,
    partial: attackFeedback.partial,
    secret,
    salt,
  });

  await expectContractFailure(
    'wrong guess_id in feedback proof',
    async () => {
      await (await player1Client.submit_feedback_proof({
        session_id: attackSession,
        guess_id: attackGuessId + 1,
        exact: attackFeedback.exact,
        partial: attackFeedback.partial,
        proof_blob: validAttackProof,
      })).signAndSend();
    },
    [8], // InvalidGuessId
  );

  await expectContractFailure(
    'tampered feedback values with otherwise valid proof',
    async () => {
      await (await player1Client.submit_feedback_proof({
        session_id: attackSession,
        guess_id: attackGuessId,
        exact: 0,
        partial: 0,
        proof_blob: validAttackProof,
      })).signAndSend();
    },
    [10], // InvalidPublicInputs
  );

  const tamperedProof = Buffer.from(validAttackProof);
  tamperedProof[tamperedProof.length - 1] ^= 0x01;
  await expectContractFailure(
    'tampered proof bytes',
    async () => {
      await (await player1Client.submit_feedback_proof({
        session_id: attackSession,
        guess_id: attackGuessId,
        exact: attackFeedback.exact,
        partial: attackFeedback.partial,
        proof_blob: tamperedProof,
      })).signAndSend();
    },
    [11], // InvalidProof
  );

  // Submit correct proof to ensure scenario state remains usable after rejected attacks.
  await (await player1Client.submit_feedback_proof({
    session_id: attackSession,
    guess_id: attackGuessId,
    exact: attackFeedback.exact,
    partial: attackFeedback.partial,
    proof_blob: validAttackProof,
  })).signAndSend();
  console.log('  ✅ Scenario 3 passed');

  console.log('\n✅ Integration scenarios passed');
}

run().catch((error) => {
  console.error('❌ integration scenario failed');
  console.error(String(error));
  process.exit(1);
});
