import { useEffect, useMemo, useState } from 'react';
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
type UiPhase = 'auth' | 'game';
const SECRET_STATE_KEY = 'my-game:latest-player1-secret';
const STELLAR_EXPERT_TX_BASE = 'https://stellar.expert/explorer/testnet/tx/';
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
  userAddress,
  initialXDR,
  initialSessionId,
  onStandingsRefresh,
  onGameComplete,
}: MyGameGameProps) {
  const {
    isConnected,
    wallets,
    connect,
    switchLocalWallet,
    getContractSigner,
  } = useWallet();

  const [phase, setPhase] = useState<UiPhase>('auth');
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
  const [authCodeCopied, setAuthCodeCopied] = useState(false);
  const [shareUrlCopied, setShareUrlCopied] = useState(false);

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
    logTxCreated(`get_game(session_id=${target})`, tx);
    const sim = await tx.simulate();
    if (!sim.result.isOk()) {
      throw new Error(`Game not found for session_id=${target}`);
    }

    const g = sim.result.unwrap();
    if (userAddress && g.player1 !== userAddress && g.player2 !== userAddress) {
      throw new Error(`Connected wallet ${userAddress} is not part of this game`);
    }

    setSessionId(target);
    setGame((prev) => chooseProgressedState(prev, g));
    setPhase('game');
    console.log('[my-game-ui] game loaded', g);
  };

  const fetchLatestGame = async (): Promise<Game> => {
    const reader = createClient(userAddress);
    const tx = await reader.get_game({ session_id: sessionId });
    logTxCreated(`get_game(session_id=${sessionId})`, tx);
    const sim = await tx.simulate();
    if (!sim.result.isOk()) {
      throw new Error(`Game not found for session_id=${sessionId}`);
    }
    return sim.result.unwrap();
  };

  const waitForGameCondition = async (
    predicate: (next: Game) => boolean,
    timeoutMs: number = 90_000,
    intervalMs: number = 2_000
  ): Promise<Game> => {
    const started = Date.now();
    while (Date.now() - started <= timeoutMs) {
      try {
        const latest = await fetchLatestGame();
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
              setPhase('game');
            }
          }
          return;
        }

        if (phase === 'game') {
          const latest = await fetchLatestGame();
          if (stopped || pollId !== latestPollId) return;
          setGame((prev: Game | null) => {
            const progressed = chooseProgressedState(prev, latest);
            const prevJson = prev ? JSON.stringify(prev, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) : '';
            const nextJson = JSON.stringify(progressed, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
            return prevJson === nextJson ? prev : progressed;
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
  }, [phase, userAddress, loadSessionInput, sessionId, isAwaitingConfirmation]);

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
      await waitForGameCondition(
        (next) =>
          next.player1 === parsed.player1 &&
          next.player2 === userAddress
      );
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
    await loadGame(parsed.sessionId);
    setMessage(
      confirmedUrl
        ? `Transaction confirmed. Waiting for Codemaker secret commitment.\n${confirmedUrl}`
        : 'Transaction confirmed. Waiting for Codemaker secret commitment.'
    );
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
        await waitForGameCondition((g) => g.player1 === p1 && g.player2 === p2);
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
      await waitForGameCondition((next) => !hasOptionValue(before.commitment) && hasOptionValue(next.commitment));
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
      await waitForGameCondition(
        (next) =>
          next.guesses.length > before.guesses.length &&
          hasOptionValue(next.pending_guess_id)
      );
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
    return null;
  })();

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
    <div className="bg-white/70 backdrop-blur-xl rounded-2xl p-8 shadow-xl border-2 border-purple-200">
      <div className="flex items-center mb-6">
        <div>
          <h2 className="text-3xl font-black bg-gradient-to-r from-purple-600 via-pink-600 to-red-600 bg-clip-text text-transparent">
            ZK Mastermind
          </h2>
          <p className="text-sm text-gray-700 font-semibold mt-1">Guess the 4-color code in up to 12 rounds.</p>
          <p className="text-xs text-gray-600 mt-1">Codemaker sets a secret code, Codebreaker guesses it, and ZK proof verifies feedback without revealing the secret.</p>
          <p className="text-lg font-black text-purple-700 mt-2">
            You are {isPlayer1 ? 'Codemaker' : isPlayer2 ? 'Codebreaker' : 'Not In Session'}
          </p>
        </div>
      </div>

      {latestBanner && (
        <div className={`mb-6 p-4 bg-gradient-to-r border-2 rounded-xl ${latestBanner.cls}`}>
          <p className="text-sm font-semibold whitespace-pre-line">{latestBanner.text}</p>
        </div>
      )}

      {phase === 'auth' && (
        <div className="space-y-8">
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 p-3 bg-gray-100 rounded-xl">
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

          <div className="p-5 bg-gradient-to-r from-yellow-50 to-orange-50 border-2 border-yellow-200 rounded-xl">
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
            <div className="space-y-7">
              <div className="space-y-5">
                <div className="pt-2">
                  <label className="block text-sm font-bold text-gray-700 mb-2">Session ID</label>
                  <input
                    value={String(sessionId)}
                    onChange={(e) => setSessionId(Number(e.target.value) || 0)}
                    className="w-full px-4 py-3 rounded-xl bg-white border-2 border-gray-200 focus:outline-none focus:border-purple-400 focus:ring-4 focus:ring-purple-100 text-sm font-mono"
                  />
                </div>

                <div className="p-3 bg-blue-50 border-2 border-blue-200 rounded-xl">
                  <p className="text-xs font-semibold text-blue-800">
                    ℹ️ Prepare Codemaker auth entry, then any other connected wallet can import as Codebreaker.
                  </p>
                </div>
              </div>

              <div className="pt-5 border-t-2 border-gray-100 space-y-5">
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
            <div className="space-y-5">
              <div className="p-5 bg-gradient-to-br from-blue-50 to-cyan-50 border-2 border-blue-200 rounded-xl">
                <p className="text-sm font-semibold text-blue-800 mb-2">📥 Import Auth Entry from Codemaker</p>
                <p className="text-xs text-gray-700 mb-4">
                  Paste auth code and sign as the currently connected wallet (Codebreaker).
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
                  {parsedAuthInfo && (
                    <div className="p-3 rounded-xl bg-white border-2 border-blue-200 text-xs">
                      <p><span className="font-bold">Codemaker (fixed):</span> <span className="font-mono">{parsedAuthInfo.player1}</span></p>
                      <p><span className="font-bold">Session:</span> <span className="font-mono">{parsedAuthInfo.sessionId}</span></p>
                      <p><span className="font-bold">Codemaker points:</span> <span className="font-mono">{parsedAuthInfo.player1Points}</span></p>
                    </div>
                  )}
                  {authParseError && (
                    <p className="text-xs text-red-600 font-semibold">{authParseError}</p>
                  )}
                </div>
              </div>

              <button
                onClick={handleImportAndStart}
                disabled={loading || quickstartLoading || !importAuthCode.trim() || !!authParseError}
                className="w-full py-4 rounded-xl font-bold text-white text-lg bg-gradient-to-r from-blue-500 via-cyan-500 to-teal-500 hover:from-blue-600 hover:via-cyan-600 hover:to-teal-600 disabled:from-gray-200 disabled:to-gray-300 disabled:text-gray-500 transition-all shadow-xl hover:shadow-2xl transform hover:scale-105 disabled:transform-none"
              >
                {loading ? 'Importing & Signing...' : 'Import & Sign Auth Entry'}
              </button>
            </div>
          )}

          {authMode === 'load' && (
            <div className="space-y-5">
              <div className="p-5 bg-gradient-to-br from-green-50 to-emerald-50 border-2 border-green-200 rounded-xl">
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

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
        <div className="grid gap-4">
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
              <div className="p-4 rounded-xl border-2 border-gray-200 bg-white grid gap-3">
                <div className="grid sm:grid-cols-[120px_1fr] items-center gap-2">
                  <label className="text-xs font-bold text-gray-600">Session ID</label>
                  <input value={String(sessionId)} readOnly className="text-xs font-mono px-2 py-1 rounded border border-gray-300 bg-gray-50 max-w-[220px]" />
                </div>

                <div className="grid sm:grid-cols-[120px_1fr] items-start gap-2">
                  <label className="text-xs font-bold text-gray-600 pt-1">Color Legend</label>
                  <div className="grid sm:grid-cols-2 gap-2">
                    <div className="flex items-center gap-2 text-sm">{renderColorPeg(1, 'h-4 w-4')}<span>Red</span></div>
                    <div className="flex items-center gap-2 text-sm">{renderColorPeg(2, 'h-4 w-4')}<span>Blue</span></div>
                    <div className="flex items-center gap-2 text-sm">{renderColorPeg(3, 'h-4 w-4')}<span>Green</span></div>
                    <div className="flex items-center gap-2 text-sm">{renderColorPeg(4, 'h-4 w-4')}<span>Yellow</span></div>
                    <div className="flex items-center gap-2 text-sm">{renderColorPeg(5, 'h-4 w-4')}<span>Orange</span></div>
                    <div className="flex items-center gap-2 text-sm">{renderColorPeg(6, 'h-4 w-4')}<span>Purple</span></div>
                  </div>
                </div>

                <div className="grid sm:grid-cols-[120px_1fr] items-start gap-2">
                  <label className="text-xs font-bold text-gray-600 pt-1">Feedback</label>
                  <div className="grid sm:grid-cols-2 gap-2">
                    <div className="flex items-center gap-2 text-sm"><span className="h-4 w-4 rounded-full bg-black border border-black inline-block" /><span>Black Peg (exact)</span></div>
                    <div className="flex items-center gap-2 text-sm"><span className="h-4 w-4 rounded-full bg-white border border-gray-400 inline-block" /><span>White Peg (partial)</span></div>
                  </div>
                </div>
              </div>

              <div className="grid md:grid-cols-2 gap-4">
                {isPlayer1 && (
                  <div className="p-4 rounded-xl border-2 border-purple-200 bg-purple-50 grid gap-2">
                    <label className="text-sm font-semibold text-purple-900">Salt (0x + 32 hex chars)</label>
                    <input
                      value={saltInput}
                      onChange={(e) => setSaltInput(e.target.value)}
                      disabled={!!game?.commitment}
                      className="text-xs font-mono px-2 py-1 rounded border border-purple-300"
                    />
                    <label className="text-sm font-semibold text-purple-900">Codemaker Secret (click colors)</label>
                    <div className="flex gap-2 mb-2">
                      {secretDigits.map((d, idx) => (
                        <div key={`secret-selected-${idx}`}>{renderColorPeg(d, 'h-8 w-8')}</div>
                      ))}
                    </div>
                    {[0, 1, 2, 3].map((idx) => (
                      <div key={`secret-slot-${idx}`} className="grid grid-cols-[62px_1fr] items-center gap-2">
                        <span className="text-xs font-semibold text-purple-700">Slot {idx + 1}</span>
                        <div className="flex flex-wrap gap-1.5">
                          {[1, 2, 3, 4, 5, 6].map((value) => (
                            <button
                              key={`secret-${idx}-${value}`}
                              type="button"
                              disabled={!!game?.commitment}
                              onClick={() => setSecretDigits((prev) => setGuessDigitAt(prev, idx, value))}
                              className={`p-0.5 rounded-full border-2 ${secretDigits[idx] === value ? 'border-purple-700' : 'border-transparent'} disabled:opacity-50`}
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
                  <div className="p-4 rounded-xl border-2 border-blue-200 bg-blue-50 grid gap-2">
                    <label className="text-sm font-semibold text-blue-900">Codebreaker Guess (click colors)</label>
                    <div className="flex gap-2 mb-2">
                      {guessDigits.map((d, idx) => (
                        <div key={`guess-selected-${idx}`}>{renderColorPeg(d, 'h-8 w-8')}</div>
                      ))}
                    </div>
                    {[0, 1, 2, 3].map((idx) => (
                      <div key={`guess-slot-${idx}`} className="grid grid-cols-[62px_1fr] items-center gap-2">
                        <span className="text-xs font-semibold text-blue-700">Slot {idx + 1}</span>
                        <div className="flex flex-wrap gap-1.5">
                          {[1, 2, 3, 4, 5, 6].map((value) => (
                            <button
                              key={`guess-${idx}-${value}`}
                              type="button"
                              onClick={() => setGuessDigits((prev) => setGuessDigitAt(prev, idx, value))}
                              className={`p-0.5 rounded-full border-2 ${guessDigits[idx] === value ? 'border-blue-700' : 'border-transparent'}`}
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

              <div className="flex flex-wrap gap-2">
                <button disabled={loading || quickstartLoading || !canCommit} onClick={handleCommit}>1) commit_code (Codemaker)</button>
                <button disabled={loading || quickstartLoading || !canGuess} onClick={handleGuess}>2) submit_guess (Codebreaker)</button>
                <button disabled={loading || quickstartLoading || !canFeedback} onClick={handleFeedbackProof}>3) submit_feedback_proof (Codemaker+zk)</button>
              </div>

              {guessHistory.length > 0 && (
                <div className="p-4 bg-white border-2 border-gray-200 rounded-xl">
                  <p className="text-sm font-bold text-gray-800 mb-3">Mastermind Board</p>
                  <div className="grid gap-2">
                    {[...guessHistory].reverse().map((row) => {
                      const fbPegs = renderFeedbackPegs(row.exact, row.partial);
                      return (
                        <div key={row.guessId} className="grid grid-cols-[56px_1fr_84px] items-center gap-3 p-2 rounded border border-gray-100">
                          <div className="text-xs font-mono text-gray-600">#{row.guessId}</div>
                          <div className="flex gap-2">
                            {row.guessDigits
                              ? row.guessDigits.map((d, i) => <div key={`${row.guessId}-g-${i}`}>{renderColorPeg(d)}</div>)
                              : <span className="text-xs text-gray-500">{row.guess}</span>}
                          </div>
                          <div className="grid grid-cols-2 gap-1 justify-items-center">
                            {fbPegs.map((p, i) => (
                              <div
                                key={`${row.guessId}-fb-${i}`}
                                className={`h-3.5 w-3.5 rounded-full border ${
                                  p === 'black'
                                    ? 'bg-black border-black'
                                    : p === 'white'
                                      ? 'bg-white border-gray-400'
                                      : 'bg-gray-200 border-gray-200'
                                }`}
                                title={p === 'black' ? 'exact' : p === 'white' ? 'partial' : 'empty'}
                              />
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {latestFeedback && (
                    <p className="text-xs text-gray-600 mt-3">
                      Latest feedback: exact={String(latestFeedback.exact)}, partial={String(latestFeedback.partial)}
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

    </div>
  );
}
