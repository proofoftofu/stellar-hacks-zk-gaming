import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inspect } from 'node:util';
import { Buffer } from 'node:buffer';
import { Keypair, TransactionBuilder, hash } from '@stellar/stellar-sdk';
import { Client as MyGameClient } from '../games/my-game/bindings';
import {
  proveTurnWithJs,
  type Guess4,
  type Salt16,
  type TurnProofInput,
} from './lib/zkJsProver';

type EnvMap = Record<string, string>;
type ScenarioTarget = '1' | '2' | '3' | 'all';

function parseScenarioTarget(argv: string[]): ScenarioTarget {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--case' || arg === '--scenario') {
      const value = argv[i + 1];
      if (value === '1' || value === '2' || value === '3' || value === 'all') return value;
      throw new Error(`Invalid scenario value: ${String(value)}. Use 1, 2, 3, or all.`);
    }
    if (arg.startsWith('--case=')) {
      const value = arg.slice('--case='.length);
      if (value === '1' || value === '2' || value === '3' || value === 'all') return value;
      throw new Error(`Invalid scenario value: ${value}. Use 1, 2, 3, or all.`);
    }
    if (arg.startsWith('--scenario=')) {
      const value = arg.slice('--scenario='.length);
      if (value === '1' || value === '2' || value === '3' || value === 'all') return value;
      throw new Error(`Invalid scenario value: ${value}. Use 1, 2, 3, or all.`);
    }
  }
  return 'all';
}

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

async function withStepLog<T>(label: string, run: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  console.log(`  -> ${label}`);
  const out = await run();
  console.log(`  <- ${label} (${Date.now() - startedAt}ms)`);
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let progressHandle: ReturnType<typeof setInterval> | null = null;
  const startedAt = Date.now();
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  progressHandle = setInterval(() => {
    const elapsed = Date.now() - startedAt;
    console.log(`  .. waiting ${label} (${elapsed}ms elapsed)`);
  }, 5000);
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (progressHandle) clearInterval(progressHandle);
  }
}

function isRetryableTxError(error: unknown): boolean {
  const text = String(error).toLowerCase();
  if (text.includes('error(contract, #1)')) return true; // GameNotFound can be transient on testnet
  if (text.includes('error(contract, #5)')) return true; // CommitmentNotSet can be transient right after commit tx
  if (text.includes('error(contract, #6)')) return true; // GuessPendingFeedback can be transient between feedback submit and next guess
  if (text.includes('error(contract, #7)')) return true; // NoPendingGuess: can occur during transient state races
  if (text.includes('try_again_later')) return true;
  if (text.includes('sending the transaction to the network failed')) return true;
  if (text.includes('timeout')) return true;
  if (text.includes('timed out')) return true;
  if (text.includes('429')) return true;
  if (text.includes('503')) return true;
  if (text.includes('txbadseq')) return true;
  return false;
}

function isRetryableReadError(error: unknown): boolean {
  const text = String(error).toLowerCase();
  if (text.includes('error(contract, #1)')) return true; // GameNotFound propagation lag
  if (text.includes('not found')) return true;
  if (text.includes('timeout')) return true;
  if (text.includes('timed out')) return true;
  if (text.includes('429')) return true;
  if (text.includes('503')) return true;
  return false;
}

function formatUnknown(value: unknown): string {
  try {
    return inspect(value, { depth: 6, breakLength: 120 });
  } catch {
    return String(value);
  }
}

async function submitWithRetry(
  label: string,
  submit: () => Promise<void>,
  attempts = 12,
  attemptTimeoutMs = 35_000,
): Promise<void> {
  let delayMs = 1200;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await withStepLog(
        `${label} (attempt ${attempt}/${attempts})`,
        async () => withTimeout(submit(), attemptTimeoutMs, `${label} attempt ${attempt}`),
      );
      return;
    } catch (error) {
      if (attempt === attempts || !isRetryableTxError(error)) throw error;
      console.log(`  !! ${label} retrying after error: ${String(error)} (sleep ${delayMs}ms)`);
      await sleep(delayMs);
      delayMs *= 2;
    }
  }
}

async function getGameWithRetry(
  label: string,
  client: MyGameClient,
  sessionId: number,
  attempts = 12,
  attemptTimeoutMs = 45_000,
): Promise<any> {
  let delayMs = 1200;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await withStepLog(
        `${label} (attempt ${attempt}/${attempts})`,
        async () => withTimeout(fetchGameState(client, sessionId), attemptTimeoutMs, `${label} attempt ${attempt}`),
      );
    } catch (error) {
      if (attempt === attempts) throw error;
      const likelyRetryable = isRetryableReadError(error);
      console.log(`  !! ${label} read error classified as ${likelyRetryable ? 'retryable' : 'unknown'}; retrying`);
      console.log(`  !! ${label} retrying after read error: ${String(error)} (sleep ${delayMs}ms)`);
      await sleep(delayMs);
      delayMs *= 2;
    }
  }
  throw new Error(`${label} failed after retries`);
}

