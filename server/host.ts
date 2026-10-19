import { createPaseoApi, type PaseoAgent, type PaseoWorkspace } from "@getpaseo/client";
import { DaemonClient, type WebSocketLike } from "@getpaseo/client/internal/daemon-client";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import { z } from "zod";
import type { AgentMetadata, Label, WorkspaceMetadata } from "../shared/model";
import { FileOwnershipStore, type OwnershipStore } from "./store";

export type DirectoryEvent =
  | { kind: "agent"; agent: AgentMetadata }
  | { kind: "remove-agent"; id: string }
  | { kind: "workspace"; workspace: WorkspaceMetadata }
  | { kind: "remove-workspace"; id: string };

export interface LabelHost {
  store: OwnershipStore;
  load(onEvent: (event: DirectoryEvent) => void, onError: () => void): Promise<{ agents: AgentMetadata[]; workspaces: WorkspaceMetadata[] }>;
  assign(workspaceId: string, label: Label, assigned: boolean): Promise<string[]>;
  close(): Promise<void>;
}

export function agentMetadata(agent: PaseoAgent): AgentMetadata {
  return {
    id: agent.id,
    workspaceId: agent.workspaceId,
    provider: agent.provider,
    model: agent.model,
    thinkingOptionId: agent.thinkingOptionId,
    effectiveThinkingOptionId: agent.effectiveThinkingOptionId,
    runtimeInfo: agent.runtimeInfo ? { model: agent.runtimeInfo.model, thinkingOptionId: agent.runtimeInfo.thinkingOptionId } : undefined,
    parentAgentId: agent.labels["paseo.parent-agent-id"]?.trim() || undefined,
    archived: Boolean(agent.archivedAt),
    internal: "internal" in agent && agent.internal === true,
  };
}

export function workspaceMetadata(workspace: PaseoWorkspace): WorkspaceMetadata {
  return { id: workspace.id, labels: workspace.labels ?? [], background: "background" in workspace && workspace.background === true, archiving: Boolean(workspace.archivingAt) };
}

export async function collectPages<T>(first: { entries: T[]; pageInfo: { hasMore: boolean; nextCursor: string | null } }, next: (cursor: string) => Promise<typeof first>): Promise<T[]> {
  const entries = [...first.entries];
  let page = first;
  const seen = new Set<string>();
  while (page.pageInfo.hasMore) {
    const cursor = page.pageInfo.nextCursor;
    if (!cursor || seen.has(cursor)) throw new Error("The host returned an invalid directory cursor.");
    seen.add(cursor);
    page = await next(cursor);
    entries.push(...page.entries);
  }
  return entries;
}

const lockSchema = z.object({ pid: z.number().int().positive(), listen: z.string().min(1), serverId: z.string().min(1) });
const run = promisify(execFile);

async function readParentPid(pid: number): Promise<number> {
  const { stdout } = process.platform === "win32"
    ? await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').ParentProcessId`], { timeout: 3000, maxBuffer: 1024 })
    : await run("ps", ["-p", String(pid), "-o", "ppid="], { timeout: 3000, maxBuffer: 1024 });
  const value = stdout.trim();
  return /^\d+$/.test(value) ? Number(value) : -1;
}

export async function belongsToDaemon(parentPid: number, ownerPid: number, parentOf = readParentPid): Promise<boolean> {
  if (parentPid === ownerPid) return true;
  // Desktop-managed hosts keep their PID lock in the supervisor, one level above
  // the daemon process that forks plugin workers.
  try { return await parentOf(parentPid) === ownerPid; } catch { return false; }
}

export function resolveHome(configured: string, environment: NodeJS.ProcessEnv = process.env): string {
  const raw = configured.trim() || environment.PASEO_HOME || join(homedir(), ".paseo");
  return resolve(raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw);
}

export function localEndpoint(listen: string): { url: string; socketPath?: string } {
  if (listen.startsWith("unix://") || listen.startsWith("pipe://") || listen.startsWith("/") || listen.startsWith("\\\\.\\pipe\\")) {
    const socketPath = listen.replace(/^(unix|pipe):\/\//, "");
    if (!socketPath) throw new Error("The host has no local socket.");
    return { url: "ws://localhost/ws", socketPath };
  }
  const target = new URL(`ws://${listen}/ws`);
  if (target.hostname === "0.0.0.0") target.hostname = "127.0.0.1";
  if (target.hostname === "[::]") target.hostname = "[::1]";
  if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || target.username || target.password || target.pathname !== "/ws" || target.search || target.hash) {
    throw new Error("Auto labels needs a loopback listener or a local socket on its host.");
  }
  return { url: target.href };
}

