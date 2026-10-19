import type { Preferences, SyncStatus } from "../shared/contracts";
import { agentFingerprint, labelKey, labelsForWorkspace, type AgentMetadata, type Label, type WorkspaceMetadata } from "../shared/model";
import { openLocalHost, type DirectoryEvent, type LabelHost } from "./host";
import type { Ownership } from "./store";

export class AutoLabelService {
  private preferences: Preferences = { enabled: true, includeSubagents: false, daemonHome: "" };
  private host?: LabelHost;
  private owned: Ownership = {};
  private agents = new Map<string, AgentMetadata>();
  private workspaces = new Map<string, WorkspaceMetadata>();
  private pending = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private retry?: ReturnType<typeof setTimeout>;
  private control: Promise<void> = Promise.resolve();
  private pumping?: Promise<void>;
  private generation = 0;
  private operation = 0;
  private stopped = false;
  private clearing = false;
  private phase: SyncStatus["state"] = "starting";
  private error: string | null = null;
  private changes = 0;
  private lastSyncedAt: string | null = null;

  constructor(private readonly connect: (home: string) => Promise<LabelHost> = openLocalHost) {}

  async configure(preferences: Preferences): Promise<void> {
    if (this.stopped) return;
    const previous = this.preferences;
    this.preferences = { ...preferences };
    if (preferences.enabled !== previous.enabled) {
      this.operation++;
      this.pending.clear();
      this.clearing = false;
    }
    if (!preferences.enabled) {
      this.phase = "paused";
    }
    if (!this.host || preferences.daemonHome !== previous.daemonHome) return this.restart();
    if (preferences.enabled) {
      this.phase = "watching";
      this.enqueueAll();
    }
  }

  private restart(): Promise<void> {
    const generation = ++this.generation;
    this.operation++;
    this.pending.clear();
    if (this.retry) clearTimeout(this.retry);
    if (this.timer) clearTimeout(this.timer);
    this.control = this.control.catch(() => {}).then(async () => {
      const old = this.host;
      this.host = undefined;
      await old?.close();
      await this.pumping;
      if (this.stopped || generation !== this.generation) return;
      this.phase = this.preferences.enabled ? "starting" : "paused";
      this.error = null;
      let host: LabelHost | undefined;
      try {
        host = await this.connect(this.preferences.daemonHome);
        if (this.stopped || generation !== this.generation) { await host.close(); return; }
        this.host = host;
        this.owned = await host.store.load();
        let loading = true;
        let observationFailed = false;
        const buffered = new Map<string, DirectoryEvent>();
        const snapshot = await host.load((event) => {
          if (this.stopped || generation !== this.generation) return;
          if (loading) {
            const key = event.kind === "agent" ? `a:${event.agent.id}` : event.kind === "remove-agent" ? `a:${event.id}` : event.kind === "workspace" ? `w:${event.workspace.id}` : `w:${event.id}`;
            buffered.set(key, event);
          } else this.changed(event);
        }, () => {
          observationFailed = true;
          if (generation === this.generation && !this.stopped) this.failed("The host connection was interrupted. Retrying…");
        });
        if (this.stopped || generation !== this.generation) { await host.close(); return; }
        if (observationFailed) throw new Error("Directory observation failed during startup");
        this.agents = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
        this.workspaces = new Map(snapshot.workspaces.map((workspace) => [workspace.id, workspace]));
        for (const event of buffered.values()) this.changed(event);
        loading = false;
        this.error = null;
        this.phase = this.preferences.enabled ? "watching" : "paused";
        this.enqueueAll();
      } catch (error) {
        await host?.close().catch(() => {});
        if (generation !== this.generation || this.stopped) return;
        this.host = undefined;
        const message = error instanceof Error && /^(Cannot (find this host|read label ownership|connect to this host)|The Paseo home|The connected daemon|This host|Auto labels needs|Another Auto labels)/.test(error.message)
          ? error.message : "Cannot start auto labels. Check this host's connection and plugin data.";
        this.failed(message);
      }
    });
    return this.control;
  }

  private failed(message: string): void {
    this.phase = "error";
    this.error = message;
    this.operation++;
    this.pending.clear();
    if (!this.retry && !this.stopped) {
      this.retry = setTimeout(() => { this.retry = undefined; void this.restart(); }, 15_000);
    }
  }

  private changed(event: DirectoryEvent): void {
    if (event.kind === "agent") {
      const previous = this.agents.get(event.agent.id);
      this.agents.set(event.agent.id, event.agent);
      if (previous && agentFingerprint(previous) === agentFingerprint(event.agent)) return;
      if (previous?.workspaceId) this.enqueue(previous.workspaceId);
      if (event.agent.workspaceId) this.enqueue(event.agent.workspaceId);
    } else if (event.kind === "remove-agent") {
      const previous = this.agents.get(event.id);
      this.agents.delete(event.id);
      if (previous?.workspaceId) this.enqueue(previous.workspaceId);
    } else if (event.kind === "workspace") {
      const previous = this.workspaces.get(event.workspace.id);
      this.workspaces.set(event.workspace.id, event.workspace);
      if (!previous || JSON.stringify(previous) !== JSON.stringify(event.workspace)) this.enqueue(event.workspace.id);
    } else {
      this.workspaces.delete(event.id);
      this.pending.delete(event.id);
    }
  }

  private desired(workspaceId: string): Label[] {
    return labelsForWorkspace(workspaceId, this.agents.values(), this.preferences.includeSubagents);
  }

  private enqueueAll(): void {
    for (const id of this.workspaces.keys()) this.enqueue(id);
  }

