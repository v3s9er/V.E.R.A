import type { PermissionMode, SafetySettings } from '@mr-robot/shared';
import { toolByName, describeToolCall } from '@mr-robot/shared';
import type { Computer } from '../computer/index.js';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ContextBroker } from '../context-broker.js';

export type ConfirmFn = (req: { tool: string; input: unknown; summary: string }) => Promise<boolean>;

export interface ToolExecutorOptions {
  computer: Computer;
  /** Live getter so safety-policy changes apply without recreating anything. */
  safety: () => SafetySettings;
  /** Falls through to plugin-registered AI tools for unknown tool names. */
  runPluginTool?: (name: string, params: unknown) => Promise<unknown>;
  pluginToolDestructive?: (name: string) => boolean;
  contextBroker?: ContextBroker;
}

/**
 * Maps an AI tool call onto the Computer API. This is the single choke point
 * where the safety policy (auto-run vs confirm) is enforced for every
 * destructive action, regardless of which model requested it.
 */
export class ToolExecutor {
  constructor(private readonly opts: ToolExecutorOptions) {}

  async execute(name: string, input: unknown, confirm?: ConfirmFn, permissionCap?: PermissionMode): Promise<string> {
    const def = toolByName(name);
    if (!def) {
      if (this.opts.runPluginTool) {
        const mode = permissionCap ?? this.opts.safety().mode;
        const destructive = this.opts.pluginToolDestructive?.(name) ?? true;
        if (destructive && mode === 'read-only') return JSON.stringify({ error: `${name} is blocked by read-only permission mode` });
        if (destructive && mode !== 'full') {
          if (!confirm) return JSON.stringify({ error: `approval required for plugin tool ${name}` });
          const approved = await confirm({ tool: name, input, summary: `플러그인 도구 ${name}` });
          if (!approved) return JSON.stringify({ cancelled: true, tool: name });
        }
        try {
          return JSON.stringify(await this.opts.runPluginTool(name, input ?? {}));
        } catch (err) {
          return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
        }
      }
      return JSON.stringify({ error: `unknown tool: ${name}` });
    }

    const mode = permissionCap ?? this.opts.safety().mode;
    if (def.destructive && mode === 'read-only') {
      return JSON.stringify({ error: `${name} is blocked by read-only permission mode` });
    }

    const workspaceAllowed = mode === 'workspace' && this.withinWorkspace(name, input);
    if (def.destructive && mode !== 'full' && !workspaceAllowed) {
      // No confirmation channel (e.g. plain REST chat) => fail closed.
      if (!confirm) return JSON.stringify({ error: `approval required for ${name} but no confirmation channel is available` });
      const approved = await confirm({ tool: name, input, summary: describeToolCall(name, input) });
      if (!approved) return JSON.stringify({ cancelled: true, tool: name });
    }

    return this.run(name, (input ?? {}) as Record<string, unknown>);
  }

  private withinWorkspace(name: string, input: unknown): boolean {
    if (!['write_file', 'delete_file', 'move_file'].includes(name)) return false;
    const roots = this.opts.safety().allowedRoots ?? [];
    if (roots.length === 0) return false;
    const body = (input ?? {}) as Record<string, unknown>;
    const paths = name === 'move_file' ? [body.from, body.to] : [body.path];
    return paths.every((value) => {
      if (typeof value !== 'string' || !isAbsolute(value)) return false;
      const target = resolve(value);
      return roots.some((root) => {
        const rel = relative(resolve(root), target);
        return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
      });
    });
  }

  private async run(name: string, i: Record<string, unknown>): Promise<string> {
    const c = this.opts.computer;
    try {
      let result: unknown;
      switch (name) {
        case 'shell_exec':
          result = await c.shell(String(i.command ?? ''), {
            shell: (i.shell as 'powershell' | 'cmd') ?? 'powershell',
            cwd: i.cwd ? String(i.cwd) : undefined,
            timeoutMs: typeof i.timeoutMs === 'number' ? i.timeoutMs : 30000,
            maxBytes: this.opts.safety().maxShellBytes,
          });
          break;
        case 'list_files':
          result = await c.fs.list(String(i.path ?? '.'));
          break;
        case 'read_file':
          result = this.opts.contextBroker
            ? this.opts.contextBroker.read(String(i.path), typeof i.maxBytes === 'number' ? i.maxBytes : this.opts.safety().maxReadBytes)
            : await c.fs.read(String(i.path), typeof i.maxBytes === 'number' ? i.maxBytes : this.opts.safety().maxReadBytes);
          break;
        case 'write_file': {
          const r = await c.fs.write(String(i.path), String(i.content ?? ''), Boolean(i.append));
          result = { ok: true, ...r };
          this.opts.contextBroker?.invalidate(String(i.path));
          break;
        }
        case 'delete_file':
          result = { ok: true, ...(await c.fs.delete(String(i.path), Boolean(i.recursive))) };
          this.opts.contextBroker?.invalidate(String(i.path));
          break;
        case 'move_file':
          result = { ok: true, ...(await c.fs.move(String(i.from), String(i.to))) };
          this.opts.contextBroker?.invalidate(String(i.from));
          this.opts.contextBroker?.invalidate(String(i.to));
          break;
        case 'launch_app': {
          const r = await c.app.launch(
            String(i.target),
            Array.isArray(i.args) ? i.args.map(String) : [],
          );
          result = { launched: r.ok, stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
          break;
        }
        case 'get_screen_size':
          result = await c.screen.size();
          break;
        case 'screenshot': {
          const f = await c.screen.capture(typeof i.quality === 'number' ? i.quality : 70);
          // The base64 payload is intentionally NOT returned to the model:
          // text models cannot see it. The human sees it in the UI instead.
          result = { captured: f.dataUrl.length > 0, width: f.width, height: f.height };
          break;
        }
        case 'mouse_move': {
          const x = Number(i.x);
          const y = Number(i.y);
          const r = await c.input.move(x, y);
          result = { moved: { x, y }, ok: r.ok };
          break;
        }
        case 'mouse_click': {
          const button = (i.button as 'left' | 'right' | 'middle') ?? 'left';
          const x = i.x !== undefined ? Number(i.x) : undefined;
          const y = i.y !== undefined ? Number(i.y) : undefined;
          const clicks = typeof i.clicks === 'number' ? i.clicks : 1;
          const r = await c.input.click(button, x, y, clicks);
          result = { clicked: button, ok: r.ok };
          break;
        }
        case 'mouse_scroll': {
          const delta = Number(i.delta ?? 0);
          const r = await c.input.scroll(delta);
          result = { scrolled: delta, ok: r.ok };
          break;
        }
        case 'type_text': {
          const r = await c.input.type(String(i.text ?? ''));
          result = { typed: true, ok: r.ok };
          break;
        }
        case 'key_press': {
          const r = await c.input.key(String(i.key), Array.isArray(i.modifiers) ? i.modifiers.map(String) : []);
          result = { pressed: i.key, ok: r.ok };
          break;
        }
        default:
          result = { error: `unimplemented tool: ${name}` };
      }
      return JSON.stringify(result);
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
    }
  }
}

const PERMISSION_ORDER: PermissionMode[] = ['read-only', 'ask', 'workspace', 'full'];
export function effectiveMode(globalMode: PermissionMode, cap?: PermissionMode): PermissionMode {
  if (!cap) return globalMode;
  return PERMISSION_ORDER[Math.min(PERMISSION_ORDER.indexOf(globalMode), PERMISSION_ORDER.indexOf(cap))];
}
