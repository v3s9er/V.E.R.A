import {
  TOOL_PORTAL_REQUEST_PROOF_HEADER,
  type ToolPortalRouteId,
  type ToolPortalSession,
} from './tool-portal-contract';

const MAX_PORTAL_RESPONSE_BYTES = 1024 * 1024;
const MAX_PORTAL_ARTIFACT_BYTES = 16 * 1024 * 1024;
const REQUEST_PROOF_STORAGE_KEY = 'mr-robot.tool-portal.request-proof.v1';
const REQUEST_PROOF_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ALLOWED_ACTIONS: Readonly<Record<ToolPortalRouteId, ReadonlySet<string>>> = {
  'resource-archiver': new Set(['validate', 'preview', 'archive']),
  sslscan: new Set(['status', 'scan']),
  'runtime-hook': new Set(['status', 'analyze', 'observe', 'events', 'mutation.set', 'stop']),
};

export interface DownloadedPortalArtifact {
  blob: Blob;
  fileName: string;
}

export interface ToolPortalRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Read-only status polling is cancellable but does not lock portal navigation. */
  background?: boolean;
}

export class ToolPortalHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ToolPortalHttpError';
  }
}

function proofStorage(): Storage | undefined {
  try { return window.sessionStorage ?? undefined; }
  catch { return undefined; }
}

function storedRequestProof(): string | undefined {
  const storage = proofStorage();
  if (!storage) return undefined;
  try {
    const value = storage.getItem(REQUEST_PROOF_STORAGE_KEY) ?? '';
    if (REQUEST_PROOF_PATTERN.test(value)) return value;
    if (value) storage.removeItem(REQUEST_PROOF_STORAGE_KEY);
  } catch {
    return undefined;
  }
  return undefined;
}

function clearStoredRequestProof(): void {
  try { proofStorage()?.removeItem(REQUEST_PROOF_STORAGE_KEY); } catch { /* fail closed */ }
}

function assertProofStorageAvailable(): Storage {
  const storage = proofStorage();
  if (!storage) throw new Error('도구 포털 보안 세션에 필요한 탭 저장소를 사용할 수 없습니다.');
  const testKey = `${REQUEST_PROOF_STORAGE_KEY}.test`;
  try {
    storage.setItem(testKey, '1');
    storage.removeItem(testKey);
    return storage;
  } catch {
    throw new Error('도구 포털 보안 세션에 필요한 탭 저장소를 사용할 수 없습니다.');
  }
}

function artifactFileName(response: Response): string {
  const disposition = response.headers.get('content-disposition') ?? '';
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  const plain = /filename="([^"]+)"/i.exec(disposition)?.[1] ?? /filename=([^;\s]+)/i.exec(disposition)?.[1];
  let candidate = plain ?? 'resource-archive.zip';
  if (encoded) {
    try { candidate = decodeURIComponent(encoded); } catch { candidate = 'resource-archive.zip'; }
  }
  const leaf = candidate.replace(/[\\/\u0000-\u001f\u007f]/g, '_').slice(0, 180);
  return leaf.toLowerCase().endsWith('.zip') ? leaf : `${leaf || 'resource-archive'}.zip`;
}

export class ToolPortalHttpClient {
  private readonly activeRequests = new Set<AbortController>();
  private readonly foregroundRequests = new Set<AbortController>();

  constructor(
    private readonly onUnauthorized?: () => void,
    private readonly onActivityChange?: (activeRequests: number) => void,
  ) {}

  abortAll(reason = '도구 포털 작업이 취소되었습니다.'): void {
    for (const controller of this.activeRequests) {
      if (!controller.signal.aborted) controller.abort(new Error(reason));
    }
  }

  forgetSessionProof(): void {
    clearStoredRequestProof();
  }

  private requireRequestProof(): string {
    const proof = storedRequestProof();
    if (proof) return proof;
    clearStoredRequestProof();
    this.onUnauthorized?.();
    throw new ToolPortalHttpError('도구 포털 요청 증명이 없거나 만료되었습니다. 다시 로그인하세요.', 401, 'PORTAL_UNAUTHORIZED');
  }

