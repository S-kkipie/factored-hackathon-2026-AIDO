export interface PromptInspector {
  inspect(text: string): Promise<{ flagged: boolean; detail: string }>;
}

// Model Armor's API returns confidenceLevel as LOW_AND_ABOVE / MEDIUM_AND_ABOVE / HIGH; LOW/MEDIUM are kept for robustness.
const RANK: Record<string, number> = { LOW_AND_ABOVE: 1, MEDIUM_AND_ABOVE: 2, HIGH: 3, LOW: 1, MEDIUM: 2 };
const THRESHOLD = { LOW_AND_ABOVE: 1, MEDIUM_AND_ABOVE: 2, HIGH: 3 } as const;

/** Access token from the Cloud Run / GCE metadata server (the service account the service runs as). */
export async function metadataToken(fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", {
    headers: { "metadata-flavor": "Google" },
    signal: AbortSignal.timeout(1000),
  });
  if (!res.ok) throw new Error(`metadata token: ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

/**
 * Google Model Armor, inspect-only (spec 4.5): the prompt-injection/jailbreak filter result becomes one more signal
 * next to the heuristic one. It never blocks; callers treat any error as "no signal".
 */
export function createModelArmor(o: {
  project: string;
  location: string;
  template: string;
  fetch?: typeof fetch;
  token?: () => Promise<string>;
  timeoutMs?: number;
  minConfidence?: keyof typeof THRESHOLD;
}): PromptInspector {
  const doFetch = o.fetch ?? fetch;
  const token = o.token ?? (() => metadataToken(doFetch));
  const url = `https://modelarmor.${o.location}.rep.googleapis.com/v1/projects/${o.project}/locations/${o.location}/templates/${o.template}:sanitizeUserPrompt`;
  const min = THRESHOLD[o.minConfidence ?? "MEDIUM_AND_ABOVE"];
  return {
    async inspect(text) {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${await token()}` },
        body: JSON.stringify({ userPromptData: { text } }),
        signal: AbortSignal.timeout(o.timeoutMs ?? 1500),
      });
      if (!res.ok) throw new Error(`model armor: ${res.status}`);
      const body = (await res.json()) as {
        sanitizationResult?: { filterResults?: { pi_and_jailbreak?: { piAndJailbreakFilterResult?: { matchState?: string; confidenceLevel?: string } } } };
      };
      const pi = body.sanitizationResult?.filterResults?.pi_and_jailbreak?.piAndJailbreakFilterResult;
      const flagged = pi?.matchState === "MATCH_FOUND" && (RANK[pi.confidenceLevel ?? ""] ?? 0) >= min;
      return { flagged, detail: `pi_and_jailbreak ${pi?.matchState ?? "n/a"} ${pi?.confidenceLevel ?? ""}`.trim() };
    },
  };
}
