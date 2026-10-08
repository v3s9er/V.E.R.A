/** Runtime policy, not persisted user configuration. Legacy scenarios remain
 * editable/exportable but may not introduce another model execution owner. */
export const SINGLE_AGENT_HARNESS = Object.freeze({
  revision: 'single-agent-harness-v1',
  hostDelegation: false as boolean,
  nativeDelegation: false as boolean,
  finalCheckRepairs: 1,
});

export const SINGLE_AGENT_GUIDANCE = 'Execution ownership: you are the only agent for this task. Planning, evidence retrieval, verification, and knowledge tools are deterministic supporting services, not other agents. Do not spawn assistants, delegate through Agent/Task/collaboration tools, or launch another model through shell commands. Continue in this same conversation with the selected model. Inspect evidence, make scoped changes, and verify actual results before reporting completion.';

/** Fail before starting a native process, including stale direct API callers. */
export function assertSingleAgentRequest(request: { nativeDelegation?: unknown }): void {
  if (request.nativeDelegation !== undefined) throw new Error('단일 에이전트 하네스에서는 네이티브 보조 작업을 실행하지 않습니다.');
}

export function isAgentDelegationTool(name: string): boolean {
  return /^(?:agent_(?:spawn|list|wait|message|cancel)|spawn_agent|send_message|followup_task|wait_agent|interrupt_agent|list_agents|Agent|Task)$/.test(name);
}

export const SINGLE_AGENT_CODEX_CONFIG = Object.freeze({
  'agents.enabled': false,
  'features.multi_agent': false,
  'features.multi_agent_v2': false,
});

/** Agent is the current Claude tool; Task is its older delegation name.
 * Do not deny Bash/PowerShell or the separate task-tracking tools. */
export const SINGLE_AGENT_CLAUDE_ARGS = Object.freeze([
  '--disallowedTools', 'Agent,Task',
  '--settings', JSON.stringify({ fallbackModel: [], switchModelsOnFlag: false }),
]);
