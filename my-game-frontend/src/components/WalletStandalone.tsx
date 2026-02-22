import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useWalletStandalone } from '../hooks/useWalletStandalone';
import { standaloneWalletService } from '../services/standaloneWalletService';
import './WalletStandalone.css';

export function WalletStandalone() {
  const {
    publicKey,
    isConnected,
    isConnecting,
    error,
    isWalletAvailable,
    connect,
    wallets,
    selectedWalletIndex,
    switchLocalWallet,
    fundWallet,
  } = useWalletStandalone();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isFundingIndex, setIsFundingIndex] = useState<number | null>(null);
  const [fundingMessage, setFundingMessage] = useState<string | null>(null);
  const [balances, setBalances] = useState<Record<string, string>>({});
  const [isLoadingBalances, setIsLoadingBalances] = useState(false);

  const address = typeof publicKey === 'string' ? publicKey : '';
  const shortAddress = address ? `${address.slice(0, 6)}...${address.slice(-4)}` : '';
  const selectedLabel = useMemo(() => {
    if (selectedWalletIndex === null || selectedWalletIndex < 0) return 'Wallet';
    return `Wallet ${selectedWalletIndex + 1}`;
  }, [selectedWalletIndex]);

  const openWalletModal = async () => {
    if (!isConnected) {
      try {
        await connect();
        setFundingMessage(null);
        setIsModalOpen(true);
      } catch {
        // handled by store error state
      }
      return;
    }
    setFundingMessage(null);
    setIsModalOpen(true);
  };

  const onSwitchAccount = async (index: number) => {
    try {
      await switchLocalWallet(index);
    } catch {
      // handled by store error state
    }
  };

  const onFund = async (index: number) => {
    try {
      setIsFundingIndex(index);
      setFundingMessage(null);
      await fundWallet(index);
      setFundingMessage(`Wallet ${index + 1} funded by Friendbot.`);
      await loadBalances();
    } catch {
      // handled by store error state
    } finally {
      setIsFundingIndex(null);
    }
  };

  const loadBalances = async () => {
    if (!wallets.length) return;
    setIsLoadingBalances(true);
    try {
      const entries = await Promise.all(
        wallets.map(async (wallet) => {
          const balance = await standaloneWalletService.getNativeBalance(wallet.publicKey);
          return [wallet.publicKey, balance ?? 'Unavailable'] as const;
        })
      );
      setBalances(Object.fromEntries(entries));
    } finally {
      setIsLoadingBalances(false);
    }
  };

  useEffect(() => {
    if (!isModalOpen) return;
    loadBalances().catch(() => undefined);
  }, [isModalOpen, wallets]);

  const canUseFaucet = (address: string): boolean => {
    const value = balances[address];
    if (!value || value === 'Unavailable') return true;
    const parsed = Number.parseFloat(value);
    if (Number.isNaN(parsed)) return true;
    return parsed < 100;
  };

  return (
    <div className="wallet-standalone">
      {!isConnected ? (
        <button
          className="wallet-standalone-button"
          onClick={() => openWalletModal().catch(() => undefined)}
          disabled={!isWalletAvailable || isConnecting}
        >
          {isConnecting ? 'Connecting...' : 'Connect Wallet'}
        </button>
      ) : (
        <div className="wallet-standalone-connected">
          <button className="wallet-standalone-button" onClick={() => setIsModalOpen(true)}>
            {selectedLabel}: {shortAddress}
          </button>
        </div>
      )}

      {!isWalletAvailable && (
        <div className="wallet-standalone-error">Wallet connection is only available in the browser.</div>
      )}
      {error && <div className="wallet-standalone-error">{error}</div>}

      {isModalOpen && typeof document !== 'undefined' && createPortal(
        <div className="wallet-modal-backdrop" onClick={() => setIsModalOpen(false)}>
          <div className="wallet-modal" onClick={(event) => event.stopPropagation()}>
            <div className="wallet-modal-header">
              <h3>Local Wallets</h3>
              <button className="wallet-modal-close" onClick={() => setIsModalOpen(false)}>
                Close
              </button>
            </div>

            <p className="wallet-modal-copy">
              These two local wallets are generated once and saved in browser local storage.
            </p>

            {wallets.map((wallet, index) => (
              <div key={wallet.publicKey} className="wallet-card">
                <div className="wallet-card-row">
                  <span className="wallet-card-title">Wallet {index + 1}</span>
                  {selectedWalletIndex === index ? (
                    <span className="wallet-chip active">Active</span>
                  ) : (
                    <span className="wallet-chip">Idle</span>
                  )}
                </div>

                <div className="wallet-field">
                  <span className="wallet-label">Address</span>
                  <code>{wallet.publicKey}</code>
                </div>

                <div className="wallet-field">
                  <span className="wallet-label">Balance (XLM)</span>
                  <code>{balances[wallet.publicKey] ?? (isLoadingBalances ? 'Loading...' : 'Unavailable')}</code>
                </div>

                <div className="wallet-actions">
                  <button
                    className="wallet-action-button"
                    onClick={() => onSwitchAccount(index).catch(() => undefined)}
                    disabled={selectedWalletIndex === index || isConnecting}
                  >
                    {selectedWalletIndex === index ? 'Selected' : 'Switch'}
                  </button>
                  <button
                    className="wallet-action-button secondary"
                    onClick={() => onFund(index).catch(() => undefined)}
                    disabled={isFundingIndex === index || !canUseFaucet(wallet.publicKey)}
                  >
                    {isFundingIndex === index ? 'Funding...' : 'Faucet (<100 XLM)'}
                  </button>
                </div>
              </div>
            ))}

            {fundingMessage && <div className="wallet-modal-success">{fundingMessage}</div>}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