  private beginRequest(external?: AbortSignal, timeoutMs = 15_000, foreground = true): { signal: AbortSignal; finish: () => void } {
    const controller = new AbortController();
    const deadline = AbortSignal.timeout(Math.max(1_000, Math.min(75_000, Math.floor(timeoutMs))));
    this.activeRequests.add(controller);
    if (foreground) {
      this.foregroundRequests.add(controller);
      this.onActivityChange?.(this.foregroundRequests.size);
    }
    let finished = false;
    return {
      signal: AbortSignal.any([controller.signal, deadline, ...(external ? [external] : [])]),
      finish: () => {
        if (finished) return;
        finished = true;
        this.activeRequests.delete(controller);
        if (this.foregroundRequests.delete(controller)) this.onActivityChange?.(this.foregroundRequests.size);
      },
    };
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    timeoutMs = 15_000,
    foreground = true,
    proofMode: 'required' | 'optional' | 'omit' = 'required',
    proofOverride?: string,
  ): Promise<T> {
    const endpoint = new URL(path, window.location.origin);
    if (endpoint.origin !== window.location.origin || !endpoint.pathname.startsWith('/api/tool-portal/')) {
      throw new Error('도구 포털은 현재 출처의 제한된 API만 호출할 수 있습니다.');
    }
    const requestProof = proofMode === 'omit'
      ? undefined
      : proofOverride ?? (proofMode === 'required' ? this.requireRequestProof() : storedRequestProof());
    const tracked = this.beginRequest(init.signal ?? undefined, timeoutMs, foreground);
    try {
      const response = await fetch(endpoint, {
        ...init,
        signal: tracked.signal,
        credentials: 'same-origin',
        mode: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        headers: {
          accept: 'application/json',
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...(requestProof ? { [TOOL_PORTAL_REQUEST_PROOF_HEADER]: requestProof } : {}),
        },
      });
      const announced = Number(response.headers.get('content-length') ?? 0);
      if (Number.isFinite(announced) && announced > MAX_PORTAL_RESPONSE_BYTES) throw new Error('포털 응답 크기 한도를 초과했습니다.');
      const text = await response.text();
      if (new Blob([text]).size > MAX_PORTAL_RESPONSE_BYTES) throw new Error('포털 응답 크기 한도를 초과했습니다.');
      let value: unknown = {};
      if (text) {
        try { value = JSON.parse(text); } catch { throw new Error('포털 서버 응답이 올바른 JSON이 아닙니다.'); }
      }
      if (!response.ok) {
        const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
        const message = typeof record.error === 'string' ? record.error : `도구 포털 요청 실패 (HTTP ${response.status})`;
        const code = typeof record.code === 'string' ? record.code : undefined;
        if (response.status === 401) {
          clearStoredRequestProof();
          this.onUnauthorized?.();
        }
        throw new ToolPortalHttpError(message, response.status, code);
      }
      return value as T;
    } finally {
      tracked.finish();
    }
  }

  async session(): Promise<ToolPortalSession> {
    const session = await this.request<ToolPortalSession>('/api/tool-portal/session', { method: 'GET' }, 15_000, true, 'optional');
    if (!session.authenticated) clearStoredRequestProof();
    return session;
  }

  async login(password: string): Promise<ToolPortalSession> {
    const storage = assertProofStorageAvailable();
    clearStoredRequestProof();
    const response = await this.request<ToolPortalSession & { requestProof?: unknown }>(
      '/api/tool-portal/session',
      { method: 'POST', body: JSON.stringify({ password }) },
      15_000,
      true,
      'omit',
    );
    const requestProof = response.requestProof;
    if (response.authenticated !== true || typeof requestProof !== 'string' || !REQUEST_PROOF_PATTERN.test(requestProof)) {
      clearStoredRequestProof();
      throw new Error('도구 포털 서버가 유효한 일회성 요청 증명을 반환하지 않았습니다.');
    }
    try {
      storage.setItem(REQUEST_PROOF_STORAGE_KEY, requestProof);
    } catch {
      await this.request('/api/tool-portal/logout', { method: 'POST', body: '{}' }, 15_000, true, 'required', requestProof).catch(() => undefined);
      clearStoredRequestProof();
      throw new Error('도구 포털 요청 증명을 탭 저장소에 보관하지 못해 세션을 폐기했습니다.');
    }
    const { requestProof: _requestProof, ...session } = response;
    return session;
  }

