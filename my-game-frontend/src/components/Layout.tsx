import { WalletStandalone } from './WalletStandalone';
import './Layout.css';

interface LayoutProps {
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
}

export function Layout({ title, subtitle, children }: LayoutProps) {
  const resolvedTitle = title || import.meta.env.VITE_GAME_TITLE || 'Stellar Game';
  const resolvedSubtitle = subtitle || import.meta.env.VITE_GAME_TAGLINE || 'Testnet dev sandbox';

  return (
    <div className="studio">
      <div className="studio-background" aria-hidden="true">
        <div className="studio-orb orb-1" />
        <div className="studio-orb orb-2" />
        <div className="studio-orb orb-3" />
        <div className="studio-grid" />
      </div>

      <header className="studio-header">
        <div className="brand">
          <div className="brand-title">{resolvedTitle}</div>
          <p className="brand-subtitle">{resolvedSubtitle}</p>
        </div>
        <div className="header-actions">
          <WalletStandalone />
        </div>
      </header>

      <main className="studio-main">{children}</main>

      <footer className="studio-footer">
        <span>Built with the Stellar Game Studio</span>
      </footer>
    </div>
  );
}
