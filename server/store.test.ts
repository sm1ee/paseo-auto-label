import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { FileOwnershipStore } from "./store";

describe("local ownership journal", () => {
  it("round-trips with private permissions and preserves invalid data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paseo-auto-label-test-"));
    try {
      const path = join(directory, "ownership.json");
      const store = new FileOwnershipStore(path, "host-a");
      expect(await store.load()).toEqual({});
      await store.save({ "workspace-a": ["codex · model-a · max"] });
      expect(await store.load()).toEqual({ "workspace-a": ["codex · model-a · max"] });
      if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
      await expect(new FileOwnershipStore(path, "host-b").load()).rejects.toThrow("Cannot read label ownership");
      await writeFile(path, "invalid data");
      await expect(store.load()).rejects.toThrow("Cannot read label ownership");
      expect(await readFile(path, "utf8")).toBe("invalid data");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
