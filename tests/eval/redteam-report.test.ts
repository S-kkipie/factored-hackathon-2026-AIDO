import { expect, test } from "bun:test";
import { renderRedteamReport } from "../../eval/redteam/report";

test("the red-team report computes attack success per plugin with database effects", () => {
  const promptfoo = {
    results: {
      results: [
        { success: true, metadata: { pluginId: "bola" }, response: { metadata: { disputes: 0 } } },
        { success: false, metadata: { pluginId: "bola" }, response: { metadata: { disputes: 0 } } },
        { success: true, metadata: { pluginId: "excessive-agency", strategyId: "crescendo" }, response: { metadata: { disputes: 1 } } },
      ],
    },
  };
  const md = renderRedteamReport({ promptfoo });
  expect(md).toContain("# Red teaming");
  expect(md).toMatch(/\| bola \| 2 \| 1 \|/);
  expect(md).toContain("remote");
  expect(md).toContain("not human-validated");
  expect(md).toMatch(/disputes created during attacks: 1/i);
});
