import { fetchWithTimeout } from "../util/http.js";

/** Light probe — OpenAI-compatible servers usually expose GET /v1/models. */
export async function probeLlmEndpoint(baseUrl: string, timeoutMs = 1500): Promise<boolean> {
  const url = baseUrl.replace(/\/$/, "");
  if (!url) return false;
  try {
    const res = await fetchWithTimeout(`${url}/v1/models`, { timeoutMs });
    return res.ok;
  } catch {
    return false;
  }
}
