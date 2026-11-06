/**
 * Live-mode graph writes for papr.entities: one memory per observation, written
 * against the installed schema pack so the memory server's node constraints
 * (exact email / domain first) do the identity resolution in the graph.
 */
import type { EntityKeys, EntityType } from "./entitiesCore.js";
import type { GraphPort, ObserveInput } from "./entitiesStore.js";

export interface MemoryAddLike {
  add(body: Record<string, unknown>): Promise<{ memoryId: string | null }>;
}

const LINK_KEYS: Partial<Record<EntityType, Array<[string, string]>>> = {
  // entity key -> schema property used by the pack's constraint
  Person: [["email", "email"], ["linkedin", "linkedin"]],
  Company: [["domain", "domain"]],
  Introduction: [["intro_key", "intro_key"]],
  Commitment: [["commitment_key", "commitment_key"]],
};

/** link_to entries that pin extraction to the exact entities (no LLM guessing on identity). */
export function linkToFor(entities: Array<{ type: EntityType; keys: EntityKeys }>): Record<string, Record<string, never>> {
  const out: Record<string, Record<string, never>> = {};
  for (const e of entities) {
    for (const [key, prop] of LINK_KEYS[e.type] ?? []) {
      const v = e.keys[key];
      if (v && !/[,~=]/.test(v)) {
        out[`${e.type}:${prop}=${v}`] = {};
        break;
      }
    }
  }
  return out;
}

export function buildObserveMemory(
  input: ObserveInput & { entities: Array<{ type: EntityType; entityId: string; keys: EntityKeys }> },
  ctx: { appId: string; pack: string; schemaId: string | null },
): Record<string, unknown> {
  const lines: string[] = [];
  if (input.text) lines.push(input.text.trim());
  if (input.facts && Object.keys(input.facts).length) {
    lines.push("Facts: " + Object.entries(input.facts).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join("; "));
  }
  const about = input.entities.map((e) => `${e.type} ${Object.values(e.keys)[0] ?? e.entityId}`).join(", ");
  if (about) lines.push(`About: ${about}`);
  const linkTo = linkToFor(input.entities);
  return {
    content: lines.join("\n"),
    type: "text",
    metadata: {
      customMetadata: {
        content_type: "papr_entity_observation",
        papr_app_id: ctx.appId,
        papr_pack: ctx.pack,
        papr_entity_ids: input.entities.map((e) => e.entityId).join(","),
        ...(input.source?.table ? { papr_source_table: input.source.table } : {}),
        ...(input.source?.row ? { papr_source_row: String(input.source.row) } : {}),
      },
    },
    memory_policy: {
      mode: "auto",
      ...(ctx.schemaId ? { schema_id: ctx.schemaId } : {}),
    },
    ...(Object.keys(linkTo).length ? { link_to: linkTo } : {}),
  };
}

export function memoryGraphPort(memory: MemoryAddLike, ctx: { appId: string; pack: string; schemaId: string | null }): GraphPort {
  return {
    async observe(input) {
      return memory.add(buildObserveMemory(input, ctx));
    },
  };
}
