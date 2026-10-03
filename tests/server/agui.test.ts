import type { BaseEvent } from "@ag-ui/core";
import { describe, expect, test } from "bun:test";
import { sseResponse } from "../../server/api/agui";

describe("sseResponse", () => {
  test("a client disconnect does not produce an unhandled rejection", async () => {
    let cleanedUp = false;
    async function* events(): AsyncGenerator<BaseEvent> {
      try {
        for (let i = 0; i < 50; i++) {
          yield { type: "x" } as unknown as BaseEvent;
          await new Promise((r) => setTimeout(r, 2));
        }
      } finally {
        cleanedUp = true;
      }
    }

    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);

    try {
      const res = sseResponse(events());
      const reader = res.body!.getReader();
      await reader.read();
      await reader.cancel();
      // Give the background loop time to hit the now-cancelled controller's enqueue (the client-disconnect path).
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      process.off("unhandledRejection", onRejection);
    }

    expect(rejections).toEqual([]);
    expect(cleanedUp).toBe(true);
  });
});
