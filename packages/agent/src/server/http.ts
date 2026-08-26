import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type {
  AppSettings,
  PermissionMode,
  PluginInfo,
  ProviderAddInput,
  ProviderInfo,
  SystemStatus,
  WorkspaceInfo,
} from '@mr-robot/shared';
import { mrRobotHome } from '../config.js';

export interface PairingInfo {
  deviceName: string;
  host: string;
  hosts: string[];
  port: number;
  pin: string;
  maskedSecret: string;
  qrPayload: string;
  localSecret?: string;
}

/** What the HTTP layer needs from the agent core (implemented by AgentServer). */
export interface HttpApiHost {
  verifySecret(secret: string): boolean;
  isAdminSecret(secret: string): boolean;
  pairingInfo(includeLocalSecret?: boolean): PairingInfo;
  exchangePin(pin: string, deviceName?: string, permissionCap?: PermissionMode): { ok: boolean; secret?: string; linkId?: string; error?: string };
  status(): SystemStatus;
  getSettings(): AppSettings;
  updateSettings(patch: Partial<AppSettings>): AppSettings;
  providersList(): ProviderInfo[];
  providersAdd(input: ProviderAddInput): ProviderInfo;
  providersRemove(id: string): void;
  providersSetDefault(id: string): void;
  providersTest(id: string): Promise<{ ok: boolean; error?: string }>;
  pluginsList(): PluginInfo[];
  pluginsLoad(source: string): Promise<PluginInfo>;
  pluginsUnload(id: string): Promise<boolean>;
  pluginsCall(name: string, params: unknown): Promise<unknown>;
  chatOnce(text: string): Promise<{ text: string }>;
  syncSnapshot(): { version: number; deviceName: string; exportedAt: number; conversations: unknown[]; routingPresets: unknown[] };
  mergeSyncSnapshot(snapshot: unknown): { conversations: { added: number; updated: number; unchanged: number }; routingPresets: { added: number; updated: number; unchanged: number } };
  workspacesList(): WorkspaceInfo[];
  fileAccess(secret: string, write: boolean): boolean;
}

export function isLoopback(remote: string): boolean {
  const r = remote.replace(/^::ffff:/, '');
  return r === '127.0.0.1' || r === '::1' || r === 'localhost';
}

function remoteOf(req: Request): string {
  return String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
}

