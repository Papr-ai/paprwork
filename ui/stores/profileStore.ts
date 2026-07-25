/**
 * Profile Store - User profile data available across the app
 */

import { create } from "zustand";
import { gateway } from "../src/lib/gateway";

interface ProfileState {
  name: string;
  email: string;
  imageUrl: string;
  plan: string;
  loaded: boolean;
  loadProfile: () => Promise<void>;
  setProfile: (profile: {
    name?: string;
    email?: string;
    imageUrl?: string;
    plan?: string;
  }) => void;
}

export const useProfileStore = create<ProfileState>((set, get) => ({
  name: "",
  email: "",
  imageUrl: "",
  plan: "Free plan",
  loaded: false,

  loadProfile: async () => {
    if (get().loaded) return;
    try {
      const response = await gateway.send("settings:get");
      const data = response.data as {
        profile?: {
          name?: string;
          email?: string;
          imageUrl?: string;
          plan?: string;
        };
        subscription?: { plan?: string; name?: string };
      };
      if (data?.profile) {
        set({
          name: data.profile.name ?? "",
          email: data.profile.email ?? "",
          imageUrl: data.profile.imageUrl ?? "",
          plan:
            data.profile.plan ??
            data.subscription?.plan ??
            data.subscription?.name ??
            "Free plan",
          loaded: true,
        });
      } else {
        set({ loaded: true });
      }
    } catch (err) {
      console.error("[ProfileStore] Load error:", err);
      set({ loaded: true });
    }
  },

  setProfile: (profile) => {
    set({
      name: profile.name ?? get().name,
      email: profile.email ?? get().email,
      imageUrl: profile.imageUrl ?? get().imageUrl,
      plan: profile.plan ?? get().plan,
    });
  },
}));
