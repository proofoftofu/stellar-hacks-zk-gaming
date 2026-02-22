import { useEffect, useMemo, useRef, useState } from 'react';
import { Buffer } from 'buffer';
import { Keypair, TransactionBuilder, hash } from '@stellar/stellar-sdk';
import { Client as MyGameClient, type Game } from './bindings';
import { MyGameService } from './myGameService';
import { useWallet } from '@/hooks/useWallet';
import { standaloneWalletService } from '@/services/standaloneWalletService';
import {
  RPC_URL,
  NETWORK_PASSPHRASE,
  MY_GAME_CONTRACT,
} from '@/utils/constants';
import { getFundedSimulationSourceAddress } from '@/utils/simulationUtils';

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
type StoredSecretState = {
  sessionId: number;
  player1: string;
  secretDigits: Guess4;
  saltHex: string;
  updatedAt: number;
};

type AuthMode = 'create' | 'import' | 'load';
type UiPhase = 'landing' | 'auth' | 'game';
type UiLogEntry = { id: number; level: 'info' | 'error'; text: string };
const SECRET_STATE_KEY = 'my-game:latest-player1-secret';
const STELLAR_EXPERT_TX_BASE = 'https://stellar.expert/explorer/testnet/tx/';
const DEMO_URL = import.meta.env.VITE_DEMO_URL || 'https://www.youtube.com/';
const SOURCE_CODE_URL = import.meta.env.VITE_SOURCE_CODE_URL || 'https://github.com/proofoftofu/stellar-hacks-zk-gaming';
const PEG_COLOR_META: Record<number, { label: string; bg: string }> = {
  1: { label: 'Red', bg: 'bg-red-500' },
  2: { label: 'Blue', bg: 'bg-blue-500' },
  3: { label: 'Green', bg: 'bg-green-500' },
  4: { label: 'Yellow', bg: 'bg-yellow-400' },
  5: { label: 'Orange', bg: 'bg-orange-500' },
  6: { label: 'Purple', bg: 'bg-purple-500' },
};

function hasOptionValue<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function isStateRegression(prev: Game, next: Game): boolean {
  const prevHasCommitment = hasOptionValue(prev.commitment);
  const nextHasCommitment = hasOptionValue(next.commitment);
  if (prevHasCommitment && !nextHasCommitment) return true;

  if (next.guesses.length < prev.guesses.length) return true;
  if (next.feedbacks.length < prev.feedbacks.length) return true;
  if (Number(next.attempts_used) < Number(prev.attempts_used)) return true;
  if (Number(next.next_guess_id) < Number(prev.next_guess_id)) return true;
  if (prev.ended && !next.ended) return true;

  const prevPending = hasOptionValue(prev.pending_guess_id) ? Number(prev.pending_guess_id) : null;
  const nextPending = hasOptionValue(next.pending_guess_id) ? Number(next.pending_guess_id) : null;
  if (
    prevPending !== null &&
    nextPending === null &&
    next.feedbacks.length === prev.feedbacks.length
  ) {
    return true;
  }

  return false;
}

function chooseProgressedState(prev: Game | null, next: Game): Game {
  if (!prev) return next;
  if (isStateRegression(prev, next)) return prev;
  return next;
}

function serializeGame(game: Game | null): string {
  if (!game) return '';
  return JSON.stringify(game, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

function describeRemoteConfirmation(
  prev: Game | null,
  next: Game,
  userAddress: string,
  sid: number
): { key: string; text: string } | null {
  if (!prev) return null;

  if (!prev.ended && next.ended) {
    const winner =
      next.winner === next.player1 ? 'Codemaker'
      : next.winner === next.player2 ? 'Codebreaker'
      : 'Unknown';
    return { key: `ended:${sid}:${next.winner ?? 'none'}`, text: `On-chain update confirmed: game ended. Winner: ${winner}.` };
  }

  const prevHasCommitment = hasOptionValue(prev.commitment);
  const nextHasCommitment = hasOptionValue(next.commitment);
  if (!prevHasCommitment && nextHasCommitment && userAddress === next.player2) {
    return { key: `commitment:${sid}:1`, text: 'On-chain update confirmed: Codemaker commitment received. You can submit a guess.' };
  }

  if (next.guesses.length > prev.guesses.length && hasOptionValue(next.pending_guess_id) && userAddress === next.player1) {
    return { key: `guess:${sid}:${next.guesses.length}`, text: 'On-chain update confirmed: Codebreaker guess received. Submit feedback proof.' };
  }

  if (next.feedbacks.length > prev.feedbacks.length && userAddress === next.player2) {
    return { key: `feedback:${sid}:${next.feedbacks.length}`, text: 'On-chain update confirmed: Codemaker feedback proof received. You can submit the next guess.' };
  }

  return null;
}

function currentTurnAction(game: Game): string {
  if (game.ended) {
    return 'Current turn: Game ended.';
  }
  if (!hasOptionValue(game.commitment)) {
    return 'Current turn: Codemaker make commitment.';
  }
  if (hasOptionValue(game.pending_guess_id)) {
    return 'Current turn: Codemaker submit feedback proof.';
  }
  return 'Current turn: Codebreaker submit guess.';
}

function isGameNotFoundError(err: unknown): boolean {
  return String(err).includes('Game not found');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractTxHash(submission: any): string | null {
  return (
    submission?.sendTransactionResponse?.hash ||
    submission?.getTransactionResponse?.hash ||
    submission?.getTransactionResponse?.txHash ||
    submission?.hash ||
    null
  );
}

function txUrl(hash: string | null): string {
  return hash ? `${STELLAR_EXPERT_TX_BASE}${hash}` : '';
}

function extractFirstUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s]+/);
  return m ? m[0] : null;
}

function removeFirstUrl(text: string): string {
  return text.replace(/https?:\/\/[^\s]+/, '').replace(/\n{2,}/g, '\n').trim();
}

