/**
 * Internal training beta — feature-flagged OFF.
 *
 * Papr does not train on user data. This switch only exists for accounts the
 * memory server puts on its internal allowlist (TRAINING_PROGRAM_ALLOWLIST,
 * e.g. Papr employees who agree to it). Everyone else gets `available: false`,
 * sees nothing in the UI, and cannot opt in. Allowlisted users still start off
 * and must turn it on themselves in Settings. There is no popup.
 *
 *   GET /api/training/consent   -> { signedIn, available, optedIn, version }
 *   PUT /api/training/consent   { optedIn } -> same shape (403 unless available)
 */
import type { Express } from "express";
import {
  setTrainingOptInCache,
  TRAINING_CONSENT_VERSION,
} from "../services/storage/trainingSync.js";

interface ConsentState {
  signedIn: boolean;
  available: boolean;
  optedIn: boolean;
  version: string;
}

export interface TrainingConsentDeps {
  /** Papr REST client, or null when signed out. */
  getClient: () => Promise<{
    get: (p: string, o?: { timeout?: number }) => PromiseLike<unknown>;
    put: (p: string, o: { body: unknown; timeout?: number }) => PromiseLike<unknown>;
  } | null>;
}

const OFF = (signedIn: boolean): ConsentState => ({
  signedIn,
  available: false,
  optedIn: false,
  version: TRAINING_CONSENT_VERSION,
});

type ServerConsent = { opted_in?: boolean; available?: boolean };

async function readServer(deps: TrainingConsentDeps): Promise<{ signedIn: boolean; r: ServerConsent | null }> {
  const client = await deps.getClient().catch(() => null);
  if (!client) return { signedIn: false, r: null };
  const r = (await client.get("/v1/training/consent", { timeout: 8_000 })) as ServerConsent;
  return { signedIn: true, r };
}

export function registerTrainingConsentRoutes(app: Express, deps: TrainingConsentDeps): void {
  app.get("/api/training/consent", async (_req, res) => {
    try {
      const { signedIn, r } = await readServer(deps);
      // Fail closed: no `available: true` from the server means the program does not exist for this user.
      if (!r || r.available !== true) {
        setTrainingOptInCache(false);
        res.json(OFF(signedIn));
        return;
      }
      const optedIn = r.opted_in === true;
      setTrainingOptInCache(optedIn);
      res.json({ signedIn, available: true, optedIn, version: TRAINING_CONSENT_VERSION } satisfies ConsentState);
    } catch {
      res.json(OFF(true));
    }
  });

  app.put("/api/training/consent", async (req, res) => {
    const optedIn = (req.body as { optedIn?: unknown } | undefined)?.optedIn;
    if (typeof optedIn !== "boolean") {
      res.status(400).json({ error: "optedIn must be a boolean" });
      return;
    }
    const client = await deps.getClient().catch(() => null);
    if (!client) {
      res.status(401).json({ error: "Sign in to Papr to change this setting" });
      return;
    }
    try {
      const cur = (await client.get("/v1/training/consent", { timeout: 8_000 })) as ServerConsent;
      if (cur?.available !== true) {
        res.status(403).json({ error: "The training program is not available for this account" });
        return;
      }
      await client.put("/v1/training/consent", {
        body: { opted_in: optedIn, version: TRAINING_CONSENT_VERSION },
        timeout: 8_000,
      });
      setTrainingOptInCache(optedIn);
      res.json({ signedIn: true, available: true, optedIn, version: TRAINING_CONSENT_VERSION } satisfies ConsentState);
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });
}
