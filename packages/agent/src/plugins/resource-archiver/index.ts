import type { MrRobotPlugin } from '../loader.js';
import { archiveWebResources, previewResourceArchive, validateResourceArchiveRequest } from './archive.js';

export class SingleArchiveGate {
  private active = false;

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active) throw new Error('리소스 보존 작업이 이미 실행 중입니다. 완료 후 다시 시도하세요.');
    this.active = true;
    try {
      return await task();
    } finally {
      this.active = false;
    }
  }
}

const archiveParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    authorizationConfirmed: { type: 'boolean', description: '대상 페이지를 소유하거나 명시적으로 보존 허가를 받았을 때만 true' },
    pageUrl: { type: 'string', description: '보존할 HTTP(S) 페이지 URL' },
    outputPath: { type: 'string', description: '선택된 작업 폴더 안의 상대 ZIP 경로' },
    capturedResources: {
      type: 'array',
      description: '브라우저/CDP가 이미 캡처한 응답. 쿠키나 Authorization 헤더는 받지 않습니다.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string' }, method: { type: 'string' }, status: { type: 'integer' }, mimeType: { type: 'string' },
          bodyBase64: { type: 'string' }, bodyText: { type: 'string' }, responseHeaders: { type: 'object' },
        },
        required: ['url'],
      },
    },
    har: { type: 'object', description: '선택적 HAR 1.2형 log.entries 입력. 안전한 응답 필드만 사용합니다.' },
    fetchMissing: { type: 'boolean', description: '명시적으로 true일 때만 본문이 없는 공개 HTTP(S) 자원을 직접 요청합니다.' },
    discoverDependencies: { type: 'boolean' },
    rewriteOfflineLinks: { type: 'boolean' },
    allowedCrossOriginHosts: { type: 'array', items: { type: 'string' }, description: '추가로 가져올 정확한 공개 DNS 호스트(와일드카드 없음)' },
    limits: {
      type: 'object',
      additionalProperties: false,
      properties: {
        maxResources: { type: 'integer', minimum: 1, maximum: 2000 },
        maxNetworkRequests: { type: 'integer', minimum: 0, maximum: 500, description: '리디렉션과 재시도를 포함한 실제 HTTP GET 시작 횟수 하드캡. 0이면 직접 네트워크를 완전히 차단합니다.' },
        maxResourceBytes: { type: 'integer', minimum: 1024, maximum: 33554432 },
        maxTotalBytes: { type: 'integer', minimum: 1024, maximum: 134217728 },
        maxDepth: { type: 'integer', minimum: 0, maximum: 4 }, concurrency: { type: 'integer', minimum: 1, maximum: 8 },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 30000 }, retries: { type: 'integer', minimum: 0, maximum: 2 },
        maxRedirects: { type: 'integer', minimum: 0, maximum: 5 },
        minRequestIntervalMs: { type: 'integer', minimum: 100, maximum: 2000, description: '모든 실제 요청 시작 사이의 최소 간격' },
        overallTimeoutMs: { type: 'integer', minimum: 1000, maximum: 300000, description: '전체 보존 실행의 서버측 제한 시간' },
      },
    },
  },
  required: ['authorizationConfirmed', 'pageUrl'],
} as const;

export function createResourceArchiverPlugin(): MrRobotPlugin {
  return {
    manifest: {
      id: 'resource-archiver',
      name: 'Authorized Web Resource Archiver',
      version: '1.0.0',
      kind: 'tool',
      category: 'pentest',
      enabledByDefault: true,
      description: '허가된 웹 페이지의 브라우저/HAR 응답과 공개 자산 그래프를 무결성 manifest가 포함된 오프라인 ZIP으로 보존합니다.',
      capabilities: [
        'web-archive.direct-url', 'web-archive.browser-capture', 'web-archive.har-import',
        'web-archive.dependency-graph', 'web-archive.offline-rewrite', 'web-archive.sha256-deduplication',
      ],
      permissions: ['network.client', 'filesystem.write'],
    },
    activate(ctx) {
      const archiveGate = new SingleArchiveGate();
      ctx.registerCommand('resource-archiver.validate', (raw) => validateResourceArchiveRequest(raw), {
        destructive: false,
        adminOnly: true,
        description: '네트워크나 파일을 건드리지 않고 웹 리소스 보존 요청과 안전 한도를 검증합니다.',
        parameters: archiveParameters,
      });
      ctx.registerCommand('resource-archiver.preview', (raw) => previewResourceArchive(raw), {
        destructive: false,
        adminOnly: true,
        description: '네트워크·파일 작업 없이 입력 본문, 발견 자산, 예상 요청량과 안전 경고를 계산합니다.',
        parameters: archiveParameters,
      });
      ctx.registerCommand('resource-archiver.archive', (raw, execution) => archiveGate.run(() => archiveWebResources(raw, execution, (progress) => {
        ctx.emit('resource-archiver.progress', progress);
      })), {
        tool: true,
        destructive: true,
        adminOnly: true,
        description: '소유하거나 허가받은 HTTP(S) 페이지를 브라우저 캡처/HAR 또는 안전한 직접 수집으로 보존 ZIP에 저장합니다.',
        toolWhen: (message) => /save all resources|리소스.{0,8}(저장|보존|수집)|웹.{0,8}(아카이브|보존)|har|offline.{0,5}(archive|copy)|resource.{0,5}archive/i.test(message),
        parameters: archiveParameters,
      });
    },
  };
}