function parseCsvSalt16(input: string): Salt16 {
  const raw = input.trim();
  const normalized = raw.startsWith('0x') || raw.startsWith('0X') ? raw.slice(2) : raw;
  if (!/^[0-9a-fA-F]{32}$/.test(normalized)) {
    throw new Error('Expected salt as 0x + 32 hex chars (16 bytes)');
  }
  const values: number[] = [];
  for (let i = 0; i < 32; i += 2) {
    values.push(parseInt(normalized.slice(i, i + 2), 16));
  }
  return values as Salt16;
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
  for (let d = 1; d <= 6; d++) {
    const secretCount = secret.filter((x) => x === d).length;
    const guessCount = guess.filter((x) => x === d).length;
    totalMatches += Math.min(secretCount, guessCount);
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
  if (parsed.some((v) => v < 1 || v > 6)) {
    throw new Error('On-chain guess is not a valid 1..6 guess');
  }
  return parsed;
}

function renderColorPeg(value: number, size = 'h-7 w-7') {
  const meta = PEG_COLOR_META[value] ?? { label: `#${value}`, bg: 'bg-gray-300' };
  return (
    <div
      className={`${size} ${meta.bg} rounded-full border border-gray-700 shadow-sm`}
      title={`${value}: ${meta.label}`}
    />
  );
}

function renderFeedbackPegs(exact?: number, partial?: number) {
  const exactN = Number(exact ?? 0);
  const partialN = Number(partial ?? 0);
  const pegs: Array<'black' | 'white' | 'empty'> = [];
  for (let i = 0; i < exactN; i++) pegs.push('black');
  for (let i = 0; i < partialN; i++) pegs.push('white');
  while (pegs.length < 4) pegs.push('empty');
  return pegs;
}

function setGuessDigitAt(current: Guess4, index: number, value: number): Guess4 {
  const next = [...current] as Guess4;
  next[index] = value;
  return next;
}

function logTxCreated(label: string, tx: unknown) {
  const anyTx = tx as { needsNonInvokerSigningBy?: () => string[]; simulationData?: unknown; toJSON?: () => unknown };
  try {
    const needs = typeof anyTx?.needsNonInvokerSigningBy === 'function' ? anyTx.needsNonInvokerSigningBy() : [];
    console.log(`[my-game-ui][tx] created ${label}`, {
      hasSimulationData: !!anyTx?.simulationData,
      needsNonInvokerSigningBy: needs,
    });
  } catch {
    console.log(`[my-game-ui][tx] created ${label}`);
  }
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
  userAddress: initialUserAddress,
  initialXDR,
  initialSessionId,
  onStandingsRefresh,
  onGameComplete,
}: MyGameGameProps) {
  const {
    publicKey,
    isConnected,
    isConnecting,
    error: walletError,
    wallets,
    connect,
    switchLocalWallet,
    getContractSigner,
  } = useWallet();
  const userAddress = publicKey ?? initialUserAddress ?? '';

  const [phase, setPhase] = useState<UiPhase>('landing');
  const [authMode, setAuthMode] = useState<AuthMode>('create');

  const [sessionId, setSessionId] = useState<number>(randomSessionId());
  const [guessDigits, setGuessDigits] = useState<Guess4>([1, 2, 3, 4]);
  const [secretDigits, setSecretDigits] = useState<Guess4>([1, 2, 3, 4]);
  const [saltInput, setSaltInput] = useState('0x0b0c0d0e0f101112131415161718191a');

  const [preparedAuthCode, setPreparedAuthCode] = useState('');
  const [importAuthCode, setImportAuthCode] = useState('');
  const [loadSessionInput, setLoadSessionInput] = useState('');
  const [parsedAuthInfo, setParsedAuthInfo] = useState<{
    sessionId: number;
    player1: string;
    player1Points: string;
  } | null>(null);
  const [authParseError, setAuthParseError] = useState('');

  const [game, setGame] = useState<Game | null>(null);
  const [loading, setLoading] = useState(false);
  const [quickstartLoading, setQuickstartLoading] = useState(false);
  const [isAwaitingConfirmation, setIsAwaitingConfirmation] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [secretRecoveryError, setSecretRecoveryError] = useState('');
  const [logEntries, setLogEntries] = useState<UiLogEntry[]>([]);
  const [authCodeCopied, setAuthCodeCopied] = useState(false);
  const [shareUrlCopied, setShareUrlCopied] = useState(false);
  const gameRef = useRef<Game | null>(null);
  const seenRemoteEventKeysRef = useRef<Set<string>>(new Set());
  const logSeqRef = useRef(0);

  const allowHttp = RPC_URL.startsWith('http://');

  const keypairs = useMemo(() => {
    const map: Record<string, Keypair> = {};
    for (const wallet of wallets) {
      const kp = Keypair.fromSecret(wallet.secret);
      map[kp.publicKey()] = kp;
    }
    return map;
  }, [wallets]);

  const myGameService = useMemo(() => new MyGameService(MY_GAME_CONTRACT), []);

  useEffect(() => {
    if (initialXDR) {
      console.log('[my-game-ui] initialXDR detected');
      setPhase('auth');
      setAuthMode('import');
      setImportAuthCode(initialXDR);
      return;
    }
    if (initialSessionId !== null && initialSessionId !== undefined) {
      console.log('[my-game-ui] initialSessionId detected', initialSessionId);
      setPhase('auth');
      setAuthMode('load');
      setLoadSessionInput(String(initialSessionId));
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const auth = params.get('auth');
    const sid = params.get('session-id');
    if (auth) {
      console.log('[my-game-ui] URL auth detected');
      setPhase('auth');
      setAuthMode('import');
      setImportAuthCode(auth);
    } else if (sid) {
      console.log('[my-game-ui] URL session-id detected', sid);
      setPhase('auth');
      setAuthMode('load');
      setLoadSessionInput(sid);
    }
  }, [initialXDR, initialSessionId]);

  useEffect(() => {
    if (!importAuthCode.trim()) {
      setParsedAuthInfo(null);
      setAuthParseError('');
      return;
    }
    try {
      const parsed = myGameService.parseAuthEntry(importAuthCode.trim());
      setParsedAuthInfo({
        sessionId: parsed.sessionId,
        player1: parsed.player1,
        player1Points: parsed.player1Points.toString(),
      });
      setAuthParseError('');
    } catch (e) {
      setParsedAuthInfo(null);
      setAuthParseError(String(e));
    }
  }, [importAuthCode, myGameService]);

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
    try {
      await fn();
    } catch (e) {
      setError(String(e));
      console.error('[my-game-ui] action failed', e);
    } finally {
      setLoading(false);
    }
  };

  const fetchLatestGameWithRetry = async (
    sid: number,
    retries: number = 14,
    baseDelayMs: number = 1_200
  ): Promise<Game> => {
    let lastErr: unknown = null;
    for (let i = 0; i <= retries; i++) {
      try {
        return await fetchLatestGameBySession(sid);
      } catch (e) {
        lastErr = e;
        if (!isGameNotFoundError(e) || i === retries) {
          throw e;
        }
        const backoff = Math.min(baseDelayMs * (1 + i * 0.6), 4_500);
        await sleep(backoff);
      }
    }
    throw lastErr ?? new Error(`Game not found for session_id=${sid}`);
  };

  const applyLoadedGame = (target: number, g: Game): Game => {
    if (userAddress && g.player1 !== userAddress && g.player2 !== userAddress) {
      throw new Error(`Connected wallet ${userAddress} is not part of this game`);
    }
    setSessionId(target);
    setGame((prev) => chooseProgressedState(prev, g));
    gameRef.current = g;
    seenRemoteEventKeysRef.current.clear();
    setPhase('game');
    return g;
  };

  const loadGame = async (sid?: number): Promise<Game> => {
    const target = sid ?? sessionId;
    console.log('[my-game-ui] loadGame', { sessionId: target });
    try {
      const g = await fetchLatestGameWithRetry(target);
      applyLoadedGame(target, g);
      console.log('[my-game-ui] game loaded', g);
      return g;
    } catch (e) {
      if (isGameNotFoundError(e) && gameRef.current && sessionId === target) {
        console.warn('[my-game-ui] get_game temporary not found; keeping previous local game state', { sessionId: target });
        return gameRef.current;
      }
      throw e;
    }
  };

  const fetchLatestGame = async (): Promise<Game> => {
    return fetchLatestGameBySession(sessionId);
  };

  const fetchLatestGameBySession = async (sid: number): Promise<Game> => {
    const reader = createClient(userAddress);
    const tx = await reader.get_game({ session_id: sid });
    logTxCreated(`get_game(session_id=${sid})`, tx);
    const sim = await tx.simulate();
    if (!sim.result.isOk()) {
      throw new Error(`Game not found for session_id=${sid}`);
    }
    return sim.result.unwrap();
  };

  const waitForGameCondition = async (
    predicate: (next: Game) => boolean,
    timeoutMs: number = 90_000,
    intervalMs: number = 2_000,
    sid: number = sessionId
  ): Promise<Game> => {
    const started = Date.now();
    while (Date.now() - started <= timeoutMs) {
      try {
        const latest = await fetchLatestGameBySession(sid);
        if (predicate(latest)) {
          return latest;
        }
      } catch {
        // ignore transient read errors while waiting for confirmation
      }
      await sleep(intervalMs);
    }
    throw new Error('Transaction submitted but confirmation timed out. Please refresh game state.');
  };

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let stopped = false;
    let latestPollId = 0;

    const poll = async () => {
      if (stopped) return;
      if (!userAddress) return;
      if (isAwaitingConfirmation) return;
      const pollId = ++latestPollId;
      try {
        if (phase === 'auth') {
          const sid = Number(loadSessionInput.trim() || sessionId);
          if (!Number.isInteger(sid) || sid <= 0) return;
          const reader = createClient(userAddress);
          const tx = await reader.get_game({ session_id: sid });
          if (stopped || pollId !== latestPollId) return;
          logTxCreated(`poll/get_game(session_id=${sid})`, tx);
          const sim = await tx.simulate();
          if (stopped || pollId !== latestPollId) return;
          if (sim.result.isOk()) {
            const g = sim.result.unwrap();
            if (g.player1 === userAddress || g.player2 === userAddress) {
              setSessionId(sid);
              setGame(g);
              gameRef.current = g;
              seenRemoteEventKeysRef.current.clear();
              setPhase('game');
              setMessage(`On-chain update confirmed: game session is live.\n${currentTurnAction(g)}`);
            }
          }
          return;
        }

        if (phase === 'game') {
          const latest = await fetchLatestGame();
          if (stopped || pollId !== latestPollId) return;
          const prev = gameRef.current;
          const progressed = chooseProgressedState(prev, latest);
          const prevJson = serializeGame(prev);
          const nextJson = serializeGame(progressed);
          if (prevJson !== nextJson) {
            gameRef.current = progressed;
            setGame(progressed);
            const remoteEvent = describeRemoteConfirmation(prev, progressed, userAddress, sessionId);
            if (remoteEvent) {
              const seen = seenRemoteEventKeysRef.current;
              const alreadySeen = seen.has(remoteEvent.key);
              seen.add(remoteEvent.key);
              if (!alreadySeen && !loading && !quickstartLoading && !isAwaitingConfirmation) {
                setMessage(remoteEvent.text);
              }
            }
          }
        }
      } catch {
        // ignore polling errors (session may not exist yet)
      }
    };

    timer = setInterval(poll, 1200);
    void poll();
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
    };
  }, [phase, userAddress, loadSessionInput, sessionId, isAwaitingConfirmation, loading, quickstartLoading]);

  useEffect(() => {
    gameRef.current = game;
  }, [game]);

  const handlePrepareAuthCode = () => run(async () => {
    console.log('[my-game-ui] prepare auth code', { sessionId, userAddress });
    if (!userAddress) throw new Error('Connect wallet first');

    const placeholderP2 = await getFundedSimulationSourceAddress([userAddress]);
    console.log('[my-game-ui] selected placeholder source for prepareStartGame', placeholderP2);

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
    setMessage('Auth code prepared. Share it with the Codebreaker (any other wallet)');
    console.log('[my-game-ui] prepared auth code length', authEntryXdr.length);
  });

  const handleImportAndStart = () => run(async () => {
    console.log('[my-game-ui] import+start');
    setMessage('Codebreaker start-game initiated from auth code. Preparing transaction...');
    if (!importAuthCode.trim()) throw new Error('Paste auth code first');
    if (!userAddress) throw new Error('Connect wallet first');

    const parsed = myGameService.parseAuthEntry(importAuthCode.trim());
    if (parsed.player1 === userAddress) {
      throw new Error('Codemaker cannot import as Codebreaker. Switch to another wallet.');
    }

    const stake = 100_0000000n;
    const signer = getContractSigner();
    const fullTxXdr = await myGameService.importAndSignAuthEntry(
      importAuthCode.trim(),
      userAddress,
      stake,
      signer,
    );
    let submittedHash: string | null = null;
    setIsAwaitingConfirmation(true);
    try {
      const submitted = await myGameService.finalizeStartGame(fullTxXdr, userAddress, signer);
      submittedHash = extractTxHash(submitted);
      const submittedUrl = txUrl(submittedHash);
      setMessage(
        submittedUrl
          ? `Codebreaker start-game transaction sent. Waiting for confirmation.\n${submittedUrl}`
          : 'Codebreaker start-game transaction sent. Waiting for confirmation...'
      );
      const confirmed = await waitForGameCondition(
        (next) =>
          next.player1 === parsed.player1 &&
          next.player2 === userAddress,
        90_000,
        2_000,
        parsed.sessionId
      );
      applyLoadedGame(parsed.sessionId, confirmed);
    } finally {
      setIsAwaitingConfirmation(false);
    }

    console.log('[my-game-ui] start_game submitted from imported auth entry');
    const confirmedUrl = txUrl(submittedHash);
    setMessage(
      confirmedUrl
        ? `Codebreaker start-game transaction confirmed. Loading game.\n${confirmedUrl}`
        : 'Codebreaker start-game transaction confirmed. Loading game...'
    );
    const loaded = gameRef.current ?? await loadGame(parsed.sessionId);
    setMessage(
      confirmedUrl
        ? `Transaction confirmed.\n${currentTurnAction(loaded)}\n${confirmedUrl}`
        : `Transaction confirmed.\n${currentTurnAction(loaded)}`
    );
  });

  const handleLoadSession = () => run(async () => {
    const sid = Number(loadSessionInput.trim());
    if (!Number.isInteger(sid) || sid <= 0) throw new Error('Enter valid session id');
    console.log('[my-game-ui] load existing session', sid);
    setMessage('Session not found yet, retrying...');
    const loaded = await loadGame(sid);
    setMessage(`Loaded existing game.\n${currentTurnAction(loaded)}`);
  });

  const handleQuickStart = async () => {
    if (loading || quickstartLoading) return;
    setQuickstartLoading(true);
    setError('');
    try {
      console.log('[my-game-ui] quickstart begin');
      setMessage('Quickstart initiated. Preparing Codemaker and Codebreaker transaction...');

      if (!isConnected) {
        await connect();
      }

      let localWallets = wallets;
      if (localWallets.length < 2) {
        localWallets = standaloneWalletService.getWallets().wallets;
      }
      if (localWallets.length < 2) {
        throw new Error('Missing local wallets. Connect wallet first.');
      }

      const p1 = localWallets[0].publicKey; // Wallet 1 = Codemaker
      const p2 = localWallets[1].publicKey; // Wallet 2 = Codebreaker

      // Ensure both quickstart wallets are funded when balance is missing/low.
      for (const address of [p1, p2]) {
        const balanceRaw = await standaloneWalletService.getNativeBalance(address);
        const balance = balanceRaw ? Number.parseFloat(balanceRaw) : 0;
        if (!balanceRaw || Number.isNaN(balance) || balance < 100) {
          console.log('[my-game-ui] funding wallet via friendbot', address);
          await standaloneWalletService.fundWithFriendbot(address);
        }
      }

      const sid = Number.isInteger(sessionId) && sessionId > 0 ? sessionId : randomSessionId();
      if (sid !== sessionId) {
        setSessionId(sid);
      }

      const stake = 100_0000000n;
      const client = createClient(p2);
      const tx = await client.start_game({
        session_id: sid,
        player1: p1,
        player2: p2,
        player1_points: stake,
        player2_points: stake,
      });
      logTxCreated(`start_game(session_id=${sid})`, tx);

      const needed = tx.needsNonInvokerSigningBy();
      console.log('[my-game-ui] quickstart needed signatures', needed);
      for (const addr of needed) {
        const kp = keypairs[addr];
        if (!kp) throw new Error(`Missing keypair for ${addr}`);
        await tx.signAuthEntries({
          address: addr,
          signAuthEntry: async (preimageXdr: string) => {
            const payload = hash(Buffer.from(preimageXdr, 'base64'));
            const sig = kp.sign(payload);
            return { signedAuthEntry: Buffer.from(sig).toString('base64') };
          },
        });
      }

      setIsAwaitingConfirmation(true);
      let submittedHash: string | null = null;
      try {
        const submitted = await tx.signAndSend();
        submittedHash = extractTxHash(submitted);
        console.log('[my-game-ui][tx] sent start_game', { sessionId: sid });
        const submittedUrl = txUrl(submittedHash);
        setMessage(
          submittedUrl
            ? `Quickstart transaction sent. Waiting for confirmation.\n${submittedUrl}`
            : 'Quickstart transaction sent. Waiting for confirmation...'
        );
        const confirmed = await waitForGameCondition((g) => g.player1 === p1 && g.player2 === p2, 90_000, 2_000, sid);
        applyLoadedGame(sid, confirmed);
      } finally {
        setIsAwaitingConfirmation(false);
      }
      await switchLocalWallet(0);
      await loadGame(sid);
      const confirmedUrl = txUrl(submittedHash);
      setMessage(
        confirmedUrl
          ? `Transaction confirmed. Session ${sid} is ready. Waiting for Codemaker secret commitment.\n${confirmedUrl}`
          : `Transaction confirmed. Session ${sid} is ready. Waiting for Codemaker secret commitment.`
      );
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
    setMessage('Codemaker commitment initiated. Preparing transaction...');
    if (!game) throw new Error('Load game first');
    if (userAddress !== game.player1) throw new Error(`Only Codemaker can commit. Expected ${game.player1}`);

    const secret = secretDigits;
    const salt = parseCsvSalt16(saltInput);
    const commitment = await fetchCommitment(secret, salt);
    const saltHex = `0x${saltInput.trim().replace(/^0x/i, '').toLowerCase()}`;
    const snapshot: StoredSecretState = {
      sessionId,
      player1: game.player1,
      secretDigits: secret,
      saltHex,
      updatedAt: Date.now(),
    };
    localStorage.setItem(SECRET_STATE_KEY, JSON.stringify(snapshot));

    const client = createClient(game.player1);
    const tx = await client.commit_code({
      session_id: sessionId,
      commitment: commitmentFieldBytes(commitment),
    });
    logTxCreated(`commit_code(session_id=${sessionId})`, tx);
    const before = await fetchLatestGame();
    setIsAwaitingConfirmation(true);
    let submittedHash: string | null = null;
    try {
      const submitted = await tx.signAndSend();
      submittedHash = extractTxHash(submitted);
      console.log('[my-game-ui][tx] sent commit_code', { sessionId });
      const submittedUrl = txUrl(submittedHash);
      setMessage(
        submittedUrl
          ? `Codemaker transaction sent. Waiting for confirmation.\n${submittedUrl}`
          : 'Codemaker transaction sent. Waiting for confirmation...'
      );
      const confirmed = await waitForGameCondition((next) => !hasOptionValue(before.commitment) && hasOptionValue(next.commitment));
      applyLoadedGame(sessionId, confirmed);
    } finally {
      setIsAwaitingConfirmation(false);
    }
    await loadGame(sessionId);
    setSecretRecoveryError('');
    const confirmedUrl = txUrl(submittedHash);
    setMessage(
      confirmedUrl
        ? `Codemaker transaction confirmed. Waiting for Codebreaker guess.\n${confirmedUrl}`
        : 'Codemaker transaction confirmed. Waiting for Codebreaker guess.'
    );
  });

  const handleGuess = () => run(async () => {
    console.log('[my-game-ui] guess', { sessionId, guessDigits });
    setMessage('Codebreaker guess initiated. Preparing transaction...');
    if (!game) throw new Error('Load game first');
    if (userAddress !== game.player2) throw new Error(`Only Codebreaker can guess. Expected ${game.player2}`);
    if (!game.commitment) throw new Error('Wait for Codemaker to submit commitment first');
    if (hasOptionValue(game.pending_guess_id)) throw new Error('Wait for Codemaker feedback before next guess');

    const guess = guessDigits;
    const client = createClient(game.player2);
    const tx = await client.submit_guess({
      session_id: sessionId,
      guess: Buffer.from(guess),
    });
    logTxCreated(`submit_guess(session_id=${sessionId})`, tx);
    const before = await fetchLatestGame();
    setIsAwaitingConfirmation(true);
    let submittedHash: string | null = null;
    try {
      const submitted = await tx.signAndSend();
      submittedHash = extractTxHash(submitted);
      console.log('[my-game-ui][tx] sent submit_guess', { sessionId, guess });
      const submittedUrl = txUrl(submittedHash);
      setMessage(
        submittedUrl
          ? `Codebreaker transaction sent. Waiting for confirmation.\n${submittedUrl}`
          : 'Codebreaker transaction sent. Waiting for confirmation...'
      );
      const confirmed = await waitForGameCondition(
        (next) =>
          next.guesses.length > before.guesses.length &&
          hasOptionValue(next.pending_guess_id)
      );
      applyLoadedGame(sessionId, confirmed);
    } finally {
      setIsAwaitingConfirmation(false);
    }
    await loadGame(sessionId);
    const confirmedUrl = txUrl(submittedHash);
    setMessage(
      confirmedUrl
        ? `Codebreaker transaction confirmed. Waiting for Codemaker feedback proof.\n${confirmedUrl}`
        : 'Codebreaker transaction confirmed. Waiting for Codemaker feedback proof.'
    );
  });

  const handleFeedbackProof = () => run(async () => {
    console.log('[my-game-ui] feedback+proof', { sessionId });
    setMessage('Codemaker proof initiated. Preparing transaction...');
    let latestGame = await fetchLatestGame();
    setGame(latestGame);
    if (userAddress !== latestGame.player1) throw new Error(`Only Codemaker can submit feedback proof. Expected ${latestGame.player1}`);

    if (!hasOptionValue(latestGame.pending_guess_id)) {
      setMessage('Codemaker proof initiated. Waiting for pending guess confirmation...');
      latestGame = await waitForGameCondition((next) => hasOptionValue(next.pending_guess_id), 45_000, 1_500);
      setGame((prev) => chooseProgressedState(prev, latestGame));
    }

    if (!hasOptionValue(latestGame.pending_guess_id)) {
      throw new Error('No pending guess to prove feedback for');
    }

    const pendingGuessId = Number(latestGame.pending_guess_id);
    let guessRecord = latestGame.guesses.find((g: { guess_id: number | bigint; guess: Buffer }) => Number(g.guess_id) === pendingGuessId);
    if (!guessRecord) {
      setMessage('Codemaker proof initiated. Waiting for pending guess record...');
      latestGame = await waitForGameCondition(
        (next) => next.guesses.some((g: { guess_id: number | bigint }) => Number(g.guess_id) === pendingGuessId),
        45_000,
        1_500
      );
      setGame((prev) => chooseProgressedState(prev, latestGame));
      guessRecord = latestGame.guesses.find((g: { guess_id: number | bigint; guess: Buffer }) => Number(g.guess_id) === pendingGuessId);
    }
    if (!guessRecord) throw new Error(`Missing guess record for guess_id ${pendingGuessId}`);

    const secret = secretDigits;
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
    const tx = await client.submit_feedback_proof({
      session_id: sessionId,
      guess_id: pendingGuessId,
      exact: fb.exact,
      partial: fb.partial,
      proof_blob: proofBlob,
    });
    logTxCreated(`submit_feedback_proof(session_id=${sessionId}, guess_id=${pendingGuessId})`, tx);
    const before = await fetchLatestGame();
    setIsAwaitingConfirmation(true);
    let confirmed: Game;
    let submittedHash: string | null = null;
    try {
      const submitted = await tx.signAndSend();
      submittedHash = extractTxHash(submitted);
      console.log('[my-game-ui][tx] sent submit_feedback_proof', {
        sessionId,
        guessId: pendingGuessId,
        exact: fb.exact,
        partial: fb.partial,
      });
      const submittedUrl = txUrl(submittedHash);
      setMessage(
        submittedUrl
          ? `Codemaker proof transaction sent. Waiting for confirmation.\n${submittedUrl}`
          : 'Codemaker proof transaction sent. Waiting for confirmation...'
      );
      confirmed = await waitForGameCondition(
        (next) =>
          next.feedbacks.length > before.feedbacks.length ||
          next.ended
      );
    } finally {
      setIsAwaitingConfirmation(false);
    }
    applyLoadedGame(sessionId, confirmed);
    await loadGame(sessionId);
    const confirmedUrl = txUrl(submittedHash);
    setMessage(
      confirmed.ended
        ? (confirmedUrl
          ? `Codemaker proof transaction confirmed. Game finished.\n${confirmedUrl}`
          : 'Codemaker proof transaction confirmed. Game finished.')
        : (confirmedUrl
          ? `Codemaker proof transaction confirmed. Waiting for Codebreaker next guess.\n${confirmedUrl}`
          : 'Codemaker proof transaction confirmed. Waiting for Codebreaker next guess.')
    );
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
    setSecretRecoveryError('');
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
        ? 'Codemaker'
        : winnerAddress === game?.player2
          ? 'Codebreaker'
        : winnerAddress === userAddress
          ? 'You'
          : 'Unknown'
    : null;
  const isPlayer1 = !!game && userAddress === game.player1;
  const isPlayer2 = !!game && userAddress === game.player2;
  const hasCommitment = !!game && game.commitment !== null && game.commitment !== undefined;
  const canCommit = !!game && !game.ended && userAddress === game.player1 && !hasCommitment;
  const hasPendingGuess = !!game && hasOptionValue(game.pending_guess_id);
  const canGuess = !!game && !game.ended && userAddress === game.player2 && hasCommitment && !hasPendingGuess;
  const canFeedback = !!game && !game.ended && userAddress === game.player1 && hasPendingGuess;
  const isUiBusy = loading || quickstartLoading || isAwaitingConfirmation || isConnecting;
  const pendingGuessDigits = (() => {
    if (!game || !hasOptionValue(game.pending_guess_id)) return null as Guess4 | null;
    const rec = game.guesses.find((g: { guess_id: number | bigint; guess: Buffer }) => Number(g.guess_id) === Number(game.pending_guess_id));
    if (!rec) return null;
    try {
      return parseGuessBuffer(Buffer.from(rec.guess));
    } catch {
      return null;
    }
  })();
  const latestFeedback = (() => {
    if (!game || game.feedbacks.length === 0) return null;
    return game.feedbacks[game.feedbacks.length - 1];
  })();
  const guessHistory = (() => {
    if (!game) return [] as Array<{ guessId: number; guess: string; guessDigits: Guess4 | null; exact?: number; partial?: number }>;
    const feedbackById = new Map<number, { exact: number; partial: number }>();
    for (const fb of game.feedbacks) {
      feedbackById.set(Number(fb.guess_id), { exact: Number(fb.exact), partial: Number(fb.partial) });
    }
    const rows: Array<{ guessId: number; guess: string; guessDigits: Guess4 | null; exact?: number; partial?: number }> = [];
    for (const rec of game.guesses) {
      const guessId = Number(rec.guess_id);
      let guessText = '';
      let guessDigits: Guess4 | null = null;
      try {
        const g = parseGuessBuffer(Buffer.from(rec.guess));
        guessDigits = g;
        guessText = `${g[0]},${g[1]},${g[2]},${g[3]}`;
      } catch {
        guessText = '(invalid)';
      }
      const fb = feedbackById.get(guessId);
      rows.push({
        guessId,
        guess: guessText,
        guessDigits,
        exact: fb?.exact,
        partial: fb?.partial,
      });
    }
    return rows;
  })();
  const latestBanner = (() => {
    if (error) return { text: error, cls: 'from-red-50 to-pink-50 border-red-200 text-red-700' };
    if (secretRecoveryError) return { text: secretRecoveryError, cls: 'from-red-50 to-pink-50 border-red-200 text-red-700' };
    if (message) return { text: message, cls: 'from-blue-50 to-cyan-50 border-blue-200 text-blue-700' };
    if (logEntries.length > 0) return { text: logEntries[logEntries.length - 1].text, cls: 'from-blue-50 to-cyan-50 border-blue-200 text-blue-700' };
    return null;
  })();

  const pushLog = (text: string, level: 'info' | 'error' = 'info') => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setLogEntries((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.text === trimmed && last.level === level) return prev;
      const next: UiLogEntry = { id: ++logSeqRef.current, level, text: trimmed };
      return [...prev.slice(-23), next];
    });
  };

  useEffect(() => {
    if (message) pushLog(removeFirstUrl(message), 'info');
  }, [message]);

  useEffect(() => {
    if (error) pushLog(error, 'error');
  }, [error]);

  useEffect(() => {
    if (!game || !userAddress) return;
    if (!hasCommitment || userAddress !== game.player1) {
      setSecretRecoveryError('');
      return;
    }
    try {
      const raw = localStorage.getItem(SECRET_STATE_KEY);
      if (!raw) {
        setSecretRecoveryError('You lost the secret and salt for this committed session. Please start again.');
        return;
      }
      const saved = JSON.parse(raw) as StoredSecretState;
      if (saved.sessionId !== sessionId || saved.player1 !== game.player1) {
        setSecretRecoveryError('You lost the secret and salt for this committed session. Please start again.');
        return;
      }
      if (!Array.isArray(saved.secretDigits) || saved.secretDigits.length !== 4) {
        setSecretRecoveryError('Saved secret format is invalid. Please start again.');
        return;
      }
      setSecretDigits([
        Number(saved.secretDigits[0]),
        Number(saved.secretDigits[1]),
        Number(saved.secretDigits[2]),
        Number(saved.secretDigits[3]),
      ]);
      setSaltInput(saved.saltHex);
      setSecretRecoveryError('');
    } catch {
      setSecretRecoveryError('You lost the secret and salt for this committed session. Please start again.');
    }
  }, [game, userAddress, sessionId, hasCommitment]);

  return (
    <div className={`pixel-shell checker-bg ${phase === 'landing' ? 'landing-mode' : ''}`}>
      {phase !== 'landing' && (
        <div className="pixel-topbar">
          <h2 className="pixel-title">ZK MASTERMIND</h2>
          <div className="pixel-status">
            <span className="pixel-chip">ROLE: {isPlayer1 ? 'CODEMAKER' : isPlayer2 ? 'CODEBREAKER' : 'SPECTATOR'}</span>
            <span className="pixel-chip">SESSION: {String(sessionId)}</span>
          </div>
        </div>
      )}

      {latestBanner && (
        <div className="pixel-banner">
          <p className="whitespace-pre-line">{removeFirstUrl(latestBanner.text)}</p>
          {(() => {
            const url = extractFirstUrl(latestBanner.text);
            if (!url) return null;
            return (
              <a className="block mt-2 underline break-all" href={url} target="_blank" rel="noreferrer">
                {url}
              </a>
            );
          })()}
        </div>
      )}

      {phase === 'landing' && (
        <section className="pixel-hero full-hero">
          <div className="pixel-hero-main">
            <div>
              <h3 className="pixel-hero-title">ZK MASTERMIND</h3>
              <p className="pixel-hero-copy">
                Guess the hidden 4-color code in up to 12 rounds and use exact/partial feedback to solve it.
              </p>
              <div className="flex flex-wrap gap-3 mt-6">
                <button className="pixel-btn" onClick={() => setPhase('auth')}>START GAME</button>
                <a
                  className="pixel-btn pixel-btn-alt inline-flex items-center"
                  href={DEMO_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  WATCH DEMO
                </a>
                <a
                  className="pixel-btn pixel-btn-alt inline-flex items-center"
                  href={SOURCE_CODE_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  SOURCE CODE
                </a>
                {!isConnected && (
                  <button className="pixel-btn pixel-btn-alt" onClick={() => void connect()} disabled={isConnecting}>
                    {isConnecting ? 'CONNECTING...' : 'CONNECT WALLET'}
                  </button>
                )}
              </div>
              {walletError && <p className="text-sm text-red-700 font-semibold mt-3">{walletError}</p>}
            </div>

            <div className="pixel-stage">
              <div className="pixel-stage-board">
                <div className="stage-row">
                  <div className="stage-pegs">{renderColorPeg(1, 'h-7 w-7')}{renderColorPeg(4, 'h-7 w-7')}{renderColorPeg(2, 'h-7 w-7')}{renderColorPeg(6, 'h-7 w-7')}</div>
                  <div className="stage-clues"><span className="feedback-peg black" /><span className="feedback-peg white" /><span className="feedback-peg empty" /><span className="feedback-peg empty" /></div>
                </div>
                <div className="stage-row">
                  <div className="stage-pegs">{renderColorPeg(3, 'h-7 w-7')}{renderColorPeg(2, 'h-7 w-7')}{renderColorPeg(1, 'h-7 w-7')}{renderColorPeg(5, 'h-7 w-7')}</div>
                  <div className="stage-clues"><span className="feedback-peg black" /><span className="feedback-peg black" /><span className="feedback-peg white" /><span className="feedback-peg empty" /></div>
                </div>
                <div className="stage-row">
                  <div className="stage-pegs">{renderColorPeg(1, 'h-7 w-7')}{renderColorPeg(3, 'h-7 w-7')}{renderColorPeg(5, 'h-7 w-7')}{renderColorPeg(2, 'h-7 w-7')}</div>
                  <div className="stage-clues"><span className="feedback-peg black" /><span className="feedback-peg black" /><span className="feedback-peg black" /><span className="feedback-peg white" /></div>
                </div>
              </div>
            </div>
          </div>

          <div className="pixel-hero-grid">
            <div className="pixel-panel">
              <p className="pixel-panel-title">1. CODEMAKER COMMITS</p>
              <p>Codemaker chooses a secret + salt, then stores only a hash commitment on-chain to prevent brute-force discovery of the secret.</p>
            </div>
            <div className="pixel-panel">
              <p className="pixel-panel-title">2. CODEBREAKER GUESSES</p>
              <p>Codebreaker submits 4-color guesses on-chain against that commitment, with a maximum of 12 attempts.</p>
            </div>
            <div className="pixel-panel">
              <p className="pixel-panel-title">3. FEEDBACK WITH ZK PROOF</p>
              <p>Codemaker returns exact/partial matches and proves correctness without revealing the secret code.</p>
            </div>
          </div>
        </section>
      )}

      {phase === 'auth' && (
        <section className="grid gap-5">
          {!isConnected ? (
            <div className="pixel-panel">
              <p className="pixel-panel-title">AUTH CHECKPOINT</p>
              <p className="mb-4">Connect local wallet to create/import/start a game session.</p>
              <button className="pixel-btn" onClick={() => void connect()} disabled={isConnecting}>
                {isConnecting ? 'CONNECTING...' : 'CONNECT WALLET'}
              </button>
              {walletError && <p className="text-sm text-red-700 font-semibold mt-3">{walletError}</p>}
            </div>
          ) : (
            <>
              <div className="pixel-tab-row">
                <button
                  onClick={() => setAuthMode('create')}
                  disabled={isUiBusy}
                  className={`pixel-tab ${authMode === 'create' ? 'active' : ''}`}
                >
                  CREATE
                </button>
                <button
                  onClick={() => setAuthMode('import')}
                  disabled={isUiBusy}
                  className={`pixel-tab ${authMode === 'import' ? 'active' : ''}`}
                >
                  IMPORT
                </button>
                <button
                  onClick={() => setAuthMode('load')}
                  disabled={isUiBusy}
                  className={`pixel-tab ${authMode === 'load' ? 'active' : ''}`}
                >
                  LOAD
                </button>
              </div>

              <div className="pixel-panel">
                <p className="pixel-panel-title">DEV QUICKSTART</p>
                <p className="mb-3">Creates and signs both local players in one move.</p>
                <button className="pixel-btn" onClick={handleQuickStart} disabled={isUiBusy}>
                  {quickstartLoading ? 'QUICKSTARTING...' : 'QUICKSTART MATCH'}
                </button>
              </div>

              {authMode === 'create' && (
                <div className="pixel-panel grid gap-4">
                  <label className="text-sm font-semibold">Session ID</label>
                  <input
                    value={String(sessionId)}
                    onChange={(e) => setSessionId(Number(e.target.value) || 0)}
                    className="pixel-input font-mono"
                  />
                  {!preparedAuthCode ? (
                    <button onClick={handlePrepareAuthCode} disabled={isUiBusy} className="pixel-btn">
                      {loading ? 'PREPARING...' : 'PREPARE AUTH ENTRY'}
                    </button>
                  ) : (
                    <div className="grid gap-3">
                      <div className="pixel-codebox">
                        <code>{preparedAuthCode}</code>
                      </div>
                      <div className="flex flex-wrap gap-3">
                        <button onClick={copyAuthCode} className="pixel-btn pixel-btn-alt">
                          {authCodeCopied ? 'COPIED' : 'COPY AUTH'}
                        </button>
                        <button onClick={copyShareUrlWithAuthCode} className="pixel-btn pixel-btn-alt">
                          {shareUrlCopied ? 'COPIED' : 'COPY SHARE URL'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {authMode === 'import' && (
                <div className="pixel-panel grid gap-4">
                  <p className="pixel-panel-title">IMPORT AUTH ENTRY</p>
                  <textarea
                    rows={5}
                    value={importAuthCode}
                    onChange={(e) => setImportAuthCode(e.target.value)}
                    className="pixel-input font-mono resize-none"
                  />
                  {parsedAuthInfo && (
                    <div className="pixel-codebox text-xs">
                      <p>Codemaker: {parsedAuthInfo.player1}</p>
                      <p>Session: {parsedAuthInfo.sessionId}</p>
                      <p>Codemaker points: {parsedAuthInfo.player1Points}</p>
                    </div>
                  )}
                  {authParseError && <p className="text-sm text-red-700 font-semibold">{authParseError}</p>}
                  <button
                    onClick={handleImportAndStart}
                    disabled={isUiBusy || !importAuthCode.trim() || !!authParseError}
                    className="pixel-btn"
                  >
                    {loading ? 'IMPORTING...' : 'IMPORT AND START'}
                  </button>
                </div>
              )}

              {authMode === 'load' && (
                <div className="pixel-panel grid gap-4">
                  <p className="pixel-panel-title">LOAD SESSION</p>
                  <input
                    value={loadSessionInput}
                    onChange={(e) => setLoadSessionInput(e.target.value)}
                    placeholder="Enter session ID"
                    className="pixel-input font-mono"
                  />
                  <div className="flex flex-wrap gap-3">
                    <button
                      onClick={handleLoadSession}
                      disabled={isUiBusy || !loadSessionInput.trim()}
                      className="pixel-btn"
                    >
                      {loading ? 'LOADING...' : 'LOAD GAME'}
                    </button>
                    <button onClick={copyShareUrlWithSession} disabled={!loadSessionInput.trim()} className="pixel-btn pixel-btn-alt">
                      {shareUrlCopied ? 'COPIED' : 'COPY SHARE URL'}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {phase === 'game' && (
        <section className="grid gap-4">
          {game?.ended ? (
            <div className="pixel-panel">
              <p className="pixel-panel-title">MATCH ENDED</p>
              <p>Winner: {winnerLabel || 'Unknown'}</p>
              <p>Attempts: {String(game.attempts_used)} / {String(game.max_attempts)}</p>
              <button disabled={isUiBusy} onClick={handleBackToAuth} className="pixel-btn mt-3">BACK TO AUTH</button>
            </div>
          ) : (
            <>
              <div className="pixel-board-meta">
                <p>You are {isPlayer1 ? 'Codemaker' : isPlayer2 ? 'Codebreaker' : 'Not in session'}</p>
                <p>Commitment: {hasCommitment ? 'LOCKED' : 'PENDING'}</p>
                {game && <p>{currentTurnAction(game)}</p>}
              </div>

              <div className="grid lg:grid-cols-2 gap-4">
                <div className="pixel-panel">
                  <p className="pixel-panel-title">ACTION DECK</p>
                  <div className="flex flex-wrap gap-2 mb-4">
                    <button disabled={isUiBusy || !canCommit} onClick={handleCommit} className="pixel-btn">1 COMMIT</button>
                    <button disabled={isUiBusy || !canGuess} onClick={handleGuess} className="pixel-btn">2 GUESS</button>
                    <button disabled={isUiBusy || !canFeedback} onClick={handleFeedbackProof} className="pixel-btn">3 PROVE</button>
                  </div>

                  {isPlayer1 && (
                    <div className="grid gap-3">
                      <label className="text-sm font-semibold">Salt (0x + 32 hex chars)</label>
                      <input
                        value={saltInput}
                        onChange={(e) => setSaltInput(e.target.value)}
                        disabled={!!game?.commitment || isUiBusy}
                        className="pixel-input font-mono"
                      />
                      <label className="text-sm font-semibold">Codemaker Secret</label>
                      <div className="flex gap-2 mb-2">
                        {secretDigits.map((d, idx) => (
                          <div key={`secret-selected-${idx}`}>{renderColorPeg(d, 'h-8 w-8')}</div>
                        ))}
                      </div>
                      {[0, 1, 2, 3].map((idx) => (
                        <div key={`secret-slot-${idx}`} className="grid grid-cols-[60px_1fr] items-center gap-2">
                          <span className="text-xs">Slot {idx + 1}</span>
                          <div className="flex flex-wrap gap-2">
                            {[1, 2, 3, 4, 5, 6].map((value) => (
                              <button
                                key={`secret-${idx}-${value}`}
                                type="button"
                                disabled={!!game?.commitment || isUiBusy}
                                onClick={() => setSecretDigits((prev) => setGuessDigitAt(prev, idx, value))}
                                className={`peg-picker ${secretDigits[idx] === value ? 'active' : ''}`}
                                title={`${value} ${PEG_COLOR_META[value].label}`}
                              >
                                {renderColorPeg(value, 'h-6 w-6')}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {isPlayer2 && (
                    <div className="grid gap-3">
                      <label className="text-sm font-semibold">Codebreaker Guess</label>
                      <div className="flex gap-2 mb-2">
                        {guessDigits.map((d, idx) => (
                          <div key={`guess-selected-${idx}`}>{renderColorPeg(d, 'h-8 w-8')}</div>
                        ))}
                      </div>
                      {[0, 1, 2, 3].map((idx) => (
                        <div key={`guess-slot-${idx}`} className="grid grid-cols-[60px_1fr] items-center gap-2">
                          <span className="text-xs">Slot {idx + 1}</span>
                          <div className="flex flex-wrap gap-2">
                            {[1, 2, 3, 4, 5, 6].map((value) => (
                              <button
                                key={`guess-${idx}-${value}`}
                                type="button"
                                disabled={isUiBusy}
                                onClick={() => setGuessDigits((prev) => setGuessDigitAt(prev, idx, value))}
                                className={`peg-picker ${guessDigits[idx] === value ? 'active' : ''}`}
                                title={`${value} ${PEG_COLOR_META[value].label}`}
                              >
                                {renderColorPeg(value, 'h-6 w-6')}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="pixel-board">
                  <p className="pixel-panel-title">MASTER BOARD</p>
                  <div className="grid gap-2">
                    {[...guessHistory].reverse().map((row) => {
                      const fbPegs = renderFeedbackPegs(row.exact, row.partial);
                      return (
                        <div key={row.guessId} className="pixel-row">
                          <div className="text-xs font-mono">#{row.guessId}</div>
                          <div className="flex gap-2">
                            {row.guessDigits
                              ? row.guessDigits.map((d, i) => <div key={`${row.guessId}-g-${i}`}>{renderColorPeg(d)}</div>)
                              : <span className="text-xs">{row.guess}</span>}
                          </div>
                          <div className="grid grid-cols-2 gap-1 justify-items-center">
                            {fbPegs.map((p, i) => (
                              <div
                                key={`${row.guessId}-fb-${i}`}
                                className={`feedback-peg ${p}`}
                                title={p === 'black' ? 'exact' : p === 'white' ? 'partial' : 'empty'}
                              />
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {latestFeedback && (
                    <p className="text-xs mt-3">
                      Latest feedback: exact={String(latestFeedback.exact)}, partial={String(latestFeedback.partial)}
                    </p>
                  )}
                  {pendingGuessDigits && (
                    <p className="text-xs mt-2">
                      Pending guess: {pendingGuessDigits.join(',')}
                    </p>
                  )}
                </div>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
