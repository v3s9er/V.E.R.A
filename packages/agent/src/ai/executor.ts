import type { PermissionMode, SafetySettings } from '@mr-robot/shared';
import { toolByName, describeToolCall } from '@mr-robot/shared';
import type { Computer } from '../computer/index.js';
import type { ContextBroker } from '../context-broker.js';
import type { PluginExecutionContext } from '../plugins/commands.js';
import { resolveWorkspacePath } from '../path-security.js';

export type ConfirmFn = (req: { tool: string; input: unknown; summary: string }) => Promise<boolean>;

export interface ToolExecutorOptions {
  computer: Computer;
  /** Live getter so safety-policy changes apply without recreating anything. */
  safety: () => SafetySettings;
  /** Falls through to plugin-registered AI tools for unknown tool names. */
  runPluginTool?: (name: string, params: unknown, execution: PluginExecutionContext) => Promise<unknown>;
  pluginToolDestructive?: (name: string) => boolean;
  contextBroker?: ContextBroker;
}

export interface ToolExecutionScope {
  /** Selected workspace resolved by the host, never by model-supplied params. */
  workspaceRoot?: string;
  /** Tool names covered by a host-side aggregate approval for this run only. */
  approvedPluginTools?: ReadonlySet<string>;
}

const MAX_TOOL_RESULT_BYTES = 384 * 1024;

function serializeToolResult(result: unknown): string {
  const serialized = JSON.stringify(result ?? null);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes <= MAX_TOOL_RESULT_BYTES) return serialized;
  return JSON.stringify({
    error: '도구 결과가 384KB 컨텍스트 한도를 초과했습니다. 전체 결과를 작업 폴더 파일로 저장하고 필요한 부분만 읽으세요.',
    outputBytes: bytes,
  });
}

/**
 * Maps an AI tool call onto the Computer API. This is the single choke point
 * where the safety policy (auto-run vs confirm) is enforced for every
 * destructive action, regardless of which model requested it.
 */
export class ToolExecutor {
  constructor(private readonly opts: ToolExecutorOptions) {}

  async execute(
    name: string,
    input: unknown,
    confirm?: ConfirmFn,
    permissionCap?: PermissionMode,
    signal?: AbortSignal,
    scope?: ToolExecutionScope,
  ): Promise<string> {
    signal?.throwIfAborted();
    const def = toolByName(name);
    if (!def) {
      if (this.opts.runPluginTool) {
        const mode = effectiveMode(this.opts.safety().mode, permissionCap);
        const destructive = this.opts.pluginToolDestructive?.(name) ?? true;
        let destructiveApproved = !destructive || mode === 'full';
        let approvalSource: PluginExecutionContext['approvalSource'] = destructive
          ? mode === 'full' ? 'policy' : 'prompt'
          : 'not-required';
        if (destructive && mode === 'read-only') return JSON.stringify({ error: `${name} is blocked by read-only permission mode` });
        if (destructive && mode !== 'full' && scope?.approvedPluginTools?.has(name) !== true) {
          if (!confirm) return JSON.stringify({ error: `approval required for plugin tool ${name}` });
          const approved = await confirm({ tool: name, input, summary: `플러그인 도구 ${name}` });
          if (!approved) return JSON.stringify({ cancelled: true, tool: name });
          destructiveApproved = true;
        } else if (destructive && scope?.approvedPluginTools?.has(name) === true) {
          destructiveApproved = true;
          approvalSource = 'run-capability';
        }
        try {
          const result = await this.opts.runPluginTool(name, input ?? {}, {
            signal,
            permissionMode: mode,
            workspaceRoot: scope?.workspaceRoot,
            destructiveApproved,
            approvalSource,
          });
          signal?.throwIfAborted();
          return serializeToolResult(result);
        } catch (err) {
          if (signal?.aborted) throw signal.reason ?? err;
          return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
        }
      }
      return JSON.stringify({ error: `unknown tool: ${name}` });
    }

    const mode = effectiveMode(this.opts.safety().mode, permissionCap);
    if (def.destructive && mode === 'read-only') {
      return JSON.stringify({ error: `${name} is blocked by read-only permission mode` });
    }

    let securedInput = (input ?? {}) as Record<string, unknown>;
    try {
      securedInput = this.confineFileTool(name, securedInput, mode, scope?.workspaceRoot);
    } catch (error) {
      return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
    }

    // Workspace mode auto-approves only file mutations that have already
    // passed the selected workspace's canonical path boundary above.
    const workspaceAllowed = mode === 'workspace' && ['write_file', 'delete_file', 'move_file'].includes(name);
    if (def.destructive && mode !== 'full' && !workspaceAllowed) {
      // No confirmation channel (e.g. plain REST chat) => fail closed.
      if (!confirm) return JSON.stringify({ error: `approval required for ${name} but no confirmation channel is available` });
      const approved = await confirm({ tool: name, input: securedInput, summary: describeToolCall(name, securedInput) });
      if (!approved) return JSON.stringify({ cancelled: true, tool: name });
    }

    return this.run(name, securedInput, signal);
  }

  private confineFileTool(
    name: string,
    input: Record<string, unknown>,
    mode: PermissionMode,
    workspaceRoot?: string,
  ): Record<string, unknown> {
    if (mode === 'full' || !['list_files', 'read_file', 'write_file', 'delete_file', 'move_file'].includes(name)) {
      return input;
    }
    if (!workspaceRoot) throw new Error('파일 도구를 사용하려면 이 대화에서 작업 폴더를 선택하세요.');
    if (name === 'move_file') {
      return {
        ...input,
        from: resolveWorkspacePath(workspaceRoot, input.from),
        to: resolveWorkspacePath(workspaceRoot, input.to, { mustExist: false }),
      };
    }
    return {
      ...input,
      path: resolveWorkspacePath(workspaceRoot, input.path, {
        mustExist: name !== 'write_file',
      }),
    };
  }

  private async run(name: string, i: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const c = this.opts.computer;
    try {
      signal?.throwIfAborted();
      let result: unknown;
      switch (name) {
        case 'shell_exec':
          result = await c.shell(String(i.command ?? ''), {
            shell: (i.shell as 'powershell' | 'cmd') ?? 'powershell',
            cwd: i.cwd ? String(i.cwd) : undefined,
            timeoutMs: typeof i.timeoutMs === 'number' ? i.timeoutMs : 30000,
            maxBytes: this.opts.safety().maxShellBytes,
            signal,
          });
          break;
        case 'list_files':
          result = await c.fs.list(String(i.path ?? '.'));
          break;
        case 'read_file': {
          const requested = typeof i.maxBytes === 'number' && Number.isFinite(i.maxBytes)
            ? Math.max(1, Math.floor(i.maxBytes))
            : this.opts.safety().maxReadBytes;
          const maxBytes = Math.min(requested, this.opts.safety().maxReadBytes);
          result = this.opts.contextBroker
            ? this.opts.contextBroker.read(String(i.path), maxBytes)
            : await c.fs.read(String(i.path), maxBytes);
          break;
        }
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
      signal?.throwIfAborted();
      return serializeToolResult(result);
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err;
      return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
    }
  }
}

const PERMISSION_ORDER: PermissionMode[] = ['read-only', 'ask', 'workspace', 'full'];
export function effectiveMode(globalMode: PermissionMode, cap?: PermissionMode): PermissionMode {
  if (!cap) return globalMode;
  return PERMISSION_ORDER[Math.min(PERMISSION_ORDER.indexOf(globalMode), PERMISSION_ORDER.indexOf(cap))];
}
