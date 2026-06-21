import { describe, it, expect, vi, beforeEach } from "vitest";

const apiGet = vi.fn();
const apiPost = vi.fn();

vi.mock("../api/axios.js", () => ({
  default: {
    get: (...args: unknown[]) => apiGet(...args),
    post: (...args: unknown[]) => apiPost(...args),
  },
}));

describe("useSession", () => {
  beforeEach(() => {
    vi.resetModules();
    apiGet.mockReset();
    apiPost.mockReset();
  });

  it("refresh sets needsSetup and skips /me when first-run is required", async () => {
    apiGet.mockResolvedValueOnce({ data: { needsSetup: true } });
    const { useSession } = await import("./useSession.js");
    const session = useSession();
    await session.refresh();
    expect(session.needsSetup.value).toBe(true);
    expect(session.currentUser.value).toBeNull();
    expect(session.ready.value).toBe(true);
    expect(apiGet).toHaveBeenCalledWith("/api/session/needs-setup");
    expect(apiGet).toHaveBeenCalledTimes(1);
  });

  it("login stores the returned user", async () => {
    apiPost.mockResolvedValueOnce({ data: { id: "u1", username: "admin", role: "admin" } });
    const { useSession } = await import("./useSession.js");
    const session = useSession();
    await session.login("admin", "secret");
    expect(session.currentUser.value).toEqual({ id: "u1", username: "admin", role: "admin" });
    expect(session.isAuthenticated.value).toBe(true);
    expect(session.isAdmin.value).toBe(true);
  });

  it("logout clears current user", async () => {
    apiPost.mockResolvedValue({ data: {} });
    const { useSession } = await import("./useSession.js");
    const session = useSession();
    await session.login("admin", "secret");
    await session.logout();
    expect(session.currentUser.value).toBeNull();
  });
});