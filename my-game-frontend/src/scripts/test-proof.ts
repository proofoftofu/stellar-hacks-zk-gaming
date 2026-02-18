import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Buffer } from 'node:buffer';
import { Keypair, TransactionBuilder, hash } from '@stellar/stellar-sdk';
import { Client as MyGameClient } from '../../../bindings/my_game/src/index';

type EnvMap = Record<string, string>;

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

function classifyFailure(error: unknown): string {
  const text = String(error);
  if (text.includes('InvalidProof') || text.includes('Contract, #11')) return 'InvalidProof';
  if (text.includes('InvalidPublicInputs') || text.includes('Contract, #10')) return 'InvalidPublicInputs';
  if (text.includes('VerifierNotSet') || text.includes('Contract, #13')) return 'VerifierNotSet';
  if (text.includes('Budget') || text.includes('ExceededLimit')) return 'BudgetExceeded';
  return 'Unknown';
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
  const keyByAddress: Record<string, Keypair> = {
    [p1.publicKey()]: p1,
    [p2.publicKey()]: p2,
  };

  const player1Client = new MyGameClient({
    contractId,
    rpcUrl,
    networkPassphrase,
    publicKey: p1.publicKey(),
    ...signerFor(p1, keyByAddress),
  });

  const player2Client = new MyGameClient({
    contractId,
    rpcUrl,
    networkPassphrase,
    publicKey: p2.publicKey(),
    ...signerFor(p2, keyByAddress),
  });

  const startClient = new MyGameClient({
    contractId,
    rpcUrl,
    networkPassphrase,
    publicKey: p2.publicKey(),
    ...signerFor(p2, keyByAddress),
  });

  const sessionId = Number(process.argv[2] || (Date.now() % 1_000_000_000));
  const stake = 100_0000000n;
  const commitment = Buffer.alloc(32, 7);
  const guess = Buffer.from([1, 2, 3, 4]);
  const exact = 1;
  const partial = 1;

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
  process.exit(1);
});