  private enqueue(id: string): void {
    if (this.stopped || (!this.preferences.enabled && !this.clearing) || this.phase === "error") return;
    this.pending.add(id);
    this.schedule();
  }

  private schedule(): void {
    if (this.timer || this.pumping || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pumping = this.pump().finally(() => {
        this.pumping = undefined;
        if (this.pending.size) this.schedule();
      });
    }, 150);
  }

  private async pump(): Promise<void> {
    const host = this.host;
    const generation = this.generation;
    const operation = this.operation;
    if (!host) return;
    while (this.pending.size && !this.stopped && generation === this.generation && operation === this.operation && (this.preferences.enabled || this.clearing)) {
      const id = this.pending.values().next().value!;
      this.pending.delete(id);
      try {
        await this.reconcile(id, host, () => !this.stopped && generation === this.generation && operation === this.operation && this.host === host);
      } catch {
        if (generation === this.generation && operation === this.operation && !this.stopped) this.failed("A label update failed. Retrying from the saved ownership record…");
        return;
      }
    }
    if (generation === this.generation && operation === this.operation) this.lastSyncedAt = new Date().toISOString();
  }

  private async reconcile(id: string, host: LabelHost, current: () => boolean): Promise<void> {
    // Recompute after every awaited operation so a model switch cannot leave a stale plan.
    for (let step = 0; step < 50 && current(); step++) {
      const workspace = this.workspaces.get(id);
      if (!workspace || workspace.background || workspace.archiving) return;
      const desired = this.clearing ? [] : this.desired(id);
      const desiredKeys = new Set(desired.map(({ name }) => labelKey(name)));
      const assigned = new Set(workspace.labels.map(labelKey));
      const owned = this.owned[id] ?? [];
      const missing = desired.find(({ name }) => !assigned.has(labelKey(name)));
      const obsolete = owned.find((name) => !desiredKeys.has(labelKey(name)));
      if (missing) {
        // Record intent before the RPC: a committed write with a lost reply stays removable.
        if (!owned.some((name) => labelKey(name) === labelKey(missing.name))) {
          this.owned[id] = [...owned, missing.name];
          await host.store.save(this.owned);
        }
        if (!current()) return;
        const labels = await host.assign(id, missing, true);
        if (!current()) return;
        this.workspaces.set(id, { ...this.workspaces.get(id)!, labels });
        this.changes++;
      } else if (obsolete) {
        if (assigned.has(labelKey(obsolete))) {
          if (!current()) return;
          const labels = await host.assign(id, { name: obsolete, color: "sky" }, false);
          if (!current()) return;
          this.workspaces.set(id, { ...this.workspaces.get(id)!, labels });
          this.changes++;
        }
        const remaining = (this.owned[id] ?? []).filter((name) => labelKey(name) !== labelKey(obsolete));
        if (remaining.length) this.owned[id] = remaining;
        else delete this.owned[id];
        await host.store.save(this.owned);
      } else return;
    }
    if (current()) this.enqueue(id);
  }

  status(): SyncStatus {
    const configurations = new Set<string>();
    let workspaces = 0;
    let labelledWorkspaces = 0;
    for (const workspace of this.workspaces.values()) {
      if (workspace.background || workspace.archiving) continue;
      const desired = this.desired(workspace.id);
      if (!desired.length) continue;
      workspaces++;
      desired.forEach(({ name }) => configurations.add(name));
      const assigned = new Set(workspace.labels.map(labelKey));
      if (desired.every(({ name }) => assigned.has(labelKey(name)))) labelledWorkspaces++;
    }
    return {
      state: this.phase, workspaces, labelledWorkspaces, configurations: configurations.size,
      changes: this.changes, pending: this.pending.size + (this.pumping ? 1 : 0),
      lastSyncedAt: this.lastSyncedAt, error: this.error,
      examples: [...configurations].sort().slice(0, 5),
    };
  }

  async sync(): Promise<SyncStatus> {
    await this.restart();
    await this.flush();
    return this.status();
  }

  async clear(): Promise<SyncStatus> {
    if (this.preferences.enabled) throw new Error("Pause auto labels before removing generated labels.");
    await this.control;
    await this.pumping;
    if (!this.host || this.phase === "error") throw new Error("Connect to this host before removing generated labels.");
    this.clearing = true;
    try {
      for (const id of Object.keys(this.owned)) if (this.workspaces.has(id)) this.enqueue(id);
      await this.flush();
    } finally { this.clearing = false; }
    return this.status();
  }

  // Also used by integration tests to wait for the coalesced write queue.
  async flush(): Promise<void> {
    await this.control;
    while (this.pending.size || this.pumping) {
      if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
      if (this.pumping) await this.pumping;
      else {
        this.pumping = this.pump().finally(() => { this.pumping = undefined; });
        await this.pumping;
      }
      if (this.phase === "error" || this.stopped) break;
    }
  }

  async invalidSettings(): Promise<void> {
    if (this.stopped) return;
    this.preferences = { ...this.preferences, enabled: false };
    this.generation++;
    this.operation++;
    this.pending.clear();
    this.clearing = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.retry) { clearTimeout(this.retry); this.retry = undefined; }
    const host = this.host;
    this.host = undefined;
    await host?.close();
    await this.control;
    await this.pumping;
    this.phase = "error";
    this.error = "Auto labels settings could not be read. Open settings to fix them.";
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.generation++;
    this.operation++;
    this.pending.clear();
    if (this.timer) clearTimeout(this.timer);
    if (this.retry) clearTimeout(this.retry);
    await this.host?.close();
    await this.control;
    await this.pumping;
  }
}
