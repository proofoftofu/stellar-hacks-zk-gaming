import { useState } from 'react';
import { config } from './config';
import { Layout } from './components/Layout';
import { useWallet } from './hooks/useWallet';
import { MyGameGame } from './games/my-game/MyGameGame';

const GAME_ID = 'my-game';
const GAME_TITLE = import.meta.env.VITE_GAME_TITLE || 'My Game';
const GAME_TAGLINE = import.meta.env.VITE_GAME_TAGLINE || 'On-chain game on Stellar';
const SETUP_GITHUB_URL = import.meta.env.VITE_SETUP_GITHUB_URL || 'https://github.com/proofoftofu/stellar-hacks-zk-gaming';

export default function App() {
  const { publicKey, isConnected, isConnecting, error, isDevModeAvailable } = useWallet();
  const [hideProdNotice, setHideProdNotice] = useState(false);
  const userAddress = publicKey ?? '';
  const contractId = config.contractIds[GAME_ID] || '';
  const hasContract = contractId && contractId !== 'YOUR_CONTRACT_ID';
  const devReady = isDevModeAvailable();
  const showProdNotice = import.meta.env.PROD && !hideProdNotice;

  return (
    <>
      {showProdNotice && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="max-w-xl w-full rounded-3xl bg-gradient-to-b from-white to-orange-50 border border-orange-200 shadow-[0_30px_80px_rgba(15,23,42,0.35)] p-7">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-orange-100 border border-orange-200 text-orange-700 text-xs font-bold uppercase tracking-wide">
              Localnet Notice
            </div>
            <h3 className="text-2xl font-black text-slate-900 mt-4">Local Setup Required</h3>
            <div className="mt-4 text-sm text-slate-700 space-y-3 leading-relaxed">
              <p className="font-semibold">This game requires Stellar Local to run.</p>
              <p>Frontend is deployed on Vercel, but gameplay does not work without local setup.</p>
              <p>
                Please see this GitHub for setup:{' '}
                <a className="text-blue-600 underline decoration-blue-300 underline-offset-2 break-all hover:text-blue-700" href={SETUP_GITHUB_URL} target="_blank" rel="noreferrer">
                  {SETUP_GITHUB_URL}
                </a>
              </p>
            </div>
            <div className="mt-6 flex justify-end">
              <button
                className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-orange-500 to-amber-500 text-white font-bold hover:from-orange-600 hover:to-amber-600 shadow-lg hover:shadow-xl transition-all"
                onClick={() => setHideProdNotice(true)}
              >
                I Understand
              </button>
            </div>
          </div>
        </div>
      )}
      <Layout title={GAME_TITLE} subtitle={GAME_TAGLINE}>
        {!hasContract ? (
          <div className="card">
            <h3 className="gradient-text">Contract Not Configured</h3>
            <p style={{ color: 'var(--color-ink-muted)', marginTop: '1rem' }}>
              Run <code>bun run setup:local</code> to deploy and configure localnet contract IDs, or set
              <code>VITE_MY_GAME_CONTRACT_ID</code> in the root <code>.env</code>.
            </p>
          </div>
        ) : !devReady ? (
          <div className="card">
            <h3 className="gradient-text">Dev Wallets Missing</h3>
            <p style={{ color: 'var(--color-ink-muted)', marginTop: '0.75rem' }}>
              Run <code>bun run setup:local</code> to generate dev wallets for Player 1 and Player 2.
            </p>
          </div>
        ) : !isConnected ? (
          <div className="card">
            <h3 className="gradient-text">Connecting Dev Wallet</h3>
            <p style={{ color: 'var(--color-ink-muted)', marginTop: '0.75rem' }}>
              The dev wallet switcher auto-connects Player 1. Use the switcher to toggle players.
            </p>
            {error && <div className="notice error" style={{ marginTop: '1rem' }}>{error}</div>}
            {isConnecting && <div className="notice info" style={{ marginTop: '1rem' }}>Connecting...</div>}
          </div>
        ) : (
          <MyGameGame
            userAddress={userAddress}
            currentEpoch={1}
            availablePoints={1000000000n}
            onStandingsRefresh={() => {}}
            onGameComplete={() => {}}
          />
        )}
      </Layout>
    </>
  );
}
