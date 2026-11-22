/**
 * Training opt-in — the one switch.
 *
 *   GET /api/training/consent   -> { available, signedIn, optedIn, asked, version }
 *   PUT /api/training/consent   { optedIn } -> same shape
 *
 * The choice is stored on the Papr account (memory: /v1/training/consent) so
 * every device, cloud agent and job reads the same answer. `asked` is local:
 * whether this install already showed the one-time prompt.
 *
 * Development-only: outside the dev profile GET reports available:false (the UI
 * hides the switch and the prompt) and PUT refuses, so production never asks.
 */
import type { Express } from "express";
import { promises as fs } from "fs";
import path from "path";
import {
  isTrainingAvailable,
  setTrainingOptInCache,
  TRAINING_CONSENT_VERSION,
} from "../services/storage/trainingSync.js";

interface ConsentState {
  available: boolean;
  signedIn: boolean;
  optedIn: boolean;
  asked: boolean;
  version: string;
}

export interface TrainingConsentDeps {
  /** Papr REST client, or null when signed out. */
  getClient: () => Promise<{
    get: (p: string, o?: { timeout?: number }) => PromiseLike<unknown>;
    put: (p: string, o: { body: unknown; timeout?: number }) => PromiseLike<unknown>;
  } | null>;
  /** File that remembers the prompt was shown on this install. */
  askedFile: () => string;
}

async function wasAsked(file: string): Promise<boolean> {
  try {
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as { version?: string };
    return raw.version === TRAINING_CONSENT_VERSION;
  } catch {
    return false;
  }
}

async function markAsked(file: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ version: TRAINING_CONSENT_VERSION, at: new Date().toISOString() }));
}

export function registerTrainingConsentRoutes(app: Express, deps: TrainingConsentDeps): void {
  app.get("/api/training/consent", async (_req, res) => {
    if (!isTrainingAvailable()) {
      res.json({ available: false, signedIn: false, optedIn: false, asked: true, version: TRAINING_CONSENT_VERSION } satisfies ConsentState);
      return;
    }
    const asked = await wasAsked(deps.askedFile());
    const client = await deps.getClient().catch(() => null);
    if (!client) {
      res.json({ available: true, signedIn: false, optedIn: false, asked, version: TRAINING_CONSENT_VERSION } satisfies ConsentState);
      return;
    }
    try {
      const r = (await client.get("/v1/training/consent", { timeout: 8_000 })) as { opted_in?: boolean; version?: string };
      const optedIn = r?.opted_in === true;
      setTrainingOptInCache(optedIn);
      // A choice made under older wording counts as not asked, so the prompt re-appears.
      const current = !r?.version || r.version === TRAINING_CONSENT_VERSION;
      res.json({ available: true, signedIn: true, optedIn, asked: asked && current, version: TRAINING_CONSENT_VERSION } satisfies ConsentState);
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  app.put("/api/training/consent", async (req, res) => {
    if (!isTrainingAvailable()) {
      res.status(404).json({ error: "Training opt-in is not available in this build" });
      return;
    }
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
      await client.put("/v1/training/consent", {
        body: { opted_in: optedIn, version: TRAINING_CONSENT_VERSION },
        timeout: 8_000,
      });
      setTrainingOptInCache(optedIn);
      await markAsked(deps.askedFile());
      res.json({ available: true, signedIn: true, optedIn, asked: true, version: TRAINING_CONSENT_VERSION } satisfies ConsentState);
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });
}
