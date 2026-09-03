/**
 * User- and agent-registered platform connections (any login-required site).
 * Stored at $PAPR_HOME/data/platform-connections.json alongside built-in social platforms.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { getPaprDataDir } from "../../../core/utils/paprRoot.js";
import {
  PLATFORM_REGISTRY,
  type PlatformConfig,
  type BuiltinPlatformId,
  type PlatformRateLimits,
} from "./platformRegistry.js";

export type CustomPlatformRegisteredBy = "user" | "agent";

export interface CustomPlatformConnectionRecord {
  id: string;
  name: string;
  homeUrl: string;
  loginUrl: string;
  cookieDomain: string;
  originHost: string;
  registeredBy: CustomPlatformRegisteredBy;
  registeredAt: string;
  notes?: string;
}

interface PlatformConnectionsStore {
  version: 1;
  connections: CustomPlatformConnectionRecord[];
}

const STORE_VERSION = 1 as const;
const STORE_FILENAME = "platform-connections.json";

const DEFAULT_CUSTOM_RATE_LIMITS: PlatformRateLimits = {
  dailyViews: 200,
  dailyMessages: 50,
  dailyConnections: 20,
  dailyPosts: 10,
  hourlyActions: 40,
  minActionDelayMs: 2000,
  maxActionDelayMs: 6000,
  notes:
    "Custom site — use conservative pacing. Respect the site's terms of service.",
};

let storeCache: PlatformConnectionsStore | null = null;

function getStorePath(): string {
  return join(getPaprDataDir(), STORE_FILENAME);
}

function emptyStore(): PlatformConnectionsStore {
  return { version: STORE_VERSION, connections: [] };
}

async function loadStore(): Promise<PlatformConnectionsStore> {
  if (storeCache) {
    return storeCache;
  }

  try {
    const raw = await fs.readFile(getStorePath(), "utf-8");
    const parsed = JSON.parse(raw) as PlatformConnectionsStore;
    if (parsed.version === STORE_VERSION && Array.isArray(parsed.connections)) {
      storeCache = parsed;
      return parsed;
    }
  } catch {
    /* missing or invalid — start fresh */
  }

  storeCache = emptyStore();
  return storeCache;
}

async function saveStore(store: PlatformConnectionsStore): Promise<void> {
  storeCache = store;
  await fs.mkdir(getPaprDataDir(), { recursive: true });
  await fs.writeFile(getStorePath(), JSON.stringify(store, null, 2), "utf-8");
}

export function invalidateCustomPlatformConnectionsCache(): void {
  storeCache = null;
}

function registrableCookieDomain(hostname: string): string {
  const host = hostname.replace(/^www\./, "");
  const parts = host.split(".");
  if (parts.length >= 2) {
    return `.${parts.slice(-2).join(".")}`;
  }
  return `.${host}`;
}

function slugifyPlatformId(hostname: string): string {
  return `site-${hostname.replace(/^www\./, "").replace(/\./g, "-")}`;
}

export function parsePlatformConnectionUrl(
  input: string,
  displayName?: string,
): Omit<CustomPlatformConnectionRecord, "registeredBy" | "registeredAt"> {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("URL is required");
  }

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`Invalid URL: ${input}`);
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Only http(s) URLs are supported");
  }

  const originHost = parsed.hostname.replace(/^www\./, "");
  const id = slugifyPlatformId(parsed.hostname);
  const name = displayName?.trim() || originHost;
  const homeUrl = parsed.href;
  const loginUrl = `${parsed.origin}/`;
  const cookieDomain = registrableCookieDomain(parsed.hostname);

  return {
    id,
    name,
    homeUrl,
    loginUrl,
    cookieDomain,
    originHost,
  };
}

export function customRecordToPlatformConfig(
  record: CustomPlatformConnectionRecord,
): PlatformConfig {
  const escapedHost = record.originHost.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  return {
    id: record.id,
    name: record.name,
    loginUrl: record.loginUrl,
    homeUrl: record.homeUrl,
    successUrlPattern: new RegExp(escapedHost, "i"),
    requiredCookies: [],
    keyPrefix: record.id.toUpperCase().replace(/-/g, "_"),
    refreshIntervalMs: 15 * 60 * 1000,
    sessionDurationDays: 30,
    cookieDomain: record.cookieDomain,
    rotatesTokens: false,
    notes:
      record.notes ??
      `Custom connection to ${record.homeUrl}. Registered by ${record.registeredBy}.`,
    rateLimits: DEFAULT_CUSTOM_RATE_LIMITS,
    isCustom: true,
    originHost: record.originHost,
    registeredBy: record.registeredBy,
    registeredAt: record.registeredAt,
  };
}

export function isBuiltinPlatformId(platformId: string): platformId is BuiltinPlatformId {
  return platformId in PLATFORM_REGISTRY;
}

export async function listCustomPlatformConnections(): Promise<
  CustomPlatformConnectionRecord[]
> {
  const store = await loadStore();
  return [...store.connections];
}

export async function getCustomPlatformConnection(
  platformId: string,
): Promise<CustomPlatformConnectionRecord | undefined> {
  const store = await loadStore();
  return store.connections.find((entry) => entry.id === platformId);
}

export async function registerCustomPlatformConnection(input: {
  url: string;
  name?: string;
  registeredBy: CustomPlatformRegisteredBy;
  notes?: string;
}): Promise<CustomPlatformConnectionRecord> {
  const parsed = parsePlatformConnectionUrl(input.url, input.name);

  const builtinForHost = getBuiltinPlatformIdForHost(parsed.originHost);
  if (builtinForHost) {
    throw new Error(
      `${parsed.name} is already available as built-in platform "${builtinForHost}". Use connect_platform with that platform instead.`,
    );
  }

  const store = await loadStore();
  const existingIndex = store.connections.findIndex((entry) => entry.id === parsed.id);
  const record: CustomPlatformConnectionRecord = {
    ...parsed,
    registeredBy: input.registeredBy,
    registeredAt: new Date().toISOString(),
    notes: input.notes,
  };

  if (existingIndex >= 0) {
    store.connections[existingIndex] = {
      ...store.connections[existingIndex],
      ...record,
      registeredAt: store.connections[existingIndex].registeredAt,
    };
  } else {
    store.connections.push(record);
  }

  await saveStore(store);
  return existingIndex >= 0 ? store.connections[existingIndex] : record;
}

function getBuiltinPlatformIdForHost(originHost: string): BuiltinPlatformId | undefined {
  for (const [id, config] of Object.entries(PLATFORM_REGISTRY)) {
    try {
      const host = new URL(config.homeUrl).hostname.replace(/^www\./, "");
      if (host === originHost || originHost.endsWith(`.${host}`)) {
        return id as BuiltinPlatformId;
      }
    } catch {
      /* skip malformed built-in URL */
    }
  }
  return undefined;
}

export async function unregisterCustomPlatformConnection(
  platformId: string,
): Promise<boolean> {
  if (isBuiltinPlatformId(platformId)) {
    throw new Error("Built-in platforms cannot be unregistered");
  }

  const store = await loadStore();
  const next = store.connections.filter((entry) => entry.id !== platformId);
  if (next.length === store.connections.length) {
    return false;
  }

  store.connections = next;
  await saveStore(store);
  return true;
}

export async function getAllRegisteredPlatformIds(): Promise<string[]> {
  const custom = await listCustomPlatformConnections();
  const builtin = Object.keys(PLATFORM_REGISTRY);
  const customIds = custom.map((entry) => entry.id);
  return [...builtin, ...customIds.filter((id) => !(id in PLATFORM_REGISTRY))];
}
