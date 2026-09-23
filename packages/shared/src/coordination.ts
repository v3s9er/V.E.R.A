/** Public, bounded worker progress. Never includes private prompts or tool arguments. */
export interface CoordinationAgent {
  agentId: string;
  label: string;
  providerId: string;
  model: string;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  sequence: number;
  turns: number;
  status: string;
  usage: { promptTokens: number; completionTokens: number };
}
