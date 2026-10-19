import { afterEach, describe, expect, it, vi } from "vitest";
import type { Preferences } from "../shared/contracts";
import { labelForAgent, type AgentMetadata, type Label, type WorkspaceMetadata } from "../shared/model";
import type { DirectoryEvent, LabelHost } from "./host";
import { AutoLabelService } from "./service";
import type { Ownership } from "./store";

const preferences: Preferences = { enabled: true, includeSubagents: false, daemonHome: "" };
const initialAgent: AgentMetadata = { id: "session-a", workspaceId: "workspace-a", provider: "codex", model: "model-a", thinkingOptionId: "high" };

class FakeHost implements LabelHost {
  agents: AgentMetadata[] = [structuredClone(initialAgent)];
  workspaces: WorkspaceMetadata[] = [{ id: "workspace-a", labels: ["keep my label"] }];
  owned: Ownership = {};
  onEvent: (event: DirectoryEvent) => void = () => {};
  beforeAssign?: () => Promise<void>;
  loseReply = false;
  close = vi.fn(async () => {});
  store = {
    load: async () => structuredClone(this.owned),
    save: vi.fn(async (owned: Ownership) => { this.owned = structuredClone(owned); }),
  };
  load: LabelHost["load"] = async (onEvent) => {
    this.onEvent = onEvent;
    return structuredClone({ agents: this.agents, workspaces: this.workspaces });
  };
  event(event: DirectoryEvent) {
    if (event.kind === "agent") this.agents = this.agents.filter(({ id }) => id !== event.agent.id).concat(event.agent);
    if (event.kind === "remove-agent") this.agents = this.agents.filter(({ id }) => id !== event.id);
    this.onEvent(structuredClone(event));
  }
  assign = vi.fn(async (workspaceId: string, label: Label, assigned: boolean) => {
    await this.beforeAssign?.();
    const workspace = this.workspaces.find(({ id }) => id === workspaceId)!;
    if (assigned && !workspace.labels.includes(label.name)) workspace.labels.push(label.name);
    if (!assigned) workspace.labels = workspace.labels.filter((name) => name !== label.name);
    this.event({ kind: "workspace", workspace });
    if (this.loseReply) { this.loseReply = false; throw new Error("Committed, but reply was lost"); }
    return [...workspace.labels];
  });
}

const services: AutoLabelService[] = [];
function setup(host = new FakeHost()) {
  const service = new AutoLabelService(async () => host);
  services.push(service);
  return { host, service };
}
afterEach(async () => { await Promise.all(services.splice(0).map((service) => service.stop())); });

