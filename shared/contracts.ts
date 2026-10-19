import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const preferences = defineSettings({
  id: "preferences",
  scope: "host",
  version: 1,
  schema: z.object({
    enabled: z.boolean().default(true),
    includeSubagents: z.boolean().default(false),
    daemonHome: z.string().default(""),
  }),
});
export type Preferences = z.output<typeof preferences.schema>;

export const statusSchema = z.object({
  state: z.enum(["starting", "watching", "paused", "error"]),
  workspaces: z.number(),
  labelledWorkspaces: z.number(),
  configurations: z.number(),
  changes: z.number(),
  pending: z.number(),
  lastSyncedAt: z.string().nullable(),
  error: z.string().nullable(),
  examples: z.array(z.string()),
});
export type SyncStatus = z.output<typeof statusSchema>;

export const statusRpc = defineRpc({ name: "labels.status", input: z.object({}), output: statusSchema });
export const syncRpc = defineRpc({ name: "labels.sync", input: z.object({}), output: statusSchema });
export const clearRpc = defineRpc({ name: "labels.clear", input: z.object({}), output: statusSchema });