  async logout(): Promise<void> {
    try {
      await this.request('/api/tool-portal/logout', { method: 'POST', body: '{}' });
    } finally {
      clearStoredRequestProof();
    }
  }

  call<T>(tool: ToolPortalRouteId, action: string, params: Record<string, unknown>, options: ToolPortalRequestOptions = {}): Promise<T> {
    if (!ALLOWED_ACTIONS[tool].has(action)) throw new Error('이 도구 포털에서 허용되지 않은 작업입니다.');
    const safeAction = encodeURIComponent(action);
    return this.request(`/api/tool-portal/tools/${encodeURIComponent(tool)}/${safeAction}`, {
      method: 'POST',
      body: JSON.stringify(params),
      signal: options.signal,
    }, options.timeoutMs ?? 65_000, options.background !== true);
  }

  async downloadArtifact(artifactToken: string, options: ToolPortalRequestOptions = {}): Promise<DownloadedPortalArtifact> {
    if (!/^[A-Za-z0-9_-]{20,512}$/.test(artifactToken)) throw new Error('잘못된 아티팩트 토큰입니다.');
    const endpoint = new URL(`/api/tool-portal/artifacts/${encodeURIComponent(artifactToken)}`, window.location.origin);
    const requestProof = this.requireRequestProof();
    const tracked = this.beginRequest(options.signal, options.timeoutMs ?? 30_000);
    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        credentials: 'same-origin',
        mode: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        headers: { accept: 'application/zip', [TOOL_PORTAL_REQUEST_PROOF_HEADER]: requestProof },
        signal: tracked.signal,
      });
      if (!response.ok) {
        if (response.status === 401) {
          clearStoredRequestProof();
          this.onUnauthorized?.();
        }
        throw new ToolPortalHttpError(`ZIP 다운로드 요청 실패 (HTTP ${response.status})`, response.status);
      }
      const contentType = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
      if (contentType !== 'application/zip') throw new Error('ZIP이 아닌 아티팩트 응답을 거부했습니다.');
      if (!/(?:^|,)\s*no-store\b/i.test(response.headers.get('cache-control') ?? '')) throw new Error('캐시 금지가 확인되지 않은 ZIP 응답을 거부했습니다.');
      const announced = Number(response.headers.get('content-length') ?? 0);
      if (Number.isFinite(announced) && announced > MAX_PORTAL_ARTIFACT_BYTES) throw new Error('ZIP 다운로드 크기 한도를 초과했습니다.');

      const reader = response.body?.getReader();
      if (!reader) throw new Error('ZIP 응답 본문을 읽을 수 없습니다.');
      const chunks: ArrayBuffer[] = [];
      const signature: number[] = [];
      let received = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (received > MAX_PORTAL_ARTIFACT_BYTES) {
            await reader.cancel();
            throw new Error('ZIP 다운로드 크기 한도를 초과했습니다.');
          }
          for (let index = 0; index < value.byteLength && signature.length < 4; index += 1) signature.push(value[index]);
          const copy = new Uint8Array(value.byteLength);
          copy.set(value);
          chunks.push(copy.buffer);
        }
      } finally {
        reader.releaseLock();
      }
      const zipSignature = signature.map((byte) => byte.toString(16).padStart(2, '0')).join('');
      if (!['504b0304', '504b0506', '504b0708', '504b0102'].includes(zipSignature)) throw new Error('ZIP 헤더가 없는 아티팩트 응답을 거부했습니다.');
      return { blob: new Blob(chunks, { type: 'application/zip' }), fileName: artifactFileName(response) };
    } finally {
      tracked.finish();
    }
  }
}
