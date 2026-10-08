import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { mrRobotHome } from '../config.js';

export const HARNESS_TOOL_VERSIONS = Object.freeze({ context7: '4.2.0', serena: '1.7.0' });

/** Include the approved executable's sibling tools (e.g. a venv's uv/uvx).
 * Do not inherit arbitrary host secrets or mutate the process environment. */
export function mcpChildEnvironment(command: string, base: Record<string, string>, extra: Record<string, string>) {
  const env = { ...base, ...extra };
  if (isAbsolute(command) && !Object.keys(extra).some(key => key.toLowerCase() === 'path')) {
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
    env[pathKey] = [dirname(command), env[pathKey]].filter(Boolean).join(delimiter);
  }
  return env;
}

/** Read-only discovery of explicitly installed private tools, never a PATH crawl,
 * package download, authentication flow or process launch. */
export function installedMcpPresets(home = mrRobotHome(), platform = process.platform) {
  const root = join(home, 'tools');
  return (['context7', 'serena'] as const).map(id => {
    const version = HARNESS_TOOL_VERSIONS[id];
    const base = join(root, `${id}-${version}`);
    const entry = id === 'context7'
      ? join(base, 'node_modules', '@upstash', 'context7-mcp', 'dist', 'index.js')
      : join(base, platform === 'win32' ? 'Scripts' : 'bin', platform === 'win32' ? 'serena.exe' : 'serena');
    try {
      if (!existsSync(entry)) return { id, version, installed: false };
      if (id === 'context7') {
        const pkg = JSON.parse(readFileSync(join(base, 'node_modules', '@upstash', 'context7-mcp', 'package.json'), 'utf8'));
        if (pkg.name !== '@upstash/context7-mcp' || pkg.version !== version) return { id, version, installed: false };
      } else if (platform === 'win32') {
        const metadata = readFileSync(join(base, 'Lib', 'site-packages', `serena_agent-${version}.dist-info`, 'METADATA'), 'utf8');
        if (!metadata.includes(`Version: ${version}\n`) && !metadata.includes(`Version: ${version}\r\n`)) return { id, version, installed: false };
        if (!existsSync(join(base, 'Scripts', 'uv.exe'))) return { id, version, installed: false };
      }
      return { id, version, installed: true, executablePath: realpathSync(entry) };
    } catch { return { id, version, installed: false }; }
  });
}