async function waitForGameCondition(
  label: string,
  client: MyGameClient,
  sessionId: number,
  condition: (game: any) => boolean,
  attempts = 8,
): Promise<any> {
  let delayMs = 1200;
  let lastGame: any = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const game = await getGameWithRetry(`${label} get_game`, client, sessionId);
    lastGame = game;
    if (condition(game)) return game;
    if (attempt === attempts) break;
    console.log(`  !! ${label} condition not met (${attempt}/${attempts}), sleep ${delayMs}ms`);
    await sleep(delayMs);
    delayMs *= 2;
  }
  throw new Error(`${label} condition not met after retries. last ended=${String(lastGame?.ended)} solved=${String(lastGame?.solved)} pending_guess_id=${String(lastGame?.pending_guess_id)}`);
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

async function expectProverFailure(name: string, run: () => Promise<void>) {
  try {
    await run();
  } catch {
    console.log(`  ✅ ${name} prover attempt rejected`);
    return;
  }
  throw new Error(`${name} prover attempt unexpectedly succeeded`);
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

async function proveTurn(input: TurnProofInput): Promise<Buffer> {
  const blob = await proveTurnWithJs(input);
  const publicInputs = blob.subarray(4, 196);
  assertPublicInputsMatch(input, publicInputs);
  return blob;
}

async function fetchGameState(client: MyGameClient, sessionId: number) {
  const gameTx = await client.get_game({ session_id: sessionId });
  const gameSim = await gameTx.simulate();
  assertCond(gameSim.result.isOk(), `get_game failed for session ${sessionId}: ${formatUnknown(gameSim.result)}`);
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
  await submitWithRetry('start_game tx', async () => {
    const startTx = await withStepLog('build start_game tx', async () => startClient.start_game({
      session_id: sessionId,
      player1,
      player2,
      player1_points: stake,
      player2_points: stake,
    }));
    const whoNeeds = startTx.needsNonInvokerSigningBy();
    if (whoNeeds.includes(player1)) {
      await withStepLog('sign start_game auth entries', async () => startTx.signAuthEntries({
        address: player1,
        signAuthEntry: signAuthEntryWith(player1Signer, player1),
      }));
    }
    await startTx.signAndSend();
  });
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
  const cliArgs = process.argv.slice(2);
  const sessionArg = cliArgs.find((arg) => /^\d+$/.test(arg));
  const baseSession = Number(sessionArg ?? ((Date.now() % 900_000_000) + 10_000_000));
  const targetScenario = parseScenarioTarget(cliArgs);
  const runCase1 = targetScenario === 'all' || targetScenario === '1';
  const runCase2 = targetScenario === 'all' || targetScenario === '2';
  const runCase3 = targetScenario === 'all' || targetScenario === '3';

  console.log(`Using contract: ${contractId}`);
  console.log(`Player1: ${p1.publicKey()}`);
  console.log(`Player2: ${p2.publicKey()}`);
  console.log(`Commitment(dec): ${commitmentDec}`);
  console.log(`Target scenario: ${targetScenario}`);

  if (runCase1) {
    console.log('\nScenario 1: Player2 solves and wins');
    const solveSession = baseSession;
    const solveGuess: Guess4 = [1, 2, 3, 4];
    const solveFeedback = computeFeedback(secret, solveGuess);
    assertCond(solveFeedback.exact === 4, 'solve scenario should produce exact=4');

    await startGame(startClient, p1, solveSession, p1.publicKey(), p2.publicKey(), stake);

    await submitWithRetry('commit_code tx (scenario 1)', async () => {
      const solveCommitTx = await withStepLog('build commit_code tx (scenario 1)', async () => player1Client.commit_code({ session_id: solveSession, commitment: commitmentBytes }));
      await solveCommitTx.signAndSend();
    });
    await submitWithRetry('submit_guess tx (scenario 1)', async () => {
      const solveGuessTx = await withStepLog('build submit_guess tx (scenario 1)', async () => player2Client.submit_guess({ session_id: solveSession, guess: Buffer.from(solveGuess) }));
      await solveGuessTx.signAndSend();
    });

    const solveBefore = await waitForGameCondition(
      'scenario 1 pending guess visible',
      player1Client,
      solveSession,
      (game) => String(game.pending_guess_id) === '0',
    );
    const solveGuessId = Number(solveBefore.pending_guess_id);
    assertCond(solveGuessId === 0, `solve scenario expected guess_id=0, got ${String(solveBefore.pending_guess_id)}`);

    const solveProofBlob = await withStepLog('generate proof (scenario 1)', async () => proveTurn({
      sessionId: solveSession,
      guessId: solveGuessId,
      commitmentDec,
      guess: solveGuess,
      exact: solveFeedback.exact,
      partial: solveFeedback.partial,
      secret,
      salt,
    }));
    await submitWithRetry('submit_feedback_proof tx (scenario 1)', async () => {
      const solveProofTx = await withStepLog('build submit_feedback_proof tx (scenario 1)', async () => player1Client.submit_feedback_proof({
        session_id: solveSession,
        guess_id: solveGuessId,
        exact: solveFeedback.exact,
        partial: solveFeedback.partial,
        proof_blob: solveProofBlob,
      }));
      await solveProofTx.signAndSend();
    });

    const solveAfter = await waitForGameCondition(
      'scenario 1 final state',
      player1Client,
      solveSession,
      (game) => !!game.ended,
    );
    assertCond(!!solveAfter.ended, 'solve scenario: game should be ended');
    assertCond(!!solveAfter.solved, 'solve scenario: solved should be true');
    assertCond(solveAfter.winner === p2.publicKey(), 'solve scenario: winner should be player2');
    console.log('  ✅ Scenario 1 passed');
  }

  if (runCase2) {
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
    await submitWithRetry('submit commit_code tx (scenario 2)', async () => {
      await (await player1Client.commit_code({ session_id: failSession, commitment: commitmentBytes })).signAndSend();
    });

    for (let i = 0; i < failGuesses.length; i++) {
      const guess = failGuesses[i];
      const fb = computeFeedback(secret, guess);
      assertCond(!(fb.exact === 4), `fail scenario attempt ${i} unexpectedly solves`);

      await submitWithRetry(`submit submit_guess tx (scenario 2, attempt ${i + 1})`, async () => {
        await (await player2Client.submit_guess({ session_id: failSession, guess: Buffer.from(guess) })).signAndSend();
      });
      const before = await waitForGameCondition(
        `scenario 2 pending guess visible (loop ${i + 1})`,
        player1Client,
        failSession,
        (game) => Number(game.pending_guess_id) === i,
      );
      const guessId = Number(before.pending_guess_id);
      assertCond(guessId === i, `fail scenario attempt ${i}: expected guess_id=${i}, got ${String(before.pending_guess_id)}`);

      const proofBlob = await proveTurn({
        sessionId: failSession,
        guessId,
        commitmentDec,
        guess,
        exact: fb.exact,
        partial: fb.partial,
        secret,
        salt,
      });

      await submitWithRetry(`submit submit_feedback_proof tx (scenario 2, attempt ${i + 1})`, async () => {
        await (await player1Client.submit_feedback_proof({
          session_id: failSession,
          guess_id: guessId,
          exact: fb.exact,
          partial: fb.partial,
          proof_blob: proofBlob,
        })).signAndSend();
      });
    }

    const failAfter = await waitForGameCondition(
      'scenario 2 final state',
      player1Client,
      failSession,
      (game) => !!game.ended,
    );
    assertCond(!!failAfter.ended, 'fail scenario: game should be ended');
    assertCond(!failAfter.solved, 'fail scenario: solved should be false');
    assertCond(failAfter.winner === p1.publicKey(), 'fail scenario: winner should be player1');
    assertCond(Number(failAfter.attempts_used) === 12, `fail scenario: attempts_used should be 12, got ${String(failAfter.attempts_used)}`);
    console.log('  ✅ Scenario 2 passed');
  }

  if (runCase3) {
    console.log('\nScenario 3: Security bypass attempts are rejected');
    const attackSession = baseSession + 2;
    const attackGuess: Guess4 = [1, 2, 3, 5];
    const attackFeedback = computeFeedback(secret, attackGuess);

    await startGame(startClient, p1, attackSession, p1.publicKey(), p2.publicKey(), stake);
    await submitWithRetry('submit commit_code tx (scenario 3)', async () => {
      await (await player1Client.commit_code({ session_id: attackSession, commitment: commitmentBytes })).signAndSend();
    });

    await submitWithRetry('submit submit_guess tx (scenario 3)', async () => {
      await (await player2Client.submit_guess({ session_id: attackSession, guess: Buffer.from(attackGuess) })).signAndSend();
    });

    const attackBefore = await waitForGameCondition(
      'scenario 3 pending guess visible',
      player1Client,
      attackSession,
      (game) => game.pending_guess_id !== undefined && game.pending_guess_id !== null,
    );

    await expectContractFailure(
      'double guess while pending feedback',
      async () => {
        await (await player2Client.submit_guess({ session_id: attackSession, guess: Buffer.from([4, 3, 2, 1]) })).signAndSend();
      },
      [6], // GuessPendingFeedback
    );
    const attackGuessId = Number(attackBefore.pending_guess_id);

    // Try to prove a lie directly: this should fail during proving.
    const liedExact = attackFeedback.exact === 4 ? 3 : attackFeedback.exact + 1;
    const liedPartial = attackFeedback.partial;
    await expectProverFailure(
      'prove a lie (wrong exact/partial)',
      async () => {
        await proveTurn({
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

    const validAttackProof = await proveTurn({
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
    await submitWithRetry('submit submit_feedback_proof tx (scenario 3)', async () => {
      await (await player1Client.submit_feedback_proof({
        session_id: attackSession,
        guess_id: attackGuessId,
        exact: attackFeedback.exact,
        partial: attackFeedback.partial,
        proof_blob: validAttackProof,
      })).signAndSend();
    });
    console.log('  ✅ Scenario 3 passed');
  }

  console.log('\n✅ Integration scenarios passed');
}

run().catch((error) => {
  console.error('❌ integration scenario failed');
  console.error(String(error));
  process.exit(1);
});
