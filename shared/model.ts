export const labelColors = ["violet", "sky", "emerald", "orange", "pink", "indigo", "teal", "red", "amber", "blue"] as const;
export type Label = { name: string; color: typeof labelColors[number] };

export interface AgentMetadata {
  id: string;
  workspaceId?: string;
  provider: string;
  model?: string | null;
  thinkingOptionId?: string | null;
  effectiveThinkingOptionId?: string | null;
  runtimeInfo?: { model?: string | null; thinkingOptionId?: string | null };
  parentAgentId?: string;
  archived?: boolean;
  internal?: boolean;
}

export interface WorkspaceMetadata {
  id: string;
  labels: string[];
  background?: boolean;
  archiving?: boolean;
}

export function labelKey(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

function reported(...values: (string | null | undefined)[]): string | undefined {
  return values.find((value) => typeof value === "string" && value.trim().length > 0)?.replace(/\s+/g, " ").trim();
}

export function labelForAgent(agent: AgentMetadata): Label {
  const provider = reported(agent.provider) ?? "provider unknown";
  const model = reported(agent.model, agent.runtimeInfo?.model) ?? "model unknown";
  const effort = reported(agent.thinkingOptionId, agent.effectiveThinkingOptionId, agent.runtimeInfo?.thinkingOptionId) ?? "effort unknown";
  const colors: Record<string, Label["color"]> = { codex: "sky", claude: "orange", omp: "emerald", opencode: "violet", pi: "pink", cursor: "teal" };
  return { name: `${provider} · ${model} · ${effort}`, color: colors[provider] ?? "indigo" };
}

export function labelsForWorkspace(workspaceId: string, agents: Iterable<AgentMetadata>, includeSubagents: boolean): Label[] {
  const labels = new Map<string, Label>();
  for (const agent of agents) {
    if (agent.workspaceId !== workspaceId || agent.archived || agent.internal || (!includeSubagents && agent.parentAgentId)) continue;
    const label = labelForAgent(agent);
    if (!labels.has(labelKey(label.name))) labels.set(labelKey(label.name), label);
  }
  return [...labels.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function agentFingerprint(agent: AgentMetadata): string {
  return JSON.stringify([agent.workspaceId, labelForAgent(agent).name, agent.parentAgentId, agent.archived, agent.internal]);
}
