/**
 * Provider Auth Store - remembers that a provider rejected our credentials.
 *
 * A 401 surfaces during a chat turn, but the place a user goes to fix it is
 * Settings, in a different component tree. Both run in the renderer, so the
 * rejection only needed recording rather than a round trip: the AI Models card
 * reads this to say "reconnect" instead of showing a countdown that reflects a
 * stored expiry the provider has already stopped honouring.
 *
 * Deliberately not persisted. It records a rejection we actually observed, so
 * on restart we hold no evidence and should not imply we do.
 */

import { create } from "zustand";
import type { Provider } from "../../src/core/types/agents";

export interface ProviderAuthRejection {
  message: string;
  /** Epoch ms of the rejection. */
  at: number;
}

interface ProviderAuthState {
  rejections: Partial<Record<Provider, ProviderAuthRejection>>;
  recordRejection: (provider: Provider, message: string) => void;
  clearRejection: (provider: Provider) => void;
}

export const useProviderAuthStore = create<ProviderAuthState>((set) => ({
  rejections: {},

  recordRejection: (provider, message) =>
    set((state) => ({
      rejections: {
        ...state.rejections,
        [provider]: { message, at: Date.now() },
      },
    })),

  clearRejection: (provider) =>
    set((state) => {
      if (!state.rejections[provider]) return state;
      const rejections = { ...state.rejections };
      delete rejections[provider];
      return { rejections };
    }),
}));
