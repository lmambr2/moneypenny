/**
 * Vue E2E-style critical admin flow: Login form → session.login → navigate.
 * Drives the real Login.vue + useSession.login path with mocked axios (network
 * boundary only). Runs under vitest/happy-dom (no separate browser harness).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createRouter, createMemoryHistory } from "vue-router";
import { defineComponent, h, nextTick } from "vue";

const post = vi.fn();
const get = vi.fn();

vi.mock("../api/axios.js", () => ({
  default: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
  },
}));

// Import after mock
import Login from "../views/Login.vue";

describe("E2E: admin login flow", () => {
  beforeEach(() => {
    post.mockReset();
    get.mockReset();
    get.mockImplementation(async (url: string) => {
      if (url.includes("needs-setup")) return { data: { needsSetup: false } };
      if (url.includes("/me")) {
        const err: any = new Error("unauthorized");
        err.response = { status: 401 };
        throw err;
      }
      return { data: {} };
    });
  });

  it("submits credentials via real Login.vue → session.login → /api/session/login", async () => {
    post.mockResolvedValue({ data: { id: "u1", username: "admin", role: "admin" } });
    get.mockImplementation(async (url: string) => {
      if (url.includes("needs-setup")) return { data: { needsSetup: false } };
      if (url.includes("/me")) return { data: { id: "u1", username: "admin", role: "admin" } };
      return { data: {} };
    });

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/login", name: "login", component: Login },
        {
          path: "/",
          name: "home",
          component: defineComponent({ name: "HomeStub", setup: () => () => h("div", "home") }),
        },
      ],
    });
    await router.push("/login");
    await router.isReady();

    const wrapper = mount(Login, {
      global: { plugins: [router] },
    });
    await flushPromises();
    await nextTick();

    const inputs = wrapper.findAll("input");
    expect(inputs.length).toBeGreaterThanOrEqual(2);
    await inputs[0]!.setValue("admin");
    await inputs[1]!.setValue("secret-pass");

    await wrapper.find("form").trigger("submit.prevent");
    await flushPromises();

    expect(post).toHaveBeenCalledWith(
      "/api/session/login",
      expect.objectContaining({ username: "admin", password: "secret-pass" }),
    );
    // After success, router replaces to next (/)
    expect(router.currentRoute.value.path).toBe("/");
  });

  it("shows error when login fails", async () => {
    post.mockRejectedValue({
      response: { data: { error: "Invalid credentials" }, status: 401 },
    });
    // useSession.login throws Error with message from response
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/login", name: "login", component: Login },
        {
          path: "/",
          name: "home",
          component: defineComponent({ setup: () => () => h("div") }),
        },
      ],
    });
    await router.push("/login");
    await router.isReady();

    const wrapper = mount(Login, { global: { plugins: [router] } });
    await flushPromises();
    await wrapper.findAll("input")[0]!.setValue("admin");
    await wrapper.findAll("input")[1]!.setValue("bad");
    await wrapper.find("form").trigger("submit.prevent");
    await flushPromises();

    expect(post).toHaveBeenCalled();
    expect(wrapper.text()).toMatch(/invalid|fail|error|credential/i);
  });
});
