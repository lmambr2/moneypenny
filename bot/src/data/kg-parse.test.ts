import { describe, it, expect } from "vitest";
import {
  extractSubject,
  isFactActiveAt,
  isIsoDate,
  parseKgFlags,
} from "./kg-parse.js";

describe("kg-parse", () => {
  it("parses date flags and strips them from text", () => {
    const p = parseKgFlags("Alice was CO from:2024-01-01 until:2025-06-30");
    expect(p.text).toBe("Alice was CO");
    expect(p.from).toBe("2024-01-01");
    expect(p.until).toBe("2025-06-30");
  });

  it("extracts subject from was/had patterns", () => {
    expect(extractSubject("Graf Cyril was Fleet Commander")).toBe("Graf Cyril");
    expect(extractSubject("Alpha held bridge watch")).toBe("Alpha");
  });

  it("validates ISO dates", () => {
    expect(isIsoDate("2026-06-21")).toBe(true);
    expect(isIsoDate("2026-13-01")).toBe(false);
  });

  it("filters facts by as-of date", () => {
    expect(isFactActiveAt("2024-01-01", "2025-12-31", "2025-06-01")).toBe(true);
    expect(isFactActiveAt("2024-01-01", "2025-12-31", "2023-06-01")).toBe(false);
    expect(isFactActiveAt("2024-01-01", "2025-12-31", "2026-06-01")).toBe(false);
    expect(isFactActiveAt(null, null, "2025-06-01")).toBe(true);
  });
});