import { useCallback, useEffect, useState } from 'react';
import { useWalletStore } from '../store/walletSlice';
import { NETWORK, NETWORK_PASSPHRASE } from '../utils/constants';
import type { ContractSigner } from '../types/signer';
import {
  standaloneWalletService,
  type StandaloneWalletAccount,
} from '../services/standaloneWalletService';

const WALLET_ID = 'local-standalone-wallet';

export function useWalletStandalone() {
  const {
    publicKey,
    walletId,
    walletType,
    isConnected,
    isConnecting,
    network,
    networkPassphrase,
    error,
    setWallet,
    setConnecting,
    setNetwork,
    setError,
    disconnect: storeDisconnect,
  } = useWalletStore();
  const [wallets, setWallets] = useState<StandaloneWalletAccount[]>([]);
  const [selectedWalletIndex, setSelectedWalletIndex] = useState<number | null>(null);

  const isWalletAvailable = typeof window !== 'undefined';

  const loadWalletState = useCallback(() => {
    if (typeof window === 'undefined') return;
    const state = standaloneWalletService.getWallets();
    setWallets(state.wallets);
    setSelectedWalletIndex(state.selectedIndex);
  }, []);

  const connect = useCallback(async (): Promise<{ created: boolean }> => {
    if (typeof window === 'undefined') {
      setError('Wallet connection is only available in the browser.');
      throw new Error('Wallet connection is only available in the browser.');
    }

    try {
      setConnecting(true);
      setError(null);

      const { wallets: localWallets, selectedIndex, created } = standaloneWalletService.ensureWallets();
      const selectedWallet = localWallets[selectedIndex];
      setWallets(localWallets);
      setSelectedWalletIndex(selectedIndex);
      setWallet(selectedWallet.publicKey, WALLET_ID, 'wallet');
      setNetwork(NETWORK, NETWORK_PASSPHRASE);
      return { created };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to connect wallet';
      setError(message);
      throw err;
    } finally {
      setConnecting(false);
    }
  }, [setWallet, setConnecting, setError, setNetwork]);

  const refresh = useCallback(async () => {
    if (typeof window === 'undefined') return;
    try {
      const { wallets: localWallets, selectedIndex } = standaloneWalletService.getWallets();
      const selectedWallet = localWallets[selectedIndex];
      setWallets(localWallets);
      setSelectedWalletIndex(selectedIndex);
      setWallet(selectedWallet.publicKey, WALLET_ID, 'wallet');
      setNetwork(NETWORK, NETWORK_PASSPHRASE);
    } catch {
      // ignore refresh failures
    }
  }, [setWallet, setNetwork]);

  const disconnect = useCallback(() => {
    storeDisconnect();
  }, [storeDisconnect]);

  const switchLocalWallet = useCallback(async (walletIndex: number) => {
    try {
      setConnecting(true);
      setError(null);
      const selectedWallet = standaloneWalletService.selectWallet(walletIndex);
      const { wallets: localWallets, selectedIndex } = standaloneWalletService.getWallets();
      setWallets(localWallets);
      setSelectedWalletIndex(selectedIndex);
      setWallet(selectedWallet.publicKey, WALLET_ID, 'wallet');
      setNetwork(NETWORK, NETWORK_PASSPHRASE);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to switch wallet';
      setError(message);
      throw err;
    } finally {
      setConnecting(false);
    }
  }, [setConnecting, setError, setWallet, setNetwork]);

  const fundWallet = useCallback(async (walletIndex: number) => {
    try {
      setError(null);
      const { wallets: localWallets } = standaloneWalletService.getWallets();
      const wallet = localWallets[walletIndex];
      if (!wallet) {
        throw new Error(`Wallet ${walletIndex + 1} not found`);
      }
      await standaloneWalletService.fundWithFriendbot(wallet.publicKey);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fund wallet';
      setError(message);
      throw err;
    }
  }, [setError]);

  const connectDev = useCallback(async (_playerNumber?: 1 | 2) => {
    if (typeof _playerNumber === 'number') {
      await switchLocalWallet(_playerNumber === 1 ? 0 : 1);
      return;
    }
    await connect();
  }, [connect, switchLocalWallet]);

  const switchPlayer = useCallback(async (playerNumber?: 1 | 2) => {
    if (typeof playerNumber !== 'number') {
      throw new Error('Player number is required');
    }
    await switchLocalWallet(playerNumber === 1 ? 0 : 1);
  }, [switchLocalWallet]);

  const isDevModeAvailable = useCallback(() => true, []);

  const isDevPlayerAvailable = useCallback((_playerNumber: 1 | 2) => {
    return wallets.length === 2;
  }, [wallets.length]);

  const getCurrentDevPlayer = useCallback(() => {
    if (selectedWalletIndex === null) return null;
    return selectedWalletIndex === 0 ? 1 : 2;
  }, [selectedWalletIndex]);

  const getContractSigner = useCallback((): ContractSigner => {
    if (!isConnected || !publicKey) {
      throw new Error('Wallet not connected');
    }

    const { wallets: localWallets, selectedIndex } = standaloneWalletService.getWallets();
    const selectedWallet = localWallets[selectedIndex];
    if (!selectedWallet) {
      throw new Error('No local wallet selected');
    }
    return standaloneWalletService.getSigner(selectedWallet.secret);
  }, [isConnected, publicKey]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const { wallets: localWallets, selectedIndex } = standaloneWalletService.getWallets();
      const selectedWallet = localWallets[selectedIndex];
      setWallets(localWallets);
      setSelectedWalletIndex(selectedIndex);
      setWallet(selectedWallet.publicKey, WALLET_ID, 'wallet');
      setNetwork(NETWORK, NETWORK_PASSPHRASE);
    } catch {
      loadWalletState();
    }
  }, [setWallet, setNetwork, loadWalletState]);

  return {
    // State
    publicKey,
    walletId,
    walletType,
    isConnected,
    isConnecting,
    network,
    networkPassphrase,
    error,
    isWalletAvailable,
    wallets,
    selectedWalletIndex,

    // Actions
    connect,
    refresh,
    disconnect,
    switchLocalWallet,
    fundWallet,
    getContractSigner,
    connectDev,
    switchPlayer,
    isDevModeAvailable,
    isDevPlayerAvailable,
    getCurrentDevPlayer,
  };
}
