import type { NeutralTool } from '../ai/provider.js';
import type { PermissionMode } from '@mr-robot/shared';

/**
 * Host-created execution metadata. It is deliberately passed separately from
 * command params so an AI tool call cannot forge its workspace or approval.
 */
export interface PluginExecutionContext {
  readonly signal?: AbortSignal;
  readonly permissionMode: PermissionMode;
  readonly workspaceRoot?: string;
  readonly destructiveApproved: boolean;
  readonly approvalSource: 'not-required' | 'policy' | 'prompt' | 'run-capability';
}

export interface RegisterCommandOptions {
  description?: string;
  /** When true the command is also exposed to the AI as a callable tool. */
  tool?: boolean;
  /** Plugin commands are destructive by default and require the normal safety gate. */
  destructive?: boolean;
  /** Direct RPC calls require a locally authenticated administrator. */
  adminOnly?: boolean;
  /** Avoid exposing irrelevant tool schemas (and spending their prompt tokens). */
  toolWhen?: (userMessage: string) => boolean;
  /** JSON-schema parameters object for the AI tool (defaults to free-form object). */
  parameters?: Record<string, unknown>;
}

export interface PluginCommandDef {
  name: string;
  pluginId: string;
  handler: (params: unknown, execution?: PluginExecutionContext) => unknown | Promise<unknown>;
  description?: string;
  tool: boolean;
  destructive: boolean;
  adminOnly: boolean;
  toolWhen?: (userMessage: string) => boolean;
  parameters?: Record<string, unknown>;
}

/**
 * Global command table for plugin-registered commands. Commands are removed
 * in bulk when their owning plugin unloads, so a detached plugin can never
 * leave a dangling handler behind.
 */
export class PluginCommandRegistry {
  private commands = new Map<string, PluginCommandDef>();

  register(pluginId: string, name: string, handler: PluginCommandDef['handler'], opts: RegisterCommandOptions = {}): void {
    if (!/^[a-z0-9._-]+$/i.test(name)) throw new Error(`invalid command name: ${name}`);
    if (this.commands.has(name)) throw new Error(`command already registered: ${name}`);
    this.commands.set(name, {
      name,
      pluginId,
      handler,
      description: opts.description,
      tool: opts.tool === true,
      destructive: opts.destructive !== false,
      adminOnly: opts.adminOnly === true,
      toolWhen: opts.toolWhen,
      parameters: opts.parameters,
    });
  }

  get(name: string): PluginCommandDef | undefined {
    return this.commands.get(name);
  }

  list(pluginId?: string): PluginCommandDef[] {
    return [...this.commands.values()].filter((c) => (pluginId ? c.pluginId === pluginId : true));
  }

  unregisterAll(pluginId: string): void {
    for (const [name, c] of this.commands) if (c.pluginId === pluginId) this.commands.delete(name);
  }

  aiTools(userMessage = ''): NeutralTool[] {
    return [...this.commands.values()]
      .filter((c) => c.tool && (!c.toolWhen || c.toolWhen(userMessage)))
      .map((c) => ({
        name: c.name,
        description: c.description ?? `Plugin command ${c.name}`,
        parameters: c.parameters ?? {
          type: 'object',
          properties: { input: { type: 'object', description: 'Free-form input object' } },
        },
      }));
  }
}