export function createHttpApi(host: HttpApiHost, webDir?: string): Express {
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  const sharedRoot = resolve(mrRobotHome(), 'shared');
  mkdirSync(sharedRoot, { recursive: true });

  // CORS: LAN-friendly; real security is the pairing token, not the origin.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, content-length, x-mr-robot-token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'content-disposition, content-length, x-mr-robot-file-name');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  const authed = (req: Request): boolean => host.verifySecret(String(req.header('x-mr-robot-token') ?? ''));
  const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
    if (authed(req)) {
      next();
      return;
    }
    res.status(401).json({ error: 'unauthorized' });
  };
  const requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
    if (host.isAdminSecret(String(req.header('x-mr-robot-token') ?? ''))) { next(); return; }
    res.status(403).json({ error: 'administrator permission required' });
  };

  app.get('/api/ping', (_req, res) => {
    res.json({ ok: true, app: 'mr-robot' });
  });

  // Pairing info: the PC's own UI (loopback) or an already-authenticated client.
  app.get('/api/pairing', (req, res) => {
    if (!authed(req) && !isLoopback(remoteOf(req))) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    res.json(host.pairingInfo(isLoopback(remoteOf(req))));
  });

  // Exchange the short PIN for the long-lived secret (rate-limited).
  app.post('/api/pair', (req, res) => {
    const pin = String(req.body?.pin ?? '').trim();
    const name = String(req.body?.deviceName ?? '연결된 기기');
    const requested = String(req.body?.permissionCap ?? 'ask') as PermissionMode;
    const result = host.exchangePin(pin, name, requested);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ secret: result.secret, linkId: result.linkId });
  });

  app.get('/api/status', requireAuth, (_req, res) => {
    res.json(host.status());
  });

  const sharedPath = (value: unknown): string => {
    const requested = String(value ?? '').replaceAll('\\', '/').replace(/^\/+/, '');
    const target = resolve(sharedRoot, requested);
    const rel = relative(sharedRoot, target);
    if (rel.startsWith('..') || rel.includes(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
      throw new Error('공유 폴더 밖의 경로는 사용할 수 없습니다.');
    }
    return target;
  };
  const workspacePath = (workspaceId: unknown, value: unknown): { workspace: WorkspaceInfo; target: string } => {
    const workspace = host.workspacesList().find((item) => item.id === String(workspaceId ?? ''));
    if (!workspace) throw new Error('작업 폴더를 찾을 수 없습니다.');
    const requested = String(value ?? '').replaceAll('\\', '/').replace(/^\/+/, '');
    const root = resolve(workspace.path);
    const target = resolve(root, requested);
    const rel = relative(root, target);
    if (rel.startsWith('..') || (rel !== '' && resolve(root, rel) !== target)) throw new Error('작업 폴더 밖의 경로는 사용할 수 없습니다.');
    return { workspace, target };
  };
  const requireFileAccess = (write: boolean) => (req: Request, res: Response, next: NextFunction): void => {
    const token = String(req.header('x-mr-robot-token') ?? '');
    if (host.fileAccess(token, write)) { next(); return; }
    res.status(403).json({ error: write ? '이 기기에는 작업 폴더 쓰기 권한이 없습니다.' : '이 기기에는 작업 폴더 읽기 권한이 없습니다.' });
  };

  app.get('/api/workspaces', requireAuth, (_req, res) => res.json(host.workspacesList()));
  app.get('/api/workspaces/files', requireFileAccess(false), (req, res) => {
    try {
      const { workspace, target } = workspacePath(req.query.workspaceId, req.query.path);
      if (!statSync(target).isDirectory()) throw new Error('폴더가 아닙니다.');
      const items = readdirSync(target, { withFileTypes: true }).map((entry) => {
        const full = join(target, entry.name); const stat = statSync(full);
        return { name: entry.name, path: relative(workspace.path, full).replaceAll('\\', '/'), isDirectory: entry.isDirectory(), size: entry.isFile() ? stat.size : 0, modifiedAt: stat.mtimeMs };
      }).sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
      res.json({ workspace, path: relative(workspace.path, target).replaceAll('\\', '/'), items });
    } catch (err) { res.status(400).json({ error: err instanceof Error ? err.message : String(err) }); }
  });
  app.get('/api/workspaces/download', requireFileAccess(false), (req, res) => {
    try {
      const { target } = workspacePath(req.query.workspaceId, req.query.path); const stat = statSync(target);
      if (!stat.isFile()) throw new Error('다운로드할 파일이 아닙니다.');
      const name = basename(target).replace(/[\r\n"]/g, '_');
      res.setHeader('Content-Type', 'application/octet-stream'); res.setHeader('Content-Length', String(stat.size));
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
      createReadStream(target).on('error', () => res.destroy()).pipe(res);
    } catch (err) { res.status(404).json({ error: err instanceof Error ? err.message : String(err) }); }
  });
  app.put('/api/workspaces/upload', requireFileAccess(true), async (req, res) => {
    let temp = '';
    try {
      const length = Number(req.header('content-length') ?? 0);
      if (length > 2 * 1024 * 1024 * 1024) throw new Error('파일은 최대 2GB까지 전송할 수 있습니다.');
      const { workspace, target } = workspacePath(req.query.workspaceId, req.query.path);
      mkdirSync(dirname(target), { recursive: true }); temp = `${target}.upload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await pipeline(req, createWriteStream(temp, { flags: 'wx' })); renameSync(temp, target);
      res.json({ ok: true, name: basename(target), path: relative(workspace.path, target).replaceAll('\\', '/'), size: statSync(target).size });
    } catch (err) { if (temp && existsSync(temp)) unlinkSync(temp); res.status(400).json({ error: err instanceof Error ? err.message : String(err) }); }
  });

  // Token-free AI usage: these routes stream bytes directly between paired devices.
  // They intentionally expose only ~/.mr-robot/shared, never the whole PC filesystem.
  app.get('/api/files', requireAuth, (req, res) => {
    try {
      const dir = sharedPath(req.query.path);
      mkdirSync(dir, { recursive: true });
      const items = readdirSync(dir, { withFileTypes: true }).map((entry) => {
        const full = join(dir, entry.name);
        const stat = statSync(full);
        return {
          name: entry.name,
          path: relative(sharedRoot, full).replaceAll('\\', '/'),
          isDirectory: entry.isDirectory(),
          size: entry.isFile() ? stat.size : 0,
          modifiedAt: stat.mtimeMs,
        };
      }).sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
      res.json({ root: 'Mr.Robot 공유함', path: relative(sharedRoot, dir).replaceAll('\\', '/'), items });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/files/download', requireAuth, (req, res) => {
    try {
      const file = sharedPath(req.query.path);
      const stat = statSync(file);
      if (!stat.isFile()) throw new Error('다운로드할 파일이 아닙니다.');
      const name = basename(file).replace(/[\r\n"]/g, '_');
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(stat.size));
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
      res.setHeader('X-Mr-Robot-File-Name', encodeURIComponent(name));
      createReadStream(file).on('error', () => res.destroy()).pipe(res);
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.put('/api/files/upload', requireAuth, async (req, res) => {
    let temp = '';
    try {
      const length = Number(req.header('content-length') ?? 0);
      if (length > 2 * 1024 * 1024 * 1024) throw new Error('파일은 최대 2GB까지 전송할 수 있습니다.');
      const file = sharedPath(req.query.path);
      mkdirSync(dirname(file), { recursive: true });
      temp = `${file}.upload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await pipeline(req, createWriteStream(temp, { flags: 'wx' }));
      renameSync(temp, file);
      const stat = statSync(file);
      res.json({ ok: true, name: basename(file), path: relative(sharedRoot, file).replaceAll('\\', '/'), size: stat.size });
    } catch (err) {
      if (temp && existsSync(temp)) unlinkSync(temp);
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/files/pull', requireAuth, async (req, res) => {
    let temp = '';
    try {
      const sourceBase = new URL(String(req.body?.sourceBase ?? ''));
      if (!['http:', 'https:'].includes(sourceBase.protocol)) throw new Error('원본 PC 주소가 올바르지 않습니다.');
      const sourcePath = String(req.body?.sourcePath ?? '');
      const target = sharedPath(req.body?.targetPath || basename(sourcePath));
      const sourceUrl = new URL('/api/files/download', sourceBase);
      sourceUrl.searchParams.set('path', sourcePath);
      const upstream = await fetch(sourceUrl, { headers: { 'x-mr-robot-token': String(req.body?.sourceSecret ?? '') } });
      if (!upstream.ok || !upstream.body) throw new Error(`원본 PC 파일을 열 수 없습니다. (HTTP ${upstream.status})`);
      const length = Number(upstream.headers.get('content-length') ?? 0);
      if (length > 2 * 1024 * 1024 * 1024) throw new Error('파일은 최대 2GB까지 전송할 수 있습니다.');
      mkdirSync(dirname(target), { recursive: true });
      temp = `${target}.pull-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await pipeline(Readable.fromWeb(upstream.body as never), createWriteStream(temp, { flags: 'wx' }));
      renameSync(temp, target);
      const stat = statSync(target);
      res.json({ ok: true, path: relative(sharedRoot, target).replaceAll('\\', '/'), size: stat.size, transport: 'direct-device-stream' });
    } catch (err) {
      if (temp && existsSync(temp)) unlinkSync(temp);
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/sync/snapshot', requireAuth, (_req, res) => {
    res.json(host.syncSnapshot());
  });

  app.post('/api/sync/pull', requireAuth, async (req, res) => {
    try {
      const sourceBase = new URL(String(req.body?.sourceBase ?? ''));
      if (!['http:', 'https:'].includes(sourceBase.protocol)) throw new Error('동기화 원본 PC 주소가 올바르지 않습니다.');
      const sourceUrl = new URL('/api/sync/snapshot', sourceBase);
      const upstream = await fetch(sourceUrl, { headers: { 'x-mr-robot-token': String(req.body?.sourceSecret ?? '') } });
      if (!upstream.ok) throw new Error(`원본 PC 동기화 데이터를 읽을 수 없습니다. (HTTP ${upstream.status})`);
      const length = Number(upstream.headers.get('content-length') ?? 0);
      if (length > 64 * 1024 * 1024) throw new Error('동기화 데이터가 64MB를 초과합니다.');
      const result = host.mergeSyncSnapshot(await upstream.json());
      res.json({ ok: true, ...result, transport: 'direct-device-sync', aiTokens: 0 });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/files', requireAuth, (req, res) => {
    try {
      const file = sharedPath(req.query.path);
      if (!statSync(file).isFile()) throw new Error('파일만 삭제할 수 있습니다.');
      unlinkSync(file);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  app.get('/api/settings', requireAuth, (_req, res) => {
    res.json(host.getSettings());
  });
  app.put('/api/settings', requireAdmin, (req, res) => {
    res.json(host.updateSettings(req.body ?? {}));
  });

  app.get('/api/providers', requireAuth, (_req, res) => {
    res.json(host.providersList());
  });
  app.post('/api/providers', requireAdmin, (req, res) => {
    res.json(host.providersAdd(req.body ?? {}));
  });
  app.delete('/api/providers/:id', requireAdmin, (req, res) => {
    host.providersRemove(String(req.params.id));
    res.json({ ok: true });
  });
  app.post('/api/providers/:id/default', requireAdmin, (req, res) => {
    host.providersSetDefault(String(req.params.id));
    res.json({ ok: true });
  });
  app.get('/api/providers/test/:id', requireAuth, async (req, res) => {
    res.json(await host.providersTest(String(req.params.id)));
  });

  app.get('/api/plugins', requireAuth, (_req, res) => {
    res.json(host.pluginsList());
  });
  app.post('/api/plugins/load', requireAdmin, async (req, res) => {
    try {
      res.json(await host.pluginsLoad(String(req.body?.path ?? '')));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  app.post('/api/plugins/unload', requireAdmin, async (req, res) => {
    res.json({ ok: await host.pluginsUnload(String(req.body?.id ?? '')) });
  });
  app.post('/api/plugins/call', requireAuth, async (req, res) => {
    try {
      res.json(await host.pluginsCall(String(req.body?.name ?? ''), req.body?.params));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/chat', requireAuth, async (req, res) => {
    try {
      res.json(await host.chatOnce(String(req.body?.text ?? '')));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Static web UI (built packages/web). SPA fallback for non-API GETs.
  if (webDir && existsSync(join(webDir, 'index.html'))) {
    app.use(express.static(webDir));
    app.use((req, res, next) => {
      if (req.method === 'GET' && !req.path.startsWith('/api')) {
        res.sendFile(join(webDir, 'index.html'));
        return;
      }
      next();
    });
  } else {
    app.get('/', (_req, res) => {
      res
        .status(200)
        .type('text/plain')
        .send('Mr.Robot agent is running. Build packages/web for the UI, or connect with the mobile app.');
    });
  }

  return app;
}
