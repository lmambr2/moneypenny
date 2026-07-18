import { describe, expect, it } from "vitest";
import {
  cleanShipName,
  generateShipListMarkdown,
  parseShipListMarkdown,
} from "./hangar-ship-list.js";

const SAMPLE = `---
classification: secret
tags: [intel, fleet-ops]
---

# Org Fleet List

### Combat Vessels
- **(GCV)** Polaris - LTI \`#capital #missile #torpedo\`
- **(GCV)** 5× Aurora MK I SE
- **(CHIP)** Perseus - LTI
- **(TER)** Paladin \`#tank #heavy\`
`;

describe("Ship_List parse/generate", () => {
  it("cleans LTI and hashtag tails", () => {
    expect(cleanShipName("Polaris - LTI `#capital #missile`")).toEqual({
      name: "Polaris",
      notes: "LTI",
    });
    expect(cleanShipName("Paladin `#tank #heavy`").name).toBe("Paladin");
  });

  it("parses callsign lines and qty", () => {
    const entries = parseShipListMarkdown(SAMPLE);
    expect(entries.length).toBeGreaterThanOrEqual(3);
    const polaris = entries.find((e) => e.shipName === "Polaris");
    expect(polaris?.callsign).toBe("GCV");
    expect(polaris?.qty).toBe(1);
    expect(polaris?.notes).toMatch(/LTI/i);
    const aurora = entries.find((e) => e.shipName.includes("Aurora"));
    expect(aurora?.qty).toBe(5);
    expect(entries.find((e) => e.shipName === "Paladin")).toBeTruthy();
  });

  it("generates secret frontmatter", () => {
    const md = generateShipListMarkdown([
      { callsign: "GCV", displayName: "Graf", shipName: "Polaris", qty: 1, notes: "LTI" },
      { callsign: "GCV", displayName: "Graf", shipName: "Aurora", qty: 5, notes: null },
    ]);
    expect(md).toMatch(/classification: secret/);
    expect(md).toMatch(/Polaris/);
    expect(md).toMatch(/5× Aurora/);
  });
});
