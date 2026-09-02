import type { MrRobotPlugin } from '../loader.js';
import { DEFAULT_SSL_PORTS, scanLimits } from './policy.js';
import { SslTlsScanner } from './scanner.js';
import type { SslScannerOptions } from './types.js';

export { DEFAULT_SSL_PORTS, isPublicIpAddress, scanLimits, validateAndResolveTarget } from './policy.js';
export { probeTlsEndpoint, SslTlsScanner } from './scanner.js';
export type * from './types.js';

export function createSslScanPlugin(options: SslScannerOptions = {}): MrRobotPlugin {
  const scanner = new SslTlsScanner(options);
  return {
    manifest: {
      id: 'sslscan-auditor',
      name: 'SSL/TLS Inspector',
      version: '1.0.0',
      kind: 'tool',
      category: 'pentest',
      enabledByDefault: true,
      description: '허가된 단일 공개 대상의 TLS 버전, 제한된 암호군, 인증서 체인을 점검하는 독립 구현 보안 플러그인입니다.',
      capabilities: ['tls.protocols.inspect', 'tls.ciphers.inspect', 'tls.certificates.inspect', 'tls.policy.evaluate', 'tls.scan.progress', 'tls.scan.cache'],
      permissions: ['network.client'],
      dependencies: [],
    },
    activate(ctx) {
      ctx.registerCommand('sslscan.status', (raw) => ({
        ...scanner.status(typeof (raw as { scanId?: unknown } | undefined)?.scanId === 'string' ? (raw as { scanId: string }).scanId : undefined),
        scanner: 'Mr.Robot independent TLS inspector',
        scanLimits,
        referenceProject: 'https://github.com/rbsec/sslscan',
      }), { destructive: false });

      ctx.registerCommand('sslscan.scan', async (raw, execution) => {
        if (!execution?.destructiveApproved || execution.permissionMode === 'read-only') {
          throw new Error('An explicit per-run approval is required for an active TLS scan.');
        }
        const result = await scanner.scan(raw, execution.signal, (progress) => {
          ctx.emit('sslscan-auditor.progress', progress);
        });
        ctx.emit('sslscan-auditor.completed', {
          target: `${result.target.host}:${result.target.port}`,
          durationMs: result.durationMs,
          supportedProtocols: result.protocols.filter((protocol) => protocol.supported).map((protocol) => protocol.requested),
          findingCounts: result.findings.reduce<Record<string, number>>((counts, finding) => {
            counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
            return counts;
          }, {}),
        });
        return result;
      }, {
        tool: true,
        destructive: true,
        adminOnly: true,
        description: '소유했거나 명시적으로 허가받은 공개 호스트 하나를 저트래픽 TLS 점검합니다. 기본 quick 모드는 개별 암호군 시도를 하지 않으며 내부망은 차단됩니다.',
        toolWhen: (message) => /ssl|tls|https|cipher|certificate|인증서|암호군|보안 점검|펜테스트/i.test(message),
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            host: { type: 'string', description: '단일 DNS 이름 또는 IP 주소(URL 아님)' },
            port: { type: 'integer', enum: [...(options.allowedPorts ?? DEFAULT_SSL_PORTS)], default: 443 },
            sni: { type: 'string', description: '선택적 SNI DNS 이름' },
            authorizationConfirmed: { type: 'boolean', const: true, description: '대상 소유 또는 명시적 허가 확인' },
            scanMode: { type: 'string', enum: ['quick', 'standard', 'deep'], default: 'quick', description: 'quick=프로토콜/인증서, standard=대표 암호군, deep=확장된 제한 검사' },
            timeoutMs: { type: 'integer', minimum: scanLimits.socketTimeoutMs.min, maximum: scanLimits.socketTimeoutMs.max },
            overallTimeoutMs: { type: 'integer', minimum: scanLimits.overallTimeoutMs.min, maximum: scanLimits.overallTimeoutMs.max },
            maxCipherTests: { type: 'integer', minimum: 0, maximum: scanLimits.maxCipherTests },
            forceRefresh: { type: 'boolean', default: false, description: '최근 동일 결과 캐시를 무시' },
          },
          required: ['host', 'authorizationConfirmed'],
        },
      });
    },
  };
}
