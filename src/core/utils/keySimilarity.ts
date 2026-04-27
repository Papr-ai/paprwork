/**
 * Key Name Similarity Matching
 *
 * Finds similar key names to suggest existing keys users might want to use
 * instead of creating duplicates with slightly different names.
 */

export interface SimilarKey {
  name: string;
  score: number; // 0-1, higher is more similar
  reason: string;
}

/**
 * Calculate Levenshtein distance between two strings (edit distance)
 */
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Normalize key name for comparison - lowercase, remove underscores
 */
function normalizeKeyName(name: string): string {
  return name.toLowerCase().replace(/_/g, "");
}

/**
 * Extract the "base" service name from a key (e.g., "VERCEL" from "VERCEL_API_KEY")
 */
function extractServiceName(keyName: string): string {
  // Common suffixes to strip
  const suffixes = [
    "_API_KEY",
    "_SECRET_KEY",
    "_ACCESS_KEY",
    "_SECRET",
    "_TOKEN",
    "_KEY",
    "_APIKEY",
    "_AUTH",
  ];

  let base = keyName.toUpperCase();
  for (const suffix of suffixes) {
    if (base.endsWith(suffix)) {
      base = base.slice(0, -suffix.length);
      break;
    }
  }

  return base;
}

/**
 * Find similar key names from a list of existing keys
 *
 * @param requestedKey - The key name the app is requesting (e.g., "VERCEL_API_KEY")
 * @param existingKeys - Array of key names the user already has configured
 * @param threshold - Minimum similarity score (0-1) to include in results. Default 0.6
 * @returns Array of similar keys sorted by score (highest first)
 */
export function findSimilarKeys(
  requestedKey: string,
  existingKeys: string[],
  threshold = 0.6
): SimilarKey[] {
  const results: SimilarKey[] = [];

  const requestedNorm = normalizeKeyName(requestedKey);
  const requestedService = extractServiceName(requestedKey);

  for (const existingKey of existingKeys) {
    const existingNorm = normalizeKeyName(existingKey);
    const existingService = extractServiceName(existingKey);

    // 1. Exact match (already handled by caller, but include for completeness)
    if (requestedKey === existingKey) {
      results.push({
        name: existingKey,
        score: 1.0,
        reason: "Exact match",
      });
      continue;
    }

    // 2. Same service name (e.g., VERCEL_KEY vs VERCEL_API_KEY)
    if (requestedService === existingService && requestedService.length > 2) {
      const score = 0.9; // High score for same service
      results.push({
        name: existingKey,
        score,
        reason: `Same service: ${requestedService}`,
      });
      continue;
    }

    // 3. Normalized match (e.g., VERCEL_APIKEY vs VERCEL_API_KEY)
    if (requestedNorm === existingNorm) {
      results.push({
        name: existingKey,
        score: 0.95,
        reason: "Same key (different formatting)",
      });
      continue;
    }

    // 4. Substring match (one contains the other)
    if (
      requestedNorm.includes(existingNorm) ||
      existingNorm.includes(requestedNorm)
    ) {
      const score = 0.8;
      results.push({
        name: existingKey,
        score,
        reason: "Contains same key name",
      });
      continue;
    }

    // 5. Levenshtein distance (edit distance)
    const distance = levenshteinDistance(requestedNorm, existingNorm);
    const maxLength = Math.max(requestedNorm.length, existingNorm.length);
    const similarity = 1 - distance / maxLength;

    if (similarity >= threshold) {
      results.push({
        name: existingKey,
        score: similarity,
        reason: `${Math.round(similarity * 100)}% similar`,
      });
    }
  }

  // Sort by score (highest first)
  results.sort((a, b) => b.score - a.score);

  return results;
}

/**
 * Check if a key is an LLM provider key that can use OAuth/Papr proxy
 */
export function isOptionalLLMKey(keyName: string): boolean {
  const llmKeys = [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_AI_API_KEY",
    "GOOGLE_GEMINI_API_KEY",
  ];

  return llmKeys.some(
    (llmKey) =>
      keyName.toUpperCase() === llmKey ||
      normalizeKeyName(keyName) === normalizeKeyName(llmKey)
  );
}
