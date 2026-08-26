import type { ToolDef } from '@mr-robot/shared';
import type { NeutralTool } from './provider.js';

/** Convert a shared ToolDef into the provider-neutral tool schema. */
export function neutralTool(def: ToolDef): NeutralTool {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, spec] of Object.entries(def.parameters)) {
    const prop: Record<string, unknown> = {
      type: spec.type,
      description: spec.description,
    };
    if (spec.enum) prop.enum = spec.enum;
    properties[name] = prop;
    if (spec.required) required.push(name);
  }
  return {
    name: def.name,
    description: def.description,
    parameters: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    },
  };
}

/** OpenAI-compatible `tools` array shape. */
export function toOpenAiTools(tools: NeutralTool[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** Anthropic `tools` array shape. */
export function toAnthropicTools(tools: NeutralTool[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}
