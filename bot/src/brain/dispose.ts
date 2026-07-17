import type { ToolProposal } from "./types.js";

export interface DisposeResult {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  result?: string;
  error?: string;
}

export type ToolExecutor = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ ok: boolean; result?: string; error?: string }>;

/**
 * Bot-side disposal of brain tool proposals (rights / dry-run live in executor).
 * Never throws — per-tool failures become ok:false records.
 */
export async function disposeToolProposals(
  proposals: ToolProposal[],
  executeTool: ToolExecutor,
): Promise<DisposeResult[]> {
  const out: DisposeResult[] = [];
  for (const p of proposals) {
    const name = typeof p.name === "string" ? p.name.trim() : "";
    const args =
      p.arguments && typeof p.arguments === "object" && !Array.isArray(p.arguments)
        ? p.arguments
        : {};
    if (!name) {
      out.push({ name: "", args, ok: false, error: "empty tool name" });
      continue;
    }
    try {
      const r = await executeTool(name, args);
      out.push({
        name,
        args,
        ok: r.ok,
        result: r.result,
        error: r.error,
      });
    } catch (err) {
      out.push({
        name,
        args,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}
