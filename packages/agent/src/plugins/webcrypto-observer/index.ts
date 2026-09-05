import type { PluginExecutionContext } from '../commands.js';
import type { MrRobotPlugin } from '../loader.js';
import { analyzeJavaScriptCandidates } from './analyzer.js';
import { cdpSafetyContract, SystemCdpBrowserDriver } from './cdp.js';
import { WEBCRYPTO_OBSERVER_LIMITS } from './policy.js';
import { WebCryptoObserverService } from './service.js';
import type { WebCryptoObserverOptions } from './types.js';

export { analyzeJavaScriptCandidates } from './analyzer.js';
export { cdpSafetyContract, SystemCdpBrowserDriver } from './cdp.js';
export { buildInstrumentationScript, buildMutationUpdateExpression, normalizeMutationRule, normalizeSessionId } from './instrumentation.js';
export { chromiumHostResolverRules, normalizeObservationLimits, normalizeObserveRequest, policyStatus, WEBCRYPTO_OBSERVER_LIMITS } from './policy.js';
export { WebCryptoObserverService } from './service.js';
export type * from './types.js';

const sessionIdProperty = {
  type: 'string',
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
} as const;

const observeParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    authorizationConfirmed: { type: 'boolean', const: true, description: '대상 소유 또는 명시적 허가 확인' },
    sessionEnabled: { type: 'boolean', const: true, description: '이번 제한 세션을 명시적으로 활성화' },
    targetUrl: { type: 'string', description: '관리자 exact-domain allowlist에 있는 단일 HTTPS:443 URL' },
    plaintextPreview: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean', const: true },
        previewConfirmed: { type: 'boolean', const: true },
        maxBytes: { type: 'integer', minimum: 1, maximum: WEBCRYPTO_OBSERVER_LIMITS.maxPlaintextPreviewBytes, default: 64 },
      },
      required: ['enabled', 'previewConfirmed'],
      description: '생략 시 metadata-only. 세션 중에만 제한된 encrypt 입력/decrypt 출력 미리보기 허용.',
    },
    allowStateChangingRequests: { type: 'boolean', description: 'POST/PUT/PATCH 허용 opt-in. DELETE는 항상 차단.' },
    stateChangingRequestsConfirmed: { type: 'boolean', description: '상태 변경 요청에 대한 별도 확인' },
    limits: {
      type: 'object',
      additionalProperties: false,
      properties: {
        durationMs: rangeSchema(WEBCRYPTO_OBSERVER_LIMITS.durationMs),
        maxRequests: rangeSchema(WEBCRYPTO_OBSERVER_LIMITS.maxRequests),
        maxResponseBytes: rangeSchema(WEBCRYPTO_OBSERVER_LIMITS.maxResponseBytes),
        maxConcurrentRequests: rangeSchema(WEBCRYPTO_OBSERVER_LIMITS.maxConcurrentRequests),
        maxRingEvents: rangeSchema(WEBCRYPTO_OBSERVER_LIMITS.maxRingEvents),
        maxRequestBodyBytes: rangeSchema(WEBCRYPTO_OBSERVER_LIMITS.maxRequestBodyBytes),
        maxUploadBytes: rangeSchema(WEBCRYPTO_OBSERVER_LIMITS.maxUploadBytes),
      },
    },
  },
  required: ['authorizationConfirmed', 'sessionEnabled', 'targetUrl'],
} as const;

