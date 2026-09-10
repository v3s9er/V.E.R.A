/** Mr.Robot desktop adapter. This module contains no browser UI or page content. */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ID = 'page-publisher';
const root = dirname(fileURLToPath(import.meta.url)).replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked');
const environmentKeys = ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'HOME', 'LANG'];

function text(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\0\r\n]/.test(value)) throw new Error(`Invalid ${label}`);
  return value.trim();
}

function localPath(value, label) {
  const path = text(value, label);
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute local path`);
  return resolve(path);
}

export function createPagePublisherPlugin(runtime = {}) {
  const launch = runtime.spawn ?? spawn;
  const environment = runtime.env ?? process.env;
  const library = resolve(environment.MR_ROBOT_HOME || join(homedir(), '.mr-robot'));
  const scriptRoot = runtime.scriptRoot ?? join(root, 'scripts');
  const children = new Set();
  let ctx, enabled = false, preview = null, pending = Promise.resolve(), generation = 0;

  const state = () => ({ enabled, running: children.size, previewUrl: preview?.url ?? null, library, publishing: 'manual', defaultEnabled: false });
  const requireEnabled = () => { if (!enabled) throw new Error('Page Publisher 플러그인이 꺼져 있습니다.'); };
  const cancelAll = () => {
    generation += 1;
    for (const child of children) child.kill();
    preview = null;
  };
  const childEnvironment = () => {
    const result = { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' };
    for (const key of environmentKeys) if (environment[key]) result[key] = environment[key];
    return result;
  };
  const python = () => {
    const configured = ctx.storage.get('pythonPath') || environment.MR_ROBOT_PYTHON;
    return configured ? localPath(configured, 'Python executable') : 'python';
  };

  function execute(script, args, execution, persistent = false) {
    requireEnabled();
    execution?.signal?.throwIfAborted();
    return new Promise((resolveResult, reject) => {
      let child, stdout = '', stderr = '', settled = false, url;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        ctx.clearTimeout(timer);
        if (!persistent || error) execution?.signal?.removeEventListener('abort', abort);
        if (error) { child?.kill(); reject(error); } else resolveResult(result);
      };
      const abort = () => { child?.kill(); finish(new Error('Page Publisher 작업이 취소되었습니다.')); };
      const timer = ctx.setTimeout(() => finish(new Error('Page Publisher 작업 시간이 초과됐습니다.')), persistent ? 10_000 : 60_000);
      try {
        child = launch(python(), [join(scriptRoot, script), ...args], {
          shell: false, windowsHide: true, env: childEnvironment(), stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) { finish(error); return; }
      children.add(child);
      execution?.signal?.addEventListener('abort', abort, { once: true });
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        stdout += chunk;
        if (stdout.length > 2 * 1024 * 1024) { finish(new Error('Page Publisher 응답이 너무 큽니다.')); return; }
        if (persistent && !settled) {
          const match = stdout.match(/ at (http:\/\/127\.0\.0\.1:\d+\/)\r?\n/);
          if (match) {
            url = match[1];
            preview = { child, url };
            finish(null, { url });
          }
        }
      });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
      child.once('error', () => {
        children.delete(child);
        execution?.signal?.removeEventListener('abort', abort);
        finish(new Error('Python 실행 실패: Python 3.10 이상 설치 또는 Python 경로 설정을 확인하세요.'));
      });
      child.once('close', code => {
        children.delete(child);
        execution?.signal?.removeEventListener('abort', abort);
        if (preview?.child === child) preview = null;
        if (settled) return;
        if (code !== 0) { finish(new Error(`Page Publisher 실패 (${code}): ${stderr.trim()}`)); return; }
        if (persistent) { finish(new Error('미리보기가 시작되기 전에 종료됐습니다.')); return; }
        try { finish(null, JSON.parse(stdout)); } catch { finish(new Error('Page Publisher 응답 형식이 올바르지 않습니다.')); }
      });
    });
  }

  function serialized(script, args, execution) {
    // Prevent concurrent saves/restores from replacing one another's snapshots.
    const scheduledGeneration = generation;
    const run = pending.then(() => {
      if (scheduledGeneration !== generation) throw new Error('Page Publisher 대기 작업이 취소되었습니다.');
      return execute(script, args, execution);
    });
    pending = run.catch(() => {});
    return run;
  }

  const site = params => {
    const value = text(params?.site, 'site');
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(value)) throw new Error('Use a lowercase site slug (letters, digits, hyphens).');
    return value;
  };
  const schema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
  const string = description => ({ type: 'string', description });
  const siteProperty = { site: string('Saved page slug') };

  return {
    manifest: {
      id: ID, name: '페이지 게시 · Page Publisher', version: '0.1.0', category: 'development', kind: 'workflow',
      enabledByDefault: false,
      description: '페이지 저장·수정 이력·복원·로컬 미리보기·Worker 패키징. 기본 OFF, 외부 게시는 별도 요청 시 실행합니다.',
      permissions: ['process.execute', 'filesystem.read', 'filesystem.write', 'network.listen'],
    },
    activate(context) {
      ctx = context;
      const register = (suffix, handler, description, parameters, destructive = true, tool = true) => {
        ctx.registerCommand(`${ID}.${suffix}`, handler, { description, parameters, destructive, tool, adminOnly: true });
      };
      const manager = (args, execution) => serialized('site_manager.py', ['--root', library, ...args], execution);
      register('status', state, '페이지 게시 모듈 상태', schema(), false, false);
      register('config.get', () => ({ pythonPath: ctx.storage.get('pythonPath') ?? null, library }), 'Python 경로 조회', schema(), false, false);
      register('config.set', params => {
        const value = params?.pythonPath == null ? null : localPath(params.pythonPath, 'Python executable');
        ctx.storage.set('pythonPath', value);
        return { pythonPath: value, library };
      }, 'Python 실행 파일 경로 설정', schema({ pythonPath: { type: ['string', 'null'] } }, ['pythonPath']), true, false);
      register('list', (_, execution) => manager(['list', '--json'], execution), '저장된 페이지 목록', schema(), false);
      for (const action of ['show', 'history']) register(action, (params, execution) => manager([action, site(params)], execution), `페이지 ${action}`, schema(siteProperty, ['site']), false);
      register('save', (params, execution) => {
        const args = ['save', site(params), localPath(params?.source, 'Page source')];
        if (params?.title != null) args.push('--title', text(params.title, 'title'));
        return manager(args, execution);
      }, '로컬 페이지 저장 또는 수정 (기존 소스는 이력에 보관)', schema({ ...siteProperty, source: string('Absolute local page source path'), title: string('Page title') }, ['site', 'source']));
      register('restore-revision', (params, execution) => manager(['restore-revision', site(params), text(params?.revision, 'revision')], execution), '페이지 수정 이력 복원', schema({ ...siteProperty, revision: string('Revision from history') }, ['site', 'revision']));
      register('delete', (params, execution) => {
        if (params?.confirmed !== true) throw new Error('페이지를 휴지통으로 이동하려면 confirmed=true가 필요합니다.');
        return manager(['delete', site(params), '--yes'], execution);
      }, '페이지를 복구 가능한 휴지통으로 이동', schema({ ...siteProperty, confirmed: { type: 'boolean', const: true } }, ['site', 'confirmed']));
      register('restore', (params, execution) => manager(['restore', site(params)], execution), '휴지통 페이지 복구', schema(siteProperty, ['site']));
      register('build', (params, execution) => {
        const slug = site(params);
        const output = join(library, 'page-publisher-builds', slug);
        const args = [join(library, 'sites', slug, 'source'), '--output', output, '--name', slug];
        if (params?.spa === true) args.push('--spa');
        return serialized('build_worker.py', args, execution);
      }, '로컬 Worker 번들 생성 (배포하지 않음)', schema({ ...siteProperty, spa: { type: 'boolean' } }, ['site']));
      register('preview.start', async (params, execution) => {
        if (preview || children.size) throw new Error('진행 중인 작업 또는 미리보기를 먼저 완료/중지하세요.');
        return execute('serve_preview.py', [join(library, 'sites', site(params), 'source'), '--host', '127.0.0.1', '--port', '0'], execution, true);
      }, '저장된 페이지의 loopback 미리보기 시작', schema(siteProperty, ['site']));
      register('preview.stop', () => {
        preview?.child.kill(); preview = null; return { stopped: true };
      }, '로컬 페이지 미리보기 중지', schema());
      ctx.on('plugins.changed', list => {
        enabled = Array.isArray(list) && list.some(item => item.id === ID && item.enabled === true);
        if (!enabled) cancelAll();
      });
    },
    deactivate() { enabled = false; cancelAll(); },
  };
}

export const plugin = createPagePublisherPlugin();
