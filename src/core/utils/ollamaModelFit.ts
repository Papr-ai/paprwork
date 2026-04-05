/**
 * RAM-aware Ollama model selection (Qwen, Gemma, etc.)
 * Shared by renderer (via IPC hint), gateway (Node os.totalmem), and docs/tests.
 *
 * Requirement values are minimum **total** system RAM (GB) per model tier, matching UI copy.
 */

export const QWEN_RAM_REQUIREMENTS: Record<string, number> = {
  "qwen3.5:0.8b": 4,
  "qwen3.5:2b": 8,
  "qwen3.5:4b": 12,
  "qwen3.5:4b-q4_k_m": 10, // Q4 optimized - lighter than full 4B
  "qwen3.5:latest": 16,
  "qwen3.5:9b-q4_k_m": 12, // Q4 optimized - 25% lighter than full 9B
  "qwen3.5:27b": 32,
};

export const QWEN_MODEL_SIZES: Record<string, number> = {
  "qwen3.5:0.8b": 1.0,
  "qwen3.5:2b": 2.7,
  "qwen3.5:4b": 3.4,
  "qwen3.5:4b-q4_k_m": 2.8, // Q4 optimized - ~18% smaller
  "qwen3.5:latest": 6.6,
  "qwen3.5:9b-q4_k_m": 5.0, // Q4 optimized - ~24% smaller
  "qwen3.5:27b": 17,
};

export const GEMMA_RAM_REQUIREMENTS: Record<string, number> = {
  "gemma3:270m": 2,
  "gemma3:1b": 4,
  "gemma3:4b": 10,
  "gemma3:4b-it-q4_k_m": 8, // Q4 optimized - verified from web search
  "gemma3:4b-it-qat": 9, // Quantization-aware trained - better quality
  "gemma3:latest": 10,
  "gemma3:12b": 16,
  "gemma3:12b-it-q4_k_m": 14, // Q4 optimized - ~12% lighter
  "gemma3:27b": 32,
};

export const GEMMA_MODEL_SIZES: Record<string, number> = {
  "gemma3:270m": 0.3,
  "gemma3:1b": 0.85,
  "gemma3:4b": 3.3,
  "gemma3:4b-it-q4_k_m": 3.3, // Verified from web search
  "gemma3:4b-it-qat": 4.0, // QAT variant - slightly larger
  "gemma3:latest": 3.3,
  "gemma3:12b": 8.1,
  "gemma3:12b-it-q4_k_m": 8.1, // Verified from web search
  "gemma3:27b": 17,
};

/** Prefer larger (more capable) models first; Q4 variants preferred for speed; first that fits RAM wins */
const QWEN_PREFERENCE_ORDER: readonly string[] = [
  "qwen3.5:27b",
  "qwen3.5:9b-q4_k_m", // Q4 optimized - prefer over full 9B
  "qwen3.5:latest",
  "qwen3.5:4b-q4_k_m", // Q4 optimized - prefer over full 4B
  "qwen3.5:4b",
  "qwen3.5:2b",
  "qwen3.5:0.8b",
];

const GEMMA_PREFERENCE_ORDER: readonly string[] = [
  "gemma3:27b",
  "gemma3:12b-it-q4_k_m", // Q4 optimized - prefer over full 12B
  "gemma3:12b",
  "gemma3:4b-it-qat", // QAT - better quality than Q4
  "gemma3:4b-it-q4_k_m", // Q4 optimized - prefer over full 4B
  "gemma3:latest",
  "gemma3:4b",
  "gemma3:1b",
  "gemma3:270m",
];

export function bytesToRamGbRounded(totalBytes: number): number {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return 0;
  return Math.round((totalBytes / 1024 ** 3) * 10) / 10;
}

export function pickFittingOllamaModelId(
  requirements: Record<string, number>,
  preferenceOrder: readonly string[],
  totalRamGb: number,
): string {
  for (const id of preferenceOrder) {
    const need = requirements[id];
    if (need !== undefined && need <= totalRamGb) return id;
  }
  for (let i = preferenceOrder.length - 1; i >= 0; i--) {
    const id = preferenceOrder[i];
    const need = requirements[id];
    if (need !== undefined) return id;
  }
  return preferenceOrder[0] ?? "qwen3.5:0.8b";
}

export function getRecommendedQwenModel(totalRamGb?: number): string {
  if (totalRamGb === undefined || !Number.isFinite(totalRamGb) || totalRamGb <= 0) {
    return "qwen3.5:latest";
  }
  return pickFittingOllamaModelId(QWEN_RAM_REQUIREMENTS, QWEN_PREFERENCE_ORDER, totalRamGb);
}

export function getRecommendedGemmaModel(totalRamGb?: number): string {
  if (totalRamGb === undefined || !Number.isFinite(totalRamGb) || totalRamGb <= 0) {
    return "gemma3:latest";
  }
  return pickFittingOllamaModelId(GEMMA_RAM_REQUIREMENTS, GEMMA_PREFERENCE_ORDER, totalRamGb);
}

export function getOllamaRamRequirementGb(modelId: string): number | undefined {
  return QWEN_RAM_REQUIREMENTS[modelId] ?? GEMMA_RAM_REQUIREMENTS[modelId];
}

export function ollamaModelFitsHostRam(modelId: string, totalRamGb: number): boolean {
  const need = getOllamaRamRequirementGb(modelId);
  if (need === undefined) return true;
  return need <= totalRamGb;
}
