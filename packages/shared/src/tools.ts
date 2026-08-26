/**
 * Tool definitions exposed to the AI model. These describe the *computer*
 * capabilities the model can invoke (they map 1:1 onto the Computer API in
 * the agent). Kept in shared so clients can render/describe them too.
 */

export interface ToolParamSpec {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  enum?: string[];
  required?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, ToolParamSpec>;
  /** Destructive tools are gated by the safety policy. */
  destructive: boolean;
}

export const COMPUTER_TOOLS: ToolDef[] = [
  {
    name: 'shell_exec',
    description:
      'Run a shell command on the Windows PC. Prefer PowerShell. Returns stdout, stderr and exit code. Never run interactive commands that block.',
    parameters: {
      command: { type: 'string', description: 'The command to execute.', required: true },
      shell: { type: 'string', description: 'powershell or cmd', enum: ['powershell', 'cmd'] },
      cwd: { type: 'string', description: 'Working directory (optional).' },
      timeoutMs: { type: 'number', description: 'Timeout in milliseconds (default 30000).' },
    },
    destructive: true,
  },
  {
    name: 'list_files',
    description: 'List files and folders in a directory on the PC.',
    parameters: {
      path: { type: 'string', description: 'Absolute directory path.', required: true },
    },
    destructive: false,
  },
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file from the PC.',
    parameters: {
      path: { type: 'string', description: 'Absolute file path.', required: true },
      maxBytes: { type: 'number', description: 'Max bytes to read (default 20000).' },
    },
    destructive: false,
  },
  {
    name: 'write_file',
    description: 'Write UTF-8 text to a file (creates parent folders).',
    parameters: {
      path: { type: 'string', description: 'Absolute file path.', required: true },
      content: { type: 'string', description: 'File contents.', required: true },
      append: { type: 'boolean', description: 'Append instead of overwrite.' },
    },
    destructive: true,
  },
  {
    name: 'delete_file',
    description: 'Delete a file or folder (use with care).',
    parameters: {
      path: { type: 'string', description: 'Absolute path to delete.', required: true },
      recursive: { type: 'boolean', description: 'Recursive for folders.' },
    },
    destructive: true,
  },
  {
    name: 'move_file',
    description: 'Move or rename a file/folder.',
    parameters: {
      from: { type: 'string', description: 'Source absolute path.', required: true },
      to: { type: 'string', description: 'Destination absolute path.', required: true },
    },
    destructive: true,
  },
  {
    name: 'launch_app',
    description: 'Launch an application or open a file/folder/URL.',
    parameters: {
      target: { type: 'string', description: 'Executable name, path, or URL.', required: true },
      args: { type: 'array', description: 'Optional argument list.' },
    },
    destructive: true,
  },
  {
    name: 'get_screen_size',
    description: 'Get the primary/virtual screen size in pixels.',
    parameters: {},
    destructive: false,
  },
  {
    name: 'screenshot',
    description: 'Capture the screen and return it (as data available to the caller).',
    parameters: {
      quality: { type: 'number', description: 'JPEG quality 10-100 (default 70).' },
    },
    destructive: false,
  },
  {
    name: 'mouse_move',
    description: 'Move the mouse cursor to an absolute pixel position.',
    parameters: {
      x: { type: 'number', description: 'X pixel.', required: true },
      y: { type: 'number', description: 'Y pixel.', required: true },
    },
    destructive: true,
  },
  {
    name: 'mouse_click',
    description: 'Click the mouse (left/right/middle) at the current or given position.',
    parameters: {
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Button.', required: true },
      x: { type: 'number', description: 'Optional X to move to first.' },
      y: { type: 'number', description: 'Optional Y to move to first.' },
      clicks: { type: 'number', description: 'Number of clicks (default 1).' },
    },
    destructive: true,
  },
  {
    name: 'mouse_scroll',
    description: 'Scroll the mouse wheel (positive = up).',
    parameters: {
      delta: { type: 'number', description: 'Wheel delta (e.g. 120 or -120).', required: true },
    },
    destructive: true,
  },
  {
    name: 'type_text',
    description: 'Type text with the keyboard at the focused control.',
    parameters: {
      text: { type: 'string', description: 'Text to type.', required: true },
    },
    destructive: true,
  },
  {
    name: 'key_press',
    description: 'Press a key or key combination (e.g. "enter", "ctrl+c").',
    parameters: {
      key: { type: 'string', description: 'Key name.', required: true },
      modifiers: { type: 'array', description: 'e.g. ["ctrl","shift"]' },
    },
    destructive: true,
  },
];

export function toolByName(name: string): ToolDef | undefined {
  return COMPUTER_TOOLS.find((t) => t.name === name);
}

export function describeToolCall(tool: string, input: unknown): string {
  try {
    const s = typeof input === 'string' ? input : JSON.stringify(input);
    const short = s.length > 120 ? s.slice(0, 120) + '…' : s;
    return `${tool}(${short})`;
  } catch {
    return tool;
  }
}
