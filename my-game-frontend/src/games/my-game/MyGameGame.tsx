import { useEffect, useMemo, useState } from 'react';
import { Buffer } from 'buffer';
import { Keypair, TransactionBuilder, hash } from '@stellar/stellar-sdk';
import { Client as MyGameClient, type Game } from '../../../../bindings/my_game/src/index';
import { useWallet } from '@/hooks/useWallet';
import { RPC_URL, NETWORK_PASSPHRASE, MY_GAME_CONTRACT } from '@/utils/constants';

interface MyGameGameProps {
  userAddress: string;
  currentEpoch?: number;
  availablePoints?: bigint;
  initialXDR?: string | null;
  initialSessionId?: number | null;
  onStandingsRefresh: () => void;
  onGameComplete: () => void;
}

type Guess4 = [number, number, number, number];
type Salt16 = [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number
];

type AuthMode = 'create' | 'import' | 'load';
type UiPhase = 'auth' | 'game';

function stringifyWithBigInt(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
}

function parseCsvDigits4(input: string): Guess4 {
  const values = input.split(',').map((s) => Number(s.trim()));
  if (values.length !== 4 || values.some((v) => !Number.isInteger(v) || v < 0 || v > 9)) {
    throw new Error('Expected 4 comma-separated digits between 0 and 9');
  }
  return [values[0], values[1], values[2], values[3]];
}

function parseCsvSalt16(input: string): Salt16 {
  const values = input.split(',').map((s) => Number(s.trim()));
  if (values.length !== 16 || values.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) {
    throw new Error('Expected 16 comma-separated bytes between 0 and 255');
  }
  return [
    values[0], values[1], values[2], values[3],
    values[4], values[5], values[6], values[7],
    values[8], values[9], values[10], values[11],
    values[12], values[13], values[14], values[15],
  ];
}

function randomSessionId(): number {
  const v = Math.floor(Math.random() * 0xffffffff) >>> 0;
  return v || 1;
}

function computeFeedback(secret: Guess4, guess: Guess4): { exact: number; partial: number } {
  let exact = 0;
  for (let i = 0; i < 4; i++) {
    if (secret[i] === guess[i]) exact += 1;
  }
  let totalMatches = 0;
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      if (secret[i] === guess[j]) totalMatches += 1;
    }
  }
  return { exact, partial: totalMatches - exact };
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

function parseGuessBuffer(guess: Buffer): Guess4 {
  if (guess.length !== 4) throw new Error(`Invalid guess buffer length ${guess.length}`);
  return [guess[0], guess[1], guess[2], guess[3]];
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

async function generateRuntimeProof(payload: {
  session_id: number;
  guess_id: number;
  commitment: string;
  guess: Guess4;
  exact: number;
  partial: number;
  secret: Guess4;
  salt: Salt16;
}): Promise<Buffer> {
  const url = import.meta.env.VITE_ZK_SERVER_URL || 'http://localhost:8787/prove';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`zk_server error (${res.status}): ${await res.text()}`);
  }
  const body = await res.json() as { proof_blob_base64?: string };
  if (!body.proof_blob_base64) {
    throw new Error(`zk_server invalid response: ${JSON.stringify(body)}`);
  }
  return Buffer.from(body.proof_blob_base64, 'base64');
}

async function fetchCommitment(secret: Guess4, salt: Salt16): Promise<string> {
  const url = import.meta.env.VITE_ZK_SERVER_URL || 'http://localhost:8787/commitment';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret, salt }),
  });
  if (!res.ok) {
    throw new Error(`zk_server commitment error (${res.status}): ${await res.text()}`);
  }
  const body = await res.json() as { commitment?: string };
  if (!body.commitment) throw new Error(`zk_server invalid commitment response: ${JSON.stringify(body)}`);
  return body.commitment;
}

