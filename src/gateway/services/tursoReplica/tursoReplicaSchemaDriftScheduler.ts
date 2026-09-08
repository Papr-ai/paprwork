/**
 * Background schema drift healing — keeps registry migrations off interactive read paths.
 */

import * as path from "path";
import type { AppDataSource } from "../appDataSources.js";
import { healReplicaSchemaDrift } from "./tursoReplicaSchemaDriftHeal.js";

const HEAL_COOLDOWN_MS = 30_000;

function normalizeKey(dbPath: string): string {
  return path.normalize(dbPath);
}

const healInFlight = new Map<string, Promise<void>>();
const lastHealScheduledMs = new Map<string, number>();

export function scheduleReplicaSchemaDriftHeal(source: AppDataSource): void {
  const dbPath = source.dbPath?.trim();
  if (!dbPath) {
    return;
  }
  const key = normalizeKey(dbPath);
  if (healInFlight.has(key)) {
    return;
  }
  const lastScheduled = lastHealScheduledMs.get(key) ?? 0;
  if (Date.now() - lastScheduled < HEAL_COOLDOWN_MS) {
    return;
  }
  lastHealScheduledMs.set(key, Date.now());

  const label = source.alias ?? source.dbId ?? dbPath;
  const job = runBackgroundSchemaHeal(source, label).finally(() => {
    healInFlight.delete(key);
  });
  healInFlight.set(key, job);
  void job;
}

async function runBackgroundSchemaHeal(
  source: AppDataSource,
  label: string,
): Promise<void> {
  console.log(
    `[TursoReplicaSchema] Background schema heal started for ${label}`,
  );
  try {
    await healReplicaSchemaDrift(source);
    console.log(
      `[TursoReplicaSchema] Background schema heal finished for ${label}`,
    );
  } catch (error) {
    console.warn(
      `[TursoReplicaSchema] Background schema heal failed for ${label}:`,
      (error as Error).message.slice(0, 160),
    );
  }
}

export function resetReplicaSchemaDriftSchedulerForTests(): void {
  healInFlight.clear();
  lastHealScheduledMs.clear();
}
