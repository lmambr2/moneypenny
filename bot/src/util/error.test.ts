import { describe, expect, it } from "vitest";
import { errorCode, errorMessage, httpStatus } from "./error.js";

describe("errorMessage", () => {
  it("reads Error.message", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("reads string throws", () => {
    expect(errorMessage("plain")).toBe("plain");
  });

  it("reads object message and uses fallback", () => {
    expect(errorMessage({ message: "obj" })).toBe("obj");
    expect(errorMessage(42, "fallback")).toBe("fallback");
  });
});

describe("errorCode", () => {
  it("returns string codes", () => {
    expect(errorCode({ code: "EACCES" })).toBe("EACCES");
    expect(errorCode(new Error("x"))).toBeUndefined();
  });
});

describe("httpStatus", () => {
  it("returns axios-style response status", () => {
    expect(httpStatus({ response: { status: 404 } })).toBe(404);
    expect(httpStatus(new Error("x"))).toBeUndefined();
  });
});