export function createWebCryptoObserverPlugin(options: WebCryptoObserverOptions = {}): MrRobotPlugin {
  let service: WebCryptoObserverService | undefined;
  return {
    manifest: {
      id: 'webcrypto-observer',
      name: 'Authorized WebCrypto Observer',
      version: '1.0.0',
      kind: 'tool',
      category: 'pentest',
      enabledByDefault: true,
      description: '허가된 단일 HTTPS 대상에서 WebCrypto encrypt 입력·decrypt 출력 후보를 격리 브라우저로 제한 관찰합니다.',
      capabilities: [
        'webcrypto.offline-analyze', 'webcrypto.runtime-metadata', 'webcrypto.opt-in-preview',
        'webcrypto.one-shot-literal-mutation', 'webcrypto.session-events', 'webcrypto.session-stop',
      ],
      permissions: ['network.client', 'process.execute', 'filesystem.write'],
      dependencies: [],
    },
    activate(ctx) {
      service = new WebCryptoObserverService(options, (notice) => ctx.emit('webcrypto-observer.changed', notice));
      ctx.registerCommand('webcrypto-observer.status', (raw) => service!.status(raw), {
        destructive: false,
        adminOnly: true,
        description: '민감 데이터 없이 host allowlist 구성, 하드캡과 관찰 세션 상태를 확인합니다.',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: { sessionId: sessionIdProperty },
        },
      });
      ctx.registerCommand('webcrypto-observer.analyze', (raw) => analyzeJavaScriptCandidates(raw), {
        destructive: false,
        adminOnly: true,
        description: '붙여넣은 JavaScript를 실행하지 않고 최대 256KiB 고정 패턴으로 WebCrypto 후보 위치만 분석합니다.',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: {
            authorizationConfirmed: { type: 'boolean', const: true },
            sourceText: { type: 'string', maxLength: WEBCRYPTO_OBSERVER_LIMITS.maxSourceBytes },
          },
          required: ['authorizationConfirmed', 'sourceText'],
        },
      });
      ctx.registerCommand('webcrypto-observer.observe', (raw, execution) => {
        requireActiveAdminApproval(execution, '관찰 세션 시작');
        return service!.observe(raw, execution?.signal);
      }, {
        destructive: true,
        adminOnly: true,
        description: '별도 임시 프로필의 시스템 Chrome/Edge에서 단일 HTTPS 대상 관찰을 시작하고 즉시 sessionId를 반환합니다.',
        parameters: observeParameters,
      });
      ctx.registerCommand('webcrypto-observer.events', (raw) => service!.events(raw), {
        destructive: false,
        adminOnly: true,
        description: '활성/최근 세션의 제한된 링버퍼에서 sequence 이후 WebCrypto 후보 이벤트를 읽습니다.',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: {
            sessionId: sessionIdProperty,
            afterSequence: { type: 'integer', minimum: 0 },
          },
          required: ['sessionId'],
        },
      });
      ctx.registerCommand('webcrypto-observer.mutation.set', (raw, execution) => {
        requireActiveAdminApproval(execution, '일회성 literal 수정');
        return service!.setMutation(raw, execution?.signal);
      }, {
        destructive: true,
        adminOnly: true,
        description: '활성 세션에서 선택한 encrypt 입력 또는 decrypt 출력의 다음 정확한 UTF-8 literal 1회만 수정합니다.',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: {
            sessionId: sessionIdProperty,
            phase: { type: 'string', enum: ['encrypt-input', 'decrypt-output'] },
            matchLiteral: { type: 'string', minLength: 1, maxLength: WEBCRYPTO_OBSERVER_LIMITS.maxLiteralBytes },
            replacementLiteral: { type: 'string', minLength: 1, maxLength: WEBCRYPTO_OBSERVER_LIMITS.maxLiteralBytes },
            mutationConfirmed: { type: 'boolean', const: true },
          },
          required: ['sessionId', 'phase', 'matchLiteral', 'replacementLiteral', 'mutationConfirmed'],
        },
      });
      ctx.registerCommand('webcrypto-observer.stop', (raw, execution) => {
        requireActiveAdminApproval(execution, '관찰 세션 중지');
        return service!.stop(raw);
      }, {
        destructive: true,
        adminOnly: true,
        description: '관찰 세션을 즉시 중지하고 격리 브라우저와 임시 프로필을 정리합니다. 반복 호출해도 안전합니다.',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: { sessionId: sessionIdProperty },
          required: ['sessionId'],
        },
      });
    },
    async deactivate() {
      await service?.stopAll();
      service = undefined;
    },
  };
}

function requireActiveAdminApproval(execution: PluginExecutionContext | undefined, action: string): void {
  if (!execution?.isAdmin && execution?.portalCapability !== 'webcrypto-observer') {
    throw new Error(`${action}은 로컬 관리자 또는 host가 발급한 전용 WebCrypto 포털 capability가 필요합니다.`);
  }
  if (execution.permissionMode === 'read-only') throw new Error(`읽기 전용 권한에서는 ${action}을 실행할 수 없습니다.`);
  if (!execution.destructiveApproved) throw new Error(`${action}에 대한 명시적 승인이 필요합니다.`);
}

function rangeSchema(range: { min: number; max: number; default: number }): Record<string, unknown> {
  return { type: 'integer', minimum: range.min, maximum: range.max, default: range.default };
}

export const webCryptoObserverSafetyContract = Object.freeze({
  ...cdpSafetyContract,
  targetScope: 'single-exact-origin',
  targetTransport: 'https:443-only',
  adminAllowlistRequired: true,
  metadataOnlyByDefault: true,
  offlineSourceExecuted: false,
  plaintextPersisted: false,
  literalMutationPerSession: 1,
});