export function MyGameGame({
  userAddress,
  initialXDR,
  initialSessionId,
  onStandingsRefresh,
  onGameComplete,
}: MyGameGameProps) {
  const { walletType } = useWallet();

  const [phase, setPhase] = useState<UiPhase>('auth');
  const [authMode, setAuthMode] = useState<AuthMode>('create');

  const [sessionId, setSessionId] = useState<number>(randomSessionId());
  const [guessInput, setGuessInput] = useState('1,2,3,4');
  const [secretInput, setSecretInput] = useState('1,2,3,4');
  const [saltInput, setSaltInput] = useState('11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26');

  const [preparedAuthCode, setPreparedAuthCode] = useState('');
  const [importAuthCode, setImportAuthCode] = useState('');
  const [loadSessionInput, setLoadSessionInput] = useState('');

  const [game, setGame] = useState<Game | null>(null);
  const [loading, setLoading] = useState(false);
  const [quickstartLoading, setQuickstartLoading] = useState(false);
  const [message, setMessage] = useState<string>('');
  const [error, setError] = useState<string>('');

  const player1Secret = import.meta.env.VITE_DEV_PLAYER1_SECRET || '';
  const player2Secret = import.meta.env.VITE_DEV_PLAYER2_SECRET || '';
  const player1Address = import.meta.env.VITE_DEV_PLAYER1_ADDRESS || '';
  const player2Address = import.meta.env.VITE_DEV_PLAYER2_ADDRESS || '';
  const allowHttp = RPC_URL.startsWith('http://');

  const keypairs = useMemo(() => {
    const map: Record<string, Keypair> = {};
    if (player1Secret) {
      const p1 = Keypair.fromSecret(player1Secret);
      map[p1.publicKey()] = p1;
    }
    if (player2Secret) {
      const p2 = Keypair.fromSecret(player2Secret);
      map[p2.publicKey()] = p2;
    }
    return map;
  }, [player1Secret, player2Secret]);

  useEffect(() => {
    if (initialXDR) {
      console.log('[my-game-ui] initialXDR detected');
      setAuthMode('import');
      setImportAuthCode(initialXDR);
    } else if (initialSessionId !== null && initialSessionId !== undefined) {
      console.log('[my-game-ui] initialSessionId detected', initialSessionId);
      setAuthMode('load');
      setLoadSessionInput(String(initialSessionId));
    }
  }, [initialXDR, initialSessionId]);

  const createClient = (publicKey: string) => {
    const kp = keypairs[publicKey];
    if (!kp) throw new Error(`No keypair available for ${publicKey}`);
    return new MyGameClient({
      contractId: MY_GAME_CONTRACT,
      rpcUrl: RPC_URL,
      networkPassphrase: NETWORK_PASSPHRASE,
      allowHttp,
      publicKey,
      ...signerFor(kp, keypairs),
    });
  };

  const run = async (fn: () => Promise<void>) => {
    if (loading || quickstartLoading) return;
    setLoading(true);
    setError('');
    setMessage('');
    try {
      await fn();
    } catch (e) {
      setError(String(e));
      console.error('[my-game-ui] action failed', e);
    } finally {
      setLoading(false);
    }
  };

  const loadGame = async (sid?: number) => {
    const target = sid ?? sessionId;
    console.log('[my-game-ui] loadGame', { sessionId: target });
    const client = createClient(player1Address || userAddress);
    const tx = await client.get_game({ session_id: target });
    const sim = await tx.simulate();
    if (!sim.result.isOk()) {
      throw new Error(`Game not found for session_id=${target}`);
    }
    const g = sim.result.unwrap();
    setSessionId(target);
    setGame(g);
    setPhase('game');
    console.log('[my-game-ui] game loaded', g);
  };

  const handlePrepareAuthCode = () => run(async () => {
    console.log('[my-game-ui] prepare auth code', { sessionId, player1Address, player2Address });
    if (!player1Address || !player2Address) throw new Error('Missing dev addresses. Run setup:local first.');

    const stake = 100_0000000n;
    const client = createClient(player2Address);
    const tx = await client.start_game({
      session_id: sessionId,
      player1: player1Address,
      player2: player2Address,
      player1_points: stake,
      player2_points: stake,
    });

    const needed = tx.needsNonInvokerSigningBy();
    console.log('[my-game-ui] prepare needed signatures', needed);

    if (needed.includes(player1Address)) {
      const p1 = keypairs[player1Address];
      if (!p1) throw new Error('Player1 keypair missing');
      await tx.signAuthEntries({
        address: player1Address,
        signAuthEntry: async (preimageXdr) => {
          const payload = hash(Buffer.from(preimageXdr, 'base64'));
          const sig = p1.sign(payload);
          return { signedAuthEntry: Buffer.from(sig).toString('base64') };
        },
      });
    }

    const xdr = tx.toXDR();
    setPreparedAuthCode(xdr);
    setImportAuthCode(xdr);
    setMessage('Auth code prepared. Share it with Player2 (or import below).');
    console.log('[my-game-ui] prepared auth code length', xdr.length);
  });

  const handleImportAndStart = () => run(async () => {
    console.log('[my-game-ui] import+start');
    if (!importAuthCode.trim()) throw new Error('Paste auth code first');
    if (!player2Address) throw new Error('Missing Player2 dev address');

    const client = createClient(player2Address);
    const tx = client.txFromXDR(importAuthCode.trim());
    await tx.simulate();

    const needed = tx.needsNonInvokerSigningBy();
    console.log('[my-game-ui] import needed signatures', needed);
    if (needed.includes(player2Address)) {
      await tx.signAuthEntries({ address: player2Address });
    }

    await tx.signAndSend();
    console.log('[my-game-ui] start_game submitted from imported auth code');
    await loadGame(sessionId);
    setMessage('Game started from auth code');
  });

  const handleLoadSession = () => run(async () => {
    const sid = Number(loadSessionInput.trim());
    if (!Number.isInteger(sid) || sid <= 0) throw new Error('Enter valid session id');
    console.log('[my-game-ui] load existing session', sid);
    await loadGame(sid);
    setMessage('Loaded existing game');
  });

  const handleQuickStart = async () => {
    if (loading || quickstartLoading) return;
    setQuickstartLoading(true);
    setError('');
    setMessage('');
    try {
      console.log('[my-game-ui] quickstart begin');
      if (!player1Address || !player2Address) throw new Error('Missing dev addresses. Run setup:local first.');
      const sid = randomSessionId();
      setSessionId(sid);

      const stake = 100_0000000n;
      const client = createClient(player2Address);
      const tx = await client.start_game({
        session_id: sid,
        player1: player1Address,
        player2: player2Address,
        player1_points: stake,
        player2_points: stake,
      });

      const needed = tx.needsNonInvokerSigningBy();
      console.log('[my-game-ui] quickstart needed signatures', needed);
      for (const addr of needed) {
        const kp = keypairs[addr];
        if (!kp) throw new Error(`Missing keypair for ${addr}`);
        await tx.signAuthEntries({
          address: addr,
          signAuthEntry: async (preimageXdr) => {
            const payload = hash(Buffer.from(preimageXdr, 'base64'));
            const sig = kp.sign(payload);
            return { signedAuthEntry: Buffer.from(sig).toString('base64') };
          },
        });
      }

      await tx.signAndSend();
      await loadGame(sid);
      setMessage(`Quickstart ready (session ${sid})`);
      console.log('[my-game-ui] quickstart completed', sid);
    } catch (e) {
      setError(String(e));
      console.error('[my-game-ui] quickstart failed', e);
    } finally {
      setQuickstartLoading(false);
    }
  };

  const handleCommit = () => run(async () => {
    console.log('[my-game-ui] commit', { sessionId });
    const secret = parseCsvDigits4(secretInput);
    const salt = parseCsvSalt16(saltInput);
    const commitment = await fetchCommitment(secret, salt);

    const client = createClient(player1Address);
    await (await client.commit_code({
      session_id: sessionId,
      commitment: commitmentFieldBytes(commitment),
    })).signAndSend();

    await loadGame(sessionId);
    setMessage(`Commitment submitted: ${commitment}`);
  });

  const handleGuess = () => run(async () => {
    console.log('[my-game-ui] guess', { sessionId, guessInput });
    const guess = parseCsvDigits4(guessInput);
    const client = createClient(player2Address);
    await (await client.submit_guess({
      session_id: sessionId,
      guess: Buffer.from(guess),
    })).signAndSend();

    await loadGame(sessionId);
    setMessage('Guess submitted');
  });

  const handleFeedbackProof = () => run(async () => {
    console.log('[my-game-ui] feedback+proof', { sessionId });
    if (!game) throw new Error('Load game first');
    if (game.pending_guess_id === undefined || game.pending_guess_id === null) {
      throw new Error('No pending guess to prove feedback for');
    }

    const pendingGuessId = Number(game.pending_guess_id);
    const guessRecord = game.guesses.find((g) => Number(g.guess_id) === pendingGuessId);
    if (!guessRecord) throw new Error(`Missing guess record for guess_id ${pendingGuessId}`);

    const secret = parseCsvDigits4(secretInput);
    const salt = parseCsvSalt16(saltInput);
    const commitment = await fetchCommitment(secret, salt);
    const guess = parseGuessBuffer(Buffer.from(guessRecord.guess));
    const fb = computeFeedback(secret, guess);

    const proofBlob = await generateRuntimeProof({
      session_id: sessionId,
      guess_id: pendingGuessId,
      commitment,
      guess,
      exact: fb.exact,
      partial: fb.partial,
      secret,
      salt,
    });

    const client = createClient(player1Address);
    await (await client.submit_feedback_proof({
      session_id: sessionId,
      guess_id: pendingGuessId,
      exact: fb.exact,
      partial: fb.partial,
      proof_blob: proofBlob,
    })).signAndSend();

    await loadGame(sessionId);
    setMessage(`Feedback proof submitted (exact=${fb.exact}, partial=${fb.partial})`);
    onStandingsRefresh();

    if (fb.exact === 4) {
      onGameComplete();
    }
  });

  const handleBackToAuth = () => {
    console.log('[my-game-ui] back to auth');
    setPhase('auth');
    setAuthMode('create');
    setGame(null);
    setPreparedAuthCode('');
    setImportAuthCode('');
    setLoadSessionInput('');
    setMessage('');
    setError('');
    setSessionId(randomSessionId());
  };

  return (
    <div className="card" style={{ display: 'grid', gap: '0.9rem' }}>
      <h3 className="gradient-text">ZK Mastermind (Localnet)</h3>
      <p style={{ color: 'var(--color-ink-muted)' }}>
        Connected: <code>{userAddress || '(none)'}</code> | Wallet: <code>{walletType}</code>
      </p>
      <p style={{ color: 'var(--color-ink-muted)' }}>
        RPC: <code>{RPC_URL}</code> | Contract: <code>{MY_GAME_CONTRACT}</code>
      </p>

      {phase === 'auth' && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem' }}>
            <button disabled={loading || quickstartLoading} onClick={() => setAuthMode('create')}>Create</button>
            <button disabled={loading || quickstartLoading} onClick={() => setAuthMode('import')}>Import Auth</button>
            <button disabled={loading || quickstartLoading} onClick={() => setAuthMode('load')}>Load Session</button>
            <button disabled={loading || quickstartLoading} onClick={handleQuickStart}>Quick Start</button>
          </div>

          {authMode === 'create' && (
            <div style={{ display: 'grid', gap: '0.5rem' }}>
              <label>Session ID</label>
              <input value={String(sessionId)} onChange={(e) => setSessionId(Number(e.target.value) || 0)} />
              <button disabled={loading || quickstartLoading} onClick={handlePrepareAuthCode}>Prepare Auth Code (Player1)</button>
              <label>Prepared Auth Code</label>
              <textarea rows={5} value={preparedAuthCode} onChange={(e) => setPreparedAuthCode(e.target.value)} />
              <button disabled={loading || quickstartLoading} onClick={handleImportAndStart}>Finalize Start (Player2)</button>
            </div>
          )}

          {authMode === 'import' && (
            <div style={{ display: 'grid', gap: '0.5rem' }}>
              <label>Session ID</label>
              <input value={String(sessionId)} onChange={(e) => setSessionId(Number(e.target.value) || 0)} />
              <label>Auth Code (from Player1)</label>
              <textarea rows={5} value={importAuthCode} onChange={(e) => setImportAuthCode(e.target.value)} />
              <button disabled={loading || quickstartLoading} onClick={handleImportAndStart}>Import + Start Game</button>
            </div>
          )}

          {authMode === 'load' && (
            <div style={{ display: 'grid', gap: '0.5rem' }}>
              <label>Existing Session ID</label>
              <input value={loadSessionInput} onChange={(e) => setLoadSessionInput(e.target.value)} />
              <button disabled={loading || quickstartLoading} onClick={handleLoadSession}>Load Game</button>
            </div>
          )}
        </>
      )}

      {phase === 'game' && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem' }}>
            <button disabled={loading || quickstartLoading} onClick={handleBackToAuth}>Back To Auth</button>
            <button disabled={loading || quickstartLoading} onClick={() => run(() => loadGame(sessionId))}>Refresh</button>
          </div>

          <div style={{ display: 'grid', gap: '0.5rem' }}>
            <label>Session ID</label>
            <input value={String(sessionId)} onChange={(e) => setSessionId(Number(e.target.value) || 0)} />

            <label>Player1 Secret Digits (0-9, csv)</label>
            <input value={secretInput} onChange={(e) => setSecretInput(e.target.value)} />

            <label>Salt 16 Bytes (0-255, csv)</label>
            <input value={saltInput} onChange={(e) => setSaltInput(e.target.value)} />

            <label>Player2 Guess Digits (0-9, csv)</label>
            <input value={guessInput} onChange={(e) => setGuessInput(e.target.value)} />
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem' }}>
            <button disabled={loading || quickstartLoading} onClick={handleCommit}>1) commit_code (P1)</button>
            <button disabled={loading || quickstartLoading} onClick={handleGuess}>2) submit_guess (P2)</button>
            <button disabled={loading || quickstartLoading} onClick={handleFeedbackProof}>3) submit_feedback_proof (P1+zk)</button>
          </div>
        </>
      )}

      {message && <div className="notice info">{message}</div>}
      {error && <div className="notice error">{error}</div>}

      <pre style={{ whiteSpace: 'pre-wrap', background: '#111', color: '#ddd', padding: '0.75rem', borderRadius: 8 }}>
        {stringifyWithBigInt(game)}
      </pre>
    </div>
  );
}
