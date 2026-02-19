import { useEffect, useMemo, useState } from 'react';
import { Buffer } from 'buffer';
import { Keypair, TransactionBuilder, hash } from '@stellar/stellar-sdk';
import { Client as MyGameClient, type Game } from '../../../../bindings/my_game/src/index';
import { MyGameService } from './myGameService';
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
  number, number, number, number,
];

type AuthMode = 'create' | 'import' | 'load';
type UiPhase = 'auth' | 'game';

function stringifyWithBigInt(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
}

function parseCsvDigits4(input: string): Guess4 {
  const values = input.split(',').map((s) => Number(s.trim()));
  if (values.length !== 4 || values.some((v) => !Number.isInteger(v) || v < 1 || v > 4)) {
    throw new Error('Expected 4 comma-separated digits using only 1,2,3,4');
  }
  const uniq = new Set(values);
  if (uniq.size !== 4) {
    throw new Error('Digits must be unique (no duplicates)');
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
  const parsed = [guess[0], guess[1], guess[2], guess[3]] as Guess4;
  const uniq = new Set(parsed);
  if (parsed.some((v) => v < 1 || v > 4) || uniq.size !== 4) {
    throw new Error('On-chain guess is not a valid unique 1..4 guess');
  }
  return parsed;
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
  const { walletType, getContractSigner } = useWallet();

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
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [authCodeCopied, setAuthCodeCopied] = useState(false);
  const [shareUrlCopied, setShareUrlCopied] = useState(false);

  const player1Secret = import.meta.env.VITE_DEV_PLAYER1_SECRET || '';
  const player2Secret = import.meta.env.VITE_DEV_PLAYER2_SECRET || '';
  const placeholderP2 = import.meta.env.VITE_DEV_PLAYER2_ADDRESS || '';
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

  const myGameService = useMemo(() => new MyGameService(MY_GAME_CONTRACT), []);

  useEffect(() => {
    if (initialXDR) {
      console.log('[my-game-ui] initialXDR detected');
      setAuthMode('import');
      setImportAuthCode(initialXDR);
      return;
    }
    if (initialSessionId !== null && initialSessionId !== undefined) {
      console.log('[my-game-ui] initialSessionId detected', initialSessionId);
      setAuthMode('load');
      setLoadSessionInput(String(initialSessionId));
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const auth = params.get('auth');
    const sid = params.get('session-id');
    if (auth) {
      console.log('[my-game-ui] URL auth detected');
      setAuthMode('import');
      setImportAuthCode(auth);
    } else if (sid) {
      console.log('[my-game-ui] URL session-id detected', sid);
      setAuthMode('load');
      setLoadSessionInput(sid);
    }
  }, [initialXDR, initialSessionId]);

  const createClient = (publicKey: string) => {
    const kp = keypairs[publicKey];
    if (kp) {
      return new MyGameClient({
        contractId: MY_GAME_CONTRACT,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        allowHttp,
        publicKey,
        ...signerFor(kp, keypairs),
      });
    }

    if (publicKey === userAddress) {
      const walletSigner = getContractSigner();
      return new MyGameClient({
        contractId: MY_GAME_CONTRACT,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        allowHttp,
        publicKey,
        ...walletSigner,
      });
    }

    throw new Error(`No signer available for ${publicKey}`);
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
    const reader = createClient(userAddress);
    const tx = await reader.get_game({ session_id: target });
    const sim = await tx.simulate();
    if (!sim.result.isOk()) {
      throw new Error(`Game not found for session_id=${target}`);
    }

    const g = sim.result.unwrap();
    if (userAddress && g.player1 !== userAddress && g.player2 !== userAddress) {
      throw new Error(`Connected wallet ${userAddress} is not part of this game`);
    }

    setSessionId(target);
    setGame(g);
    setPhase('game');
    console.log('[my-game-ui] game loaded', g);
  };

  const fetchLatestGame = async (): Promise<Game> => {
    const reader = createClient(userAddress);
    const tx = await reader.get_game({ session_id: sessionId });
    const sim = await tx.simulate();
    if (!sim.result.isOk()) {
      throw new Error(`Game not found for session_id=${sessionId}`);
    }
    return sim.result.unwrap();
  };

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let stopped = false;

    const poll = async () => {
      if (stopped) return;
      if (!userAddress) return;
      try {
        if (phase === 'auth') {
          const sid = Number(loadSessionInput.trim() || sessionId);
          if (!Number.isInteger(sid) || sid <= 0) return;
          const reader = createClient(userAddress);
          const tx = await reader.get_game({ session_id: sid });
          const sim = await tx.simulate();
          if (sim.result.isOk()) {
            const g = sim.result.unwrap();
            if (g.player1 === userAddress || g.player2 === userAddress) {
              setSessionId(sid);
              setGame(g);
              setPhase('game');
            }
          }
          return;
        }

        if (phase === 'game') {
          const latest = await fetchLatestGame();
          setGame((prev) => {
            const prevJson = prev ? JSON.stringify(prev, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) : '';
            const nextJson = JSON.stringify(latest, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
            return prevJson === nextJson ? prev : latest;
          });
        }
      } catch {
        // ignore polling errors (session may not exist yet)
      }
    };

    timer = setInterval(poll, 2200);
    void poll();
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
    };
  }, [phase, userAddress, loadSessionInput, sessionId]);

  const handlePrepareAuthCode = () => run(async () => {
    console.log('[my-game-ui] prepare auth code', { sessionId, userAddress, placeholderP2 });
    if (!userAddress) throw new Error('Connect wallet first');
    if (!placeholderP2) throw new Error('Missing VITE_DEV_PLAYER2_ADDRESS for placeholder source');
    if (userAddress === placeholderP2) throw new Error('Switch to Player1 account before preparing auth code');

    const stake = 100_0000000n;
    const signer = getContractSigner();
    const authEntryXdr = await myGameService.prepareStartGame(
      sessionId,
      userAddress,
      placeholderP2,
      stake,
      stake,
      signer,
    );

    setPreparedAuthCode(authEntryXdr);
    setImportAuthCode(authEntryXdr);
    setMessage('Auth code prepared. Share it with Player2 (any other wallet)');
    console.log('[my-game-ui] prepared auth code length', authEntryXdr.length);
  });

  const handleImportAndStart = () => run(async () => {
    console.log('[my-game-ui] import+start');
    if (!importAuthCode.trim()) throw new Error('Paste auth code first');
    if (!userAddress) throw new Error('Connect wallet first');

    const parsed = myGameService.parseAuthEntry(importAuthCode.trim());
    if (parsed.player1 === userAddress) {
      throw new Error('Player1 cannot import as Player2. Switch to another wallet.');
    }

    const stake = 100_0000000n;
    const signer = getContractSigner();
    const fullTxXdr = await myGameService.importAndSignAuthEntry(
      importAuthCode.trim(),
      userAddress,
      stake,
      signer,
    );
    await myGameService.finalizeStartGame(fullTxXdr, userAddress, signer);

    console.log('[my-game-ui] start_game submitted from imported auth entry');
    await loadGame(parsed.sessionId);
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
      const p1 = import.meta.env.VITE_DEV_PLAYER1_ADDRESS || '';
      const p2 = import.meta.env.VITE_DEV_PLAYER2_ADDRESS || '';
      if (!p1 || !p2) throw new Error('Missing dev addresses. Run setup:local first.');

      const sid = randomSessionId();
      setSessionId(sid);

      const stake = 100_0000000n;
      const client = createClient(p2);
      const tx = await client.start_game({
        session_id: sid,
        player1: p1,
        player2: p2,
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
    if (!game) throw new Error('Load game first');
    if (userAddress !== game.player1) throw new Error(`Only Player1 can commit. Expected ${game.player1}`);

    const secret = parseCsvDigits4(secretInput);
    const salt = parseCsvSalt16(saltInput);
    const commitment = await fetchCommitment(secret, salt);

    const client = createClient(game.player1);
    await (await client.commit_code({
      session_id: sessionId,
      commitment: commitmentFieldBytes(commitment),
    })).signAndSend();

    await loadGame(sessionId);
    setMessage(`Commitment submitted: ${commitment}`);
  });

  const handleGuess = () => run(async () => {
    console.log('[my-game-ui] guess', { sessionId, guessInput });
    if (!game) throw new Error('Load game first');
    if (userAddress !== game.player2) throw new Error(`Only Player2 can guess. Expected ${game.player2}`);
    if (!game.commitment) throw new Error('Wait for Player1 to submit commitment first');
    if (game.pending_guess_id !== null) throw new Error('Wait for Player1 feedback before next guess');

    const guess = parseCsvDigits4(guessInput);
    const client = createClient(game.player2);
    await (await client.submit_guess({
      session_id: sessionId,
      guess: Buffer.from(guess),
    })).signAndSend();

    await loadGame(sessionId);
    setMessage('Guess submitted');
  });

  const handleFeedbackProof = () => run(async () => {
    console.log('[my-game-ui] feedback+proof', { sessionId });
    const latestGame = await fetchLatestGame();
    setGame(latestGame);
    if (userAddress !== latestGame.player1) throw new Error(`Only Player1 can submit feedback proof. Expected ${latestGame.player1}`);
    if (latestGame.pending_guess_id === undefined || latestGame.pending_guess_id === null) {
      throw new Error('No pending guess to prove feedback for');
    }

    const pendingGuessId = Number(latestGame.pending_guess_id);
    const guessRecord = latestGame.guesses.find((g) => Number(g.guess_id) === pendingGuessId);
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

    const client = createClient(latestGame.player1);
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

  const copyAuthCode = async () => {
    if (!preparedAuthCode) return;
    await navigator.clipboard.writeText(preparedAuthCode);
    setAuthCodeCopied(true);
    setTimeout(() => setAuthCodeCopied(false), 2000);
  };

  const copyShareUrlWithAuthCode = async () => {
    if (!preparedAuthCode) return;
    const params = new URLSearchParams({ game: 'my-game', auth: preparedAuthCode });
    const url = `${window.location.origin}${window.location.pathname}?${params.toString()}`;
    await navigator.clipboard.writeText(url);
    setShareUrlCopied(true);
    setTimeout(() => setShareUrlCopied(false), 2000);
  };

  const copyShareUrlWithSession = async () => {
    if (!loadSessionInput.trim()) return;
    const params = new URLSearchParams({ game: 'my-game', 'session-id': loadSessionInput.trim() });
    const url = `${window.location.origin}${window.location.pathname}?${params.toString()}`;
    await navigator.clipboard.writeText(url);
    setShareUrlCopied(true);
    setTimeout(() => setShareUrlCopied(false), 2000);
  };

  const winnerAddress = game?.winner ?? null;
  const winnerLabel = winnerAddress
    ? winnerAddress === game?.player1
      ? 'Player 1'
      : winnerAddress === game?.player2
        ? 'Player 2'
        : winnerAddress === userAddress
          ? 'You'
          : 'Unknown'
    : null;
  const canCommit = !!game && !game.ended && userAddress === game.player1 && !game.commitment;
  const canGuess = !!game && !game.ended && userAddress === game.player2 && !!game.commitment && game.pending_guess_id === null;
  const canFeedback = !!game && !game.ended && userAddress === game.player1 && game.pending_guess_id !== null;
  const statusHint = game
    ? game.ended
      ? 'Game finished.'
      : !game.commitment
        ? userAddress === game.player1
          ? 'Your turn: submit secret commitment first.'
          : 'Waiting for Player1 to submit secret commitment.'
      : game.pending_guess_id !== undefined && game.pending_guess_id !== null
        ? userAddress === game.player1
          ? 'Player2 submitted a guess. Submit feedback proof now.'
          : 'Guess submitted. Waiting for Player1 feedback proof.'
        : userAddress === game.player2
          ? 'Your turn: submit next guess.'
          : 'Waiting for Player2 guess.'
    : '';

  return (
    <div className="bg-white/70 backdrop-blur-xl rounded-2xl p-8 shadow-xl border-2 border-purple-200">
      <div className="flex items-center mb-6">
        <div>
          <h2 className="text-3xl font-black bg-gradient-to-r from-purple-600 via-pink-600 to-red-600 bg-clip-text text-transparent">
            ZK Mastermind
          </h2>
          <p className="text-sm text-gray-700 font-semibold mt-1">Localnet auth-entry flow + proof feedback</p>
          <p className="text-xs text-gray-500 font-mono mt-1">Session ID: {sessionId}</p>
          <p className="text-xs text-gray-500 mt-1">
            Connected: <span className="font-mono">{userAddress || '(none)'}</span> | Wallet: <span className="font-mono">{walletType}</span>
          </p>
        </div>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-gradient-to-r from-red-50 to-pink-50 border-2 border-red-200 rounded-xl">
          <p className="text-sm font-semibold text-red-700">{error}</p>
        </div>
      )}

      {message && (
        <div className="mb-6 p-4 bg-gradient-to-r from-green-50 to-emerald-50 border-2 border-green-200 rounded-xl">
          <p className="text-sm font-semibold text-green-700">{message}</p>
        </div>
      )}

      {statusHint && (
        <div className="mb-6 p-4 bg-gradient-to-r from-sky-50 to-cyan-50 border-2 border-sky-200 rounded-xl">
          <p className="text-sm font-semibold text-sky-700">{statusHint}</p>
        </div>
      )}

      {phase === 'auth' && (
        <div className="space-y-6">
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 p-2 bg-gray-100 rounded-xl">
            <button
              onClick={() => setAuthMode('create')}
              disabled={loading || quickstartLoading}
              className={`flex-1 py-3 px-4 rounded-lg font-bold text-sm transition-all ${
                authMode === 'create'
                  ? 'bg-gradient-to-r from-purple-500 to-pink-500 text-white shadow-lg'
                  : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              Create & Export
            </button>
            <button
              onClick={() => setAuthMode('import')}
              disabled={loading || quickstartLoading}
              className={`flex-1 py-3 px-4 rounded-lg font-bold text-sm transition-all ${
                authMode === 'import'
                  ? 'bg-gradient-to-r from-blue-500 to-cyan-500 text-white shadow-lg'
                  : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              Import Auth Entry
            </button>
            <button
              onClick={() => setAuthMode('load')}
              disabled={loading || quickstartLoading}
              className={`flex-1 py-3 px-4 rounded-lg font-bold text-sm transition-all ${
                authMode === 'load'
                  ? 'bg-gradient-to-r from-green-500 to-emerald-500 text-white shadow-lg'
                  : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              Load Existing Game
            </button>
          </div>

          <div className="p-4 bg-gradient-to-r from-yellow-50 to-orange-50 border-2 border-yellow-200 rounded-xl">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
              <div>
                <p className="text-sm font-bold text-yellow-900">⚡ Quickstart (Dev)</p>
                <p className="text-xs font-semibold text-yellow-800">
                  Creates and signs for both local dev players in one click.
                </p>
              </div>
              <button
                onClick={handleQuickStart}
                disabled={loading || quickstartLoading}
                className="px-4 py-3 rounded-xl font-bold text-sm text-white bg-gradient-to-r from-yellow-500 to-orange-500 hover:from-yellow-600 hover:to-orange-600 disabled:from-gray-200 disabled:to-gray-300 disabled:text-gray-500 transition-all shadow-md hover:shadow-lg transform hover:scale-105 disabled:transform-none"
              >
                {quickstartLoading ? 'Quickstarting...' : '⚡ Quickstart Game'}
              </button>
            </div>
          </div>

          {authMode === 'create' && (
            <div className="space-y-6">
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-bold text-gray-700 mb-2">Session ID</label>
                  <input
                    value={String(sessionId)}
                    onChange={(e) => setSessionId(Number(e.target.value) || 0)}
                    className="w-full px-4 py-3 rounded-xl bg-white border-2 border-gray-200 focus:outline-none focus:border-purple-400 focus:ring-4 focus:ring-purple-100 text-sm font-mono"
                  />
                </div>

                <div className="p-3 bg-blue-50 border-2 border-blue-200 rounded-xl">
                  <p className="text-xs font-semibold text-blue-800">
                    ℹ️ Prepare Player1 auth entry, then any other connected wallet can import as Player2.
                  </p>
                </div>
              </div>

              <div className="pt-4 border-t-2 border-gray-100 space-y-4">
                {!preparedAuthCode ? (
                  <button
                    onClick={handlePrepareAuthCode}
                    disabled={loading || quickstartLoading}
                    className="w-full py-4 rounded-xl font-bold text-white text-sm bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 disabled:from-gray-200 disabled:to-gray-300 disabled:text-gray-500 transition-all shadow-lg hover:shadow-xl transform hover:scale-105 disabled:transform-none"
                  >
                    {loading ? 'Preparing...' : 'Prepare & Export Auth Entry'}
                  </button>
                ) : (
                  <div className="space-y-3">
                    <div className="p-4 bg-gradient-to-br from-green-50 to-emerald-50 border-2 border-green-200 rounded-xl">
                      <p className="text-xs font-bold uppercase tracking-wide text-green-700 mb-2">
                        Auth Entry XDR (Player 1 Signed)
                      </p>
                      <div className="bg-white p-3 rounded-lg border border-green-200 mb-3">
                        <code className="text-xs font-mono text-gray-700 break-all">{preparedAuthCode}</code>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <button
                          onClick={copyAuthCode}
                          className="py-3 rounded-lg bg-gradient-to-r from-green-500 to-emerald-500 hover:from-green-600 hover:to-emerald-600 text-white font-bold text-sm transition-all shadow-md hover:shadow-lg transform hover:scale-105"
                        >
                          {authCodeCopied ? '✓ Copied!' : '📋 Copy Auth Entry'}
                        </button>
                        <button
                          onClick={copyShareUrlWithAuthCode}
                          className="py-3 rounded-lg bg-gradient-to-r from-blue-500 to-indigo-500 hover:from-blue-600 hover:to-indigo-600 text-white font-bold text-sm transition-all shadow-md hover:shadow-lg transform hover:scale-105"
                        >
                          {shareUrlCopied ? '✓ Copied!' : '🔗 Share URL'}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {authMode === 'import' && (
            <div className="space-y-4">
              <div className="p-4 bg-gradient-to-br from-blue-50 to-cyan-50 border-2 border-blue-200 rounded-xl">
                <p className="text-sm font-semibold text-blue-800 mb-2">📥 Import Auth Entry from Player 1</p>
                <p className="text-xs text-gray-700 mb-4">
                  Paste auth code and sign as the currently connected wallet (Player2).
                </p>
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-bold text-gray-700 mb-1">Auth Entry XDR</label>
                    <textarea
                      rows={5}
                      value={importAuthCode}
                      onChange={(e) => setImportAuthCode(e.target.value)}
                      className="w-full px-4 py-3 rounded-xl bg-white border-2 border-blue-200 focus:outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-100 text-xs font-mono resize-none"
                    />
                  </div>
                </div>
              </div>

              <button
                onClick={handleImportAndStart}
                disabled={loading || quickstartLoading || !importAuthCode.trim()}
                className="w-full py-4 rounded-xl font-bold text-white text-lg bg-gradient-to-r from-blue-500 via-cyan-500 to-teal-500 hover:from-blue-600 hover:via-cyan-600 hover:to-teal-600 disabled:from-gray-200 disabled:to-gray-300 disabled:text-gray-500 transition-all shadow-xl hover:shadow-2xl transform hover:scale-105 disabled:transform-none"
              >
                {loading ? 'Importing & Signing...' : 'Import & Sign Auth Entry'}
              </button>
            </div>
          )}

          {authMode === 'load' && (
            <div className="space-y-4">
              <div className="p-4 bg-gradient-to-br from-green-50 to-emerald-50 border-2 border-green-200 rounded-xl">
                <p className="text-sm font-semibold text-green-800 mb-2">🎮 Load Existing Game by Session ID</p>
                <p className="text-xs text-gray-700 mb-4">
                  Enter a session ID to load and continue an existing game.
                </p>
                <input
                  value={loadSessionInput}
                  onChange={(e) => setLoadSessionInput(e.target.value)}
                  placeholder="Enter session ID"
                  className="w-full px-4 py-3 rounded-xl bg-white border-2 border-green-200 focus:outline-none focus:border-green-400 focus:ring-4 focus:ring-green-100 text-sm font-mono"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  onClick={handleLoadSession}
                  disabled={loading || quickstartLoading || !loadSessionInput.trim()}
                  className="py-4 rounded-xl font-bold text-white text-lg bg-gradient-to-r from-green-500 via-emerald-500 to-teal-500 hover:from-green-600 hover:via-emerald-600 hover:to-teal-600 disabled:from-gray-200 disabled:to-gray-300 disabled:text-gray-500 transition-all shadow-xl hover:shadow-2xl transform hover:scale-105 disabled:transform-none"
                >
                  {loading ? 'Loading...' : '🎮 Load Game'}
                </button>
                <button
                  onClick={copyShareUrlWithSession}
                  disabled={!loadSessionInput.trim()}
                  className="py-4 rounded-xl font-bold text-white text-lg bg-gradient-to-r from-blue-500 to-indigo-500 hover:from-blue-600 hover:to-indigo-600 disabled:from-gray-200 disabled:to-gray-300 disabled:text-gray-500 transition-all shadow-xl hover:shadow-2xl transform hover:scale-105 disabled:transform-none"
                >
                  {shareUrlCopied ? '✓ Copied!' : '🔗 Share Game'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {phase === 'game' && (
        <div style={{ display: 'grid', gap: '0.9rem' }}>
          {game?.ended ? (
            <div className="p-4 bg-gradient-to-r from-indigo-50 to-purple-50 border-2 border-indigo-200 rounded-xl">
              <p className="text-sm font-bold text-indigo-900">Game Ended</p>
              <p className="text-sm text-indigo-800 mt-1">
                Winner: <span className="font-mono">{winnerLabel || 'Unknown'}</span>
              </p>
              <p className="text-sm text-indigo-800">
                Attempts used: <span className="font-mono">{String(game.attempts_used)}</span> / <span className="font-mono">{String(game.max_attempts)}</span>
              </p>
              <div className="mt-3">
                <button disabled={loading || quickstartLoading} onClick={handleBackToAuth}>Back To Auth</button>
              </div>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem' }}>
                <button disabled={loading || quickstartLoading} onClick={handleBackToAuth}>Back To Auth</button>
              </div>

              <div style={{ display: 'grid', gap: '0.5rem' }}>
                <label>Session ID</label>
                <input value={String(sessionId)} onChange={(e) => setSessionId(Number(e.target.value) || 0)} />

                <label>Player1 Secret Digits (unique 1,2,3,4)</label>
                <input value={secretInput} onChange={(e) => setSecretInput(e.target.value)} />

                <label>Salt 16 Bytes (0-255, csv)</label>
                <input value={saltInput} onChange={(e) => setSaltInput(e.target.value)} />

                <label>Player2 Guess Digits (unique 1,2,3,4)</label>
                <input value={guessInput} onChange={(e) => setGuessInput(e.target.value)} />
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem' }}>
                <button disabled={loading || quickstartLoading || !canCommit} onClick={handleCommit}>1) commit_code (P1)</button>
                <button disabled={loading || quickstartLoading || !canGuess} onClick={handleGuess}>2) submit_guess (P2)</button>
                <button disabled={loading || quickstartLoading || !canFeedback} onClick={handleFeedbackProof}>3) submit_feedback_proof (P1+zk)</button>
              </div>
            </>
          )}
        </div>
      )}

      <pre style={{ whiteSpace: 'pre-wrap', background: '#111', color: '#ddd', padding: '0.75rem', borderRadius: 8 }}>
        {stringifyWithBigInt(game)}
      </pre>
    </div>
  );
}
