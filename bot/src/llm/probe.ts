import axios from "axios";

/** Light probe — OpenAI-compatible servers usually expose GET /v1/models. */
export async function probeLlmEndpoint(baseUrl: string, timeoutMs = 1500): Promise<boolean> {
  const url = baseUrl.replace(/\/$/, "");
  if (!url) return false;
  try {
    await axios.get(`${url}/v1/models`, { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}
