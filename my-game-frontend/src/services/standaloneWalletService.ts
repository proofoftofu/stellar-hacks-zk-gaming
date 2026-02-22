import { Buffer } from 'buffer';
import { Keypair, TransactionBuilder, hash } from '@stellar/stellar-sdk';
import type { WalletError } from '@stellar/stellar-sdk/contract';
import type { ContractSigner } from '../types/signer';

const STORAGE_KEY = 'sgs:standalone-wallets:v1';
const WALLET_COUNT = 2;
const HORIZON_URL = import.meta.env.VITE_HORIZON_URL || 'https://horizon-testnet.stellar.org';

export interface StandaloneWalletAccount {
  publicKey: string;
  secret: string;
}

interface StandaloneWalletState {
  selectedIndex: number;
  wallets: StandaloneWalletAccount[];
}

function toWalletError(message: string): WalletError {
  return { message, code: -1 };
}

function normalizeState(raw: unknown): StandaloneWalletState | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<StandaloneWalletState>;
  if (!Array.isArray(candidate.wallets) || candidate.wallets.length !== WALLET_COUNT) return null;
  if (typeof candidate.selectedIndex !== 'number') return null;

  const wallets = candidate.wallets.filter(
    (wallet): wallet is StandaloneWalletAccount =>
      !!wallet &&
      typeof wallet.publicKey === 'string' &&
      typeof wallet.secret === 'string' &&
      wallet.publicKey.length > 0 &&
      wallet.secret.length > 0
  );

  if (wallets.length !== WALLET_COUNT) return null;
  if (candidate.selectedIndex < 0 || candidate.selectedIndex >= WALLET_COUNT) return null;

  return {
    wallets,
    selectedIndex: candidate.selectedIndex,
  };
}

function createState(): StandaloneWalletState {
  const wallets: StandaloneWalletAccount[] = Array.from({ length: WALLET_COUNT }, () => {
    const keypair = Keypair.random();
    return {
      publicKey: keypair.publicKey(),
      secret: keypair.secret(),
    };
  });

  return {
    wallets,
    selectedIndex: 0,
  };
}

export class StandaloneWalletService {
  private state: StandaloneWalletState | null = null;

  private canUseStorage(): boolean {
    return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
  }

  private save(): void {
    if (!this.state || !this.canUseStorage()) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
  }

  private load(): StandaloneWalletState | null {
    if (!this.canUseStorage()) return null;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    try {
      return normalizeState(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  ensureWallets(): { wallets: StandaloneWalletAccount[]; selectedIndex: number; created: boolean } {
    if (this.state) {
      return { wallets: this.state.wallets, selectedIndex: this.state.selectedIndex, created: false };
    }

    const loaded = this.load();
    if (loaded) {
      this.state = loaded;
      return { wallets: loaded.wallets, selectedIndex: loaded.selectedIndex, created: false };
    }

    const created = createState();
    this.state = created;
    this.save();
    return { wallets: created.wallets, selectedIndex: created.selectedIndex, created: true };
  }

  getWallets(): { wallets: StandaloneWalletAccount[]; selectedIndex: number } {
    const { wallets, selectedIndex } = this.ensureWallets();
    return { wallets, selectedIndex };
  }

  selectWallet(index: number): StandaloneWalletAccount {
    const { wallets } = this.ensureWallets();
    if (index < 0 || index >= wallets.length) {
      throw new Error(`Invalid wallet index: ${index}`);
    }

    if (!this.state) {
      throw new Error('Wallet state not initialized');
    }

    this.state.selectedIndex = index;
    this.save();
    return wallets[index];
  }

  getSelectedWallet(): StandaloneWalletAccount {
    const { wallets, selectedIndex } = this.ensureWallets();
    return wallets[selectedIndex];
  }

  async fundWithFriendbot(address: string): Promise<void> {
    const url = `https://friendbot.stellar.org?addr=${encodeURIComponent(address)}`;
    const response = await fetch(url, { method: 'GET' });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Friendbot request failed (${response.status})`);
    }
  }

  async getNativeBalance(address: string): Promise<string | null> {
    try {
      const response = await fetch(`${HORIZON_URL}/accounts/${encodeURIComponent(address)}`, { method: 'GET' });
      if (!response.ok) return null;
      const data = await response.json() as { balances?: Array<{ asset_type?: string; balance?: string }> };
      const native = data.balances?.find((item) => item.asset_type === 'native');
      return native?.balance ?? null;
    } catch {
      return null;
    }
  }

  getSigner(secret: string): ContractSigner {
    const keypair = Keypair.fromSecret(secret);
    const publicKey = keypair.publicKey();

    return {
      signTransaction: async (txXdr: string, opts?: any) => {
        try {
          if (!opts?.networkPassphrase) {
            throw new Error('Missing networkPassphrase');
          }

          const transaction = TransactionBuilder.fromXDR(txXdr, opts.networkPassphrase);
          transaction.sign(keypair);
          return {
            signedTxXdr: transaction.toXDR(),
            signerAddress: publicKey,
          };
        } catch (error) {
          return {
            signedTxXdr: txXdr,
            signerAddress: publicKey,
            error: toWalletError(error instanceof Error ? error.message : 'Failed to sign transaction'),
          };
        }
      },

      signAuthEntry: async (preimageXdr: string) => {
        try {
          const preimageBytes = Buffer.from(preimageXdr, 'base64');
          const payload = hash(preimageBytes);
          const signatureBytes = keypair.sign(payload);

          return {
            signedAuthEntry: Buffer.from(signatureBytes).toString('base64'),
            signerAddress: publicKey,
          };
        } catch (error) {
          return {
            signedAuthEntry: preimageXdr,
            signerAddress: publicKey,
            error: toWalletError(error instanceof Error ? error.message : 'Failed to sign auth entry'),
          };
        }
      },
    };
  }
}

export const standaloneWalletService = new StandaloneWalletService();