describe("automatic label synchronization", () => {
  it("backfills existing workspaces and preserves unrelated manual labels", async () => {
    const { host, service } = setup();
    await service.configure(preferences);
    await service.flush();
    expect(host.workspaces[0].labels).toEqual(["keep my label", "codex · model-a · high"]);
    expect(host.owned["workspace-a"]).toEqual(["codex · model-a · high"]);
    expect(service.status().labelledWorkspaces).toBe(1);
  });

  it("replaces only its own label on a model or effort switch", async () => {
    const { host, service } = setup();
    await service.configure(preferences); await service.flush();
    host.event({ kind: "agent", agent: { ...initialAgent, model: "model-b", thinkingOptionId: "max" } });
    await service.flush();
    expect(host.workspaces[0].labels).toEqual(["keep my label", "codex · model-b · max"]);
    expect(host.assign.mock.calls.map(([, label, assigned]) => [label.name, assigned])).toEqual([["codex · model-a · high", true], ["codex · model-b · max", true], ["codex · model-a · high", false]]);
  });

  it("does not claim ownership of a matching manual label", async () => {
    const host = new FakeHost();
    host.workspaces[0].labels.push(labelForAgent(initialAgent).name);
    const { service } = setup(host);
    await service.configure(preferences); await service.flush();
    host.event({ kind: "agent", agent: { ...initialAgent, model: "model-b" } });
    await service.flush();
    expect(host.workspaces[0].labels).toContain("codex · model-a · high");
    expect(host.owned["workspace-a"]).toEqual(["codex · model-b · high"]);
  });

  it("shares a label across identical sessions and tracks distinct main-session configurations", async () => {
    const host = new FakeHost();
    host.agents.push({ ...initialAgent, id: "session-b" }, { ...initialAgent, id: "session-c", provider: "claude", model: "model-c" });
    const { service } = setup(host);
    await service.configure(preferences); await service.flush();
    expect(host.assign).toHaveBeenCalledTimes(2);
    host.event({ kind: "remove-agent", id: "session-a" });
    await service.flush();
    expect(host.assign).toHaveBeenCalledTimes(2);
    host.event({ kind: "remove-agent", id: "session-b" });
    await service.flush();
    expect(host.workspaces[0].labels).not.toContain("codex · model-a · high");
  });

  it("ignores its own update events and unrelated runtime churn", async () => {
    const { host, service } = setup();
    await service.configure(preferences); await service.flush();
    for (let i = 0; i < 10; i++) host.event({ kind: "agent", agent: initialAgent });
    await service.flush();
    expect(host.assign).toHaveBeenCalledTimes(1);
  });

  it("excludes subagents by default and updates when inclusion changes", async () => {
    const host = new FakeHost();
    host.agents.push({ ...initialAgent, id: "child", model: "child-model", parentAgentId: "parent" });
    const { service } = setup(host);
    await service.configure(preferences); await service.flush();
    expect(host.assign).toHaveBeenCalledTimes(1);
    await service.configure({ ...preferences, includeSubagents: true }); await service.flush();
    expect(host.workspaces[0].labels).toContain("codex · child-model · high");
    await service.configure(preferences); await service.flush();
    expect(host.workspaces[0].labels).not.toContain("codex · child-model · high");
  });

  it("leaves archived, background, and archiving workspaces alone", async () => {
    const host = new FakeHost();
    host.agents[0].archived = true;
    host.workspaces.push({ id: "background", labels: [], background: true }, { id: "archiving", labels: [], archiving: true });
    host.agents.push({ ...initialAgent, id: "bg", workspaceId: "background" }, { ...initialAgent, id: "ar", workspaceId: "archiving" });
    const { service } = setup(host);
    await service.configure(preferences); await service.flush();
    expect(host.assign).not.toHaveBeenCalled();
  });

  it("pauses without removing labels, then removes only owned labels on request", async () => {
    const { host, service } = setup();
    await service.configure(preferences); await service.flush();
    await service.configure({ ...preferences, enabled: false });
    host.event({ kind: "agent", agent: { ...initialAgent, model: "model-b" } });
    await service.flush();
    expect(host.assign).toHaveBeenCalledTimes(1);
    await service.clear();
    expect(host.workspaces[0].labels).toEqual(["keep my label"]);
    expect(host.owned).toEqual({});
  });

  it("persists ownership before writing and recovers a committed RPC with a lost reply", async () => {
    const { host, service } = setup();
    host.loseReply = true;
    await service.configure(preferences); await service.flush();
    expect(service.status().state).toBe("error");
    expect(host.owned["workspace-a"]).toEqual(["codex · model-a · high"]);
    expect(host.store.save.mock.invocationCallOrder[0]).toBeLessThan(host.assign.mock.invocationCallOrder[0]);
    await service.sync();
    expect(service.status().state).toBe("watching");
    expect(host.assign).toHaveBeenCalledTimes(1);
    await service.configure({ ...preferences, enabled: false }); await service.clear();
    expect(host.workspaces[0].labels).toEqual(["keep my label"]);
  });

  it("recomputes the plan if settings change during an in-flight write", async () => {
    const { host, service } = setup();
    await service.configure(preferences);
    let switched = false;
    host.beforeAssign = async () => {
      if (switched) return;
      switched = true;
      host.event({ kind: "agent", agent: { ...initialAgent, model: "latest-model", thinkingOptionId: "max" } });
    };
    await service.flush();
    expect(host.workspaces[0].labels).toEqual(["keep my label", "codex · latest-model · max"]);
  });

  it("releases its host and does not write after cleanup", async () => {
    const { host, service } = setup();
    await service.configure(preferences);
    await service.stop();
    host.event({ kind: "agent", agent: { ...initialAgent, model: "model-b" } });
    expect(host.close).toHaveBeenCalled();
    expect(host.assign).not.toHaveBeenCalled();
  });

  it("stops pending writes when settings become invalid", async () => {
    const { host, service } = setup();
    await service.configure(preferences);
    await service.invalidSettings();
    await service.flush();
    expect(service.status().state).toBe("error");
    expect(host.assign).not.toHaveBeenCalled();
    expect(host.close).toHaveBeenCalled();
  });

  it("does not write from a directory snapshot whose observation failed", async () => {
    const host = new FakeHost();
    host.load = async (_onEvent, onError) => {
      onError();
      return { agents: host.agents, workspaces: host.workspaces };
    };
    const { service } = setup(host);
    await service.configure(preferences); await service.flush();
    expect(service.status().state).toBe("error");
    expect(host.assign).not.toHaveBeenCalled();
  });
});