async function acquireLease(directory: string): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "worker.lock");
  const owner = { pid: process.pid, nonce: randomUUID() };
  const serialized = JSON.stringify(owner);
  try {
    await writeFile(path, serialized, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const previous = z.object({ pid: z.number().int().positive(), nonce: z.string() }).parse(JSON.parse(await readFile(path, "utf8")));
    let alive = true;
    try { process.kill(previous.pid, 0); } catch (probe) { if ((probe as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
    if (alive) throw new Error("Another Auto labels worker is already running on this host.");
    await unlink(path);
    return acquireLease(directory);
  }
  return async () => {
    try { if (await readFile(path, "utf8") === serialized) await unlink(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  };
}

// PaseoApi 0.11.4 exposes observations but not workspace label mutations.
// Keep the version-pinned, exported low-level client seam on the daemon only.
export async function openLocalHost(configuredHome: string, parentPid = process.ppid): Promise<LabelHost> {
  const home = resolveHome(configuredHome);
  let lock: z.output<typeof lockSchema>;
  try { lock = lockSchema.parse(JSON.parse(await readFile(join(home, "paseo.pid"), "utf8"))); }
  catch { throw new Error("Cannot find this host. Set its Paseo home in Auto labels settings."); }
  if (!await belongsToDaemon(parentPid, lock.pid)) throw new Error("The Paseo home belongs to another daemon. Set this host's home in Auto labels settings.");
  const endpoint = localEndpoint(lock.listen);
  const directory = join(home, "plugin-data", "paseo-auto-label");
  const releaseLease = await acquireLease(directory);
  const driver = new DaemonClient({
    url: endpoint.url,
    clientId: `auto-label-${randomUUID()}`,
    clientType: "cli",
    appVersion: "0.11.4",
    connectTimeoutMs: 10_000,
    reconnect: { enabled: false },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    localCredential: async () => {
      const current = lockSchema.parse(JSON.parse(await readFile(join(home, "paseo.pid"), "utf8")));
      if (current.pid !== lock.pid || current.serverId !== lock.serverId || current.listen !== lock.listen) throw new Error("The host changed.");
      const credential = (await readFile(join(home, "local-credential"), "utf8")).trim();
      if (!/^[A-Za-z0-9_-]{43}$/.test(credential)) throw new Error("The host's local credential is unavailable.");
      return credential;
    },
    webSocketFactory: (url, options) => new WebSocket(url, options?.protocols, { headers: options?.headers, ...(endpoint.socketPath ? { socketPath: endpoint.socketPath } : {}) }) as unknown as WebSocketLike,
  });
  const cleanup: (() => void | Promise<void>)[] = [];
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const release of cleanup.reverse()) await Promise.resolve(release()).catch(() => {});
    await driver.close().finally(releaseLease);
  };
  try {
    await driver.connect();
    const info = driver.getLastServerInfoMessage();
    if (info?.serverId !== lock.serverId) throw new Error("The connected daemon does not match this host.");
    if (info.features?.workspaceLabels !== true) throw new Error("This host does not support workspace labels. Update Paseo.");
    const paseo = createPaseoApi(driver);
    return {
      store: new FileOwnershipStore(join(directory, "ownership.json"), lock.serverId),
      async load(onEvent, onError) {
        cleanup.push(driver.subscribeConnectionStatus((state) => { if (!closed && state.status === "disconnected") onError(); }));
        const agentsOptions = { filter: { includeArchived: false }, sort: [{ key: "created_at" as const, direction: "asc" as const }], page: { limit: 200 } };
        const firstAgents = await paseo.agents.list({ ...agentsOptions, subscribe: {} });
        cleanup.push(() => firstAgents.subscription.release());
        cleanup.push(firstAgents.subscription.subscribe({
          snapshot() {},
          update(message) {
            if (message.type !== "agent_update") return;
            const update = message.payload;
            onEvent(update.kind === "upsert" ? { kind: "agent", agent: agentMetadata(update.agent) } : { kind: "remove-agent", id: update.agentId });
          },
          error: onError,
        }));
        const agents = await collectPages(firstAgents, (cursor) => paseo.agents.list({ ...agentsOptions, page: { limit: 200, cursor } }));
        const workspaceOptions = { sort: [{ key: "name" as const, direction: "asc" as const }], page: { limit: 200 } };
        const firstWorkspaces = await paseo.workspaces.list({ ...workspaceOptions, subscribe: {} });
        cleanup.push(() => firstWorkspaces.subscription.release());
        cleanup.push(firstWorkspaces.subscription.subscribe({
          snapshot() {},
          update(message) {
            if (message.type !== "workspace_update") return;
            const update = message.payload;
            onEvent(update.kind === "upsert" ? { kind: "workspace", workspace: workspaceMetadata(update.workspace) } : { kind: "remove-workspace", id: update.id });
          },
          error: onError,
        }));
        const workspaces = await collectPages(firstWorkspaces, (cursor) => paseo.workspaces.list({ ...workspaceOptions, page: { limit: 200, cursor } }));
        return { agents: agents.map(({ agent }) => agentMetadata(agent)), workspaces: workspaces.map(workspaceMetadata) };
      },
      async assign(workspaceId, label, assigned) {
        const result = await driver.setWorkspaceLabel({ workspaceId, label, assigned });
        return result.workspaceLabels;
      },
      close,
    };
  } catch (error) {
    await close();
    if (error instanceof Error && /^(The Paseo home|The connected daemon|This host|Auto labels|Another Auto labels)/.test(error.message)) throw error;
    throw new Error("Cannot connect to this host. Check its Paseo home and local daemon connection.");
  }
}
