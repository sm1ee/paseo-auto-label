import { describe, expect, it } from "vitest";
import { agentFingerprint, labelForAgent, labelsForWorkspace, type AgentMetadata } from "./model";

const agent: AgentMetadata = { id: "session-a", workspaceId: "workspace-a", provider: "codex", model: "model-a", thinkingOptionId: "high" };

describe("configuration labels", () => {
  it("uses selected values before older runtime values", () => {
    expect(labelForAgent({ ...agent, runtimeInfo: { model: "old-model", thinkingOptionId: "low" } }).name).toBe("codex · model-a · high");
  });
  it("uses effective effort and reported runtime fallbacks", () => {
    expect(labelForAgent({ ...agent, model: null, thinkingOptionId: null, effectiveThinkingOptionId: "max", runtimeInfo: { model: "runtime-model", thinkingOptionId: "low" } }).name).toBe("codex · runtime-model · max");
  });
  it("marks missing values instead of guessing defaults", () => {
    expect(labelForAgent({ ...agent, model: null, thinkingOptionId: null }).name).toBe("codex · model unknown · effort unknown");
  });
  it("keeps the complete model ID and native effort ID", () => {
    expect(labelForAgent({ ...agent, provider: "omp", model: "gateway/vendor/model-name", thinkingOptionId: "xhigh" }).name).toBe("omp · gateway/vendor/model-name · xhigh");
  });
  it("groups identical configurations and excludes child, archived, and internal sessions", () => {
    const agents = [agent, { ...agent, id: "same" }, { ...agent, id: "child", parentAgentId: "parent", model: "child-model" }, { ...agent, id: "archived", archived: true, model: "archived-model" }, { ...agent, id: "internal", internal: true, model: "internal-model" }, { ...agent, id: "other", workspaceId: "other-workspace" }];
    expect(labelsForWorkspace("workspace-a", agents, false).map(({ name }) => name)).toEqual(["codex · model-a · high"]);
    expect(labelsForWorkspace("workspace-a", agents, true)).toHaveLength(2);
  });
  it("notices an effort switch, a parent change, and an archive", () => {
    for (const update of [{ thinkingOptionId: "max" }, { parentAgentId: "parent" }, { archived: true }]) expect(agentFingerprint({ ...agent, ...update })).not.toBe(agentFingerprint(agent));
  });
});
