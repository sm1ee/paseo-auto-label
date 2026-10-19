import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const schema = z.object({ version: z.literal(1), serverId: z.string(), owned: z.record(z.string(), z.array(z.string())) });
export type Ownership = Record<string, string[]>;
export interface OwnershipStore {
  load(): Promise<Ownership>;
  save(owned: Ownership): Promise<void>;
}

export class FileOwnershipStore implements OwnershipStore {
  constructor(private readonly path: string, private readonly serverId: string) {}

  async load(): Promise<Ownership> {
    try {
      const state = schema.parse(JSON.parse(await readFile(this.path, "utf8")));
      if (state.serverId !== this.serverId) throw new Error("Ownership file belongs to a different host");
      return state.owned;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error("Cannot read label ownership. Check the plugin's local data file.");
    }
  }

  async save(owned: Ownership): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, serverId: this.serverId, owned }), { mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    }
  }
}
