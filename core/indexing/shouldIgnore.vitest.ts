import { describe, expect, it, vi } from "vitest";

import type { IDE } from "..";
import { shouldIgnore } from "./shouldIgnore";

describe("shouldIgnore with a parent directory that can't be listed", () => {
  it("doesn't throw and treats that level as having no ignore files", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const ide = {
      getWorkspaceDirs: async () => ["file:///proj"],
      listDir: async (dir: string) => {
        if (dir === "file:///proj/ENHC") {
          throw new Error("Operation not supported for object ENHC");
        }
        return [];
      },
      readFile: async () => "",
    } as unknown as IDE;

    await expect(shouldIgnore("file:///proj/ENHC/obj.ts", ide)).resolves.toBe(
      false,
    );
  });
});
