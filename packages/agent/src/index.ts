import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AgentServer, VERSION } from './server/server.js';

export { AgentServer, VERSION } from './server/server.js';
export { computer } from './computer/index.js';

interface CliArgs {
  port?: number;
  host?: string;
  webDir?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' && argv[i + 1]) args.port = Number(argv[++i]);
    else if (a === '--host' && argv[i + 1]) args.host = argv[++i];
    else if (a === '--web-dir' && argv[i + 1]) args.webDir = argv[++i];
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const server = new AgentServer();

  // Serve the built web UI when it exists next to this package.
  const here = dirname(fileURLToPath(import.meta.url));
  const defaultWeb = resolve(here, '..', '..', 'web', 'dist');
  const webDir = args.webDir ?? (existsSync(defaultWeb) ? defaultWeb : undefined);

  const { host, port } = await server.start({ port: args.port, host: args.host, webDir });
  const pairing = server.pairingInfo(false, true);

  console.log(`Mr.Robot agent v${VERSION}`);
  console.log(`  web UI : http://127.0.0.1:${port}`);
  console.log(`  pairing: one-use PIN ${pairing.pin ?? '------'} (expires in 5 minutes)`);
  if (pairing.host !== '127.0.0.1') console.log(`  secure route: http://${pairing.host}:${port} (Tailscale)`);
  console.log('  mobile : start Cloudflare Quick Link in the plugin screen, or enable the optional Tailscale route.');

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log('\nshutting down…');
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entry) {
  void main().catch((err) => {
    console.error('fatal:', err);
    process.exit(1);
  });
}
