import { config } from './config';
import { Layout } from './components/Layout';
import { MyGameGame } from './games/my-game/MyGameGame';

const GAME_ID = 'my-game';
const GAME_TITLE = import.meta.env.VITE_GAME_TITLE || 'My Game';
const GAME_TAGLINE = import.meta.env.VITE_GAME_TAGLINE || 'On-chain game on Stellar';

export default function App() {
  const contractId = config.contractIds[GAME_ID] || '';
  const hasContract = contractId && contractId !== 'YOUR_CONTRACT_ID';

  return (
    <Layout title={GAME_TITLE} subtitle={GAME_TAGLINE}>
      {!hasContract ? (
        <div className="card">
          <h3 className="gradient-text">Contract Not Configured</h3>
          <p style={{ color: 'var(--color-ink-muted)', marginTop: '1rem' }}>
            Run <code>bun run setup:local</code> to deploy and configure localnet contract IDs, or set
            <code>VITE_MY_GAME_CONTRACT_ID</code> in the root <code>.env</code>.
          </p>
        </div>
      ) : (
        <MyGameGame
          userAddress=""
          currentEpoch={1}
          availablePoints={1000000000n}
          onStandingsRefresh={() => {}}
          onGameComplete={() => {}}
        />
      )}
    </Layout>
  );
}
