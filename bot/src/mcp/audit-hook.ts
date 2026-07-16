import type { AuditStore } from "../data/audit.js";
import type { McpSubject, McpToolEnvelope } from "./types.js";

/**
 * Durable audit for every MCP tool outcome (docs/mcp-server.md §5.4).
 * Encodes tool name in targetUsername and bot id in targetUserId so the
 * existing audit table needs no schema migration.
 */
export function recordMcpToolAudit(
  audit: AuditStore | undefined | null,
  subject: McpSubject,
  toolName: string,
  envelope: McpToolEnvelope,
): void {
  if (!audit) return;
  try {
    const denied = !envelope.ok && envelope.code === "PERMISSION_DENIED";
    const action = denied
      ? "mcp.tool.denied"
      : envelope.ok
        ? "mcp.tool"
        : "mcp.tool.error";
    audit.record({
      actorId: subject.invokerUid,
      actorUsername: `${subject.invokerName}|${subject.rightsProfile}|${subject.tokenId}`,
      targetUserId: envelope.meta.bot_id ?? null,
      targetUsername: toolName,
      action,
    });
  } catch {
    // Never fail the tool path because audit storage failed.
  }
}
