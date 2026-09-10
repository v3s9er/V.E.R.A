import type { ProviderModelCatalog } from '@mr-robot/shared';

type CatalogClient = { call(method: string, params: unknown): Promise<unknown> };

export async function loadModelCatalog(client: CatalogClient, id: string, refresh = false): Promise<ProviderModelCatalog> {
  try {
    return await client.call('providers.catalog', { id, refresh }) as ProviderModelCatalog;
  } catch (error) {
    // A new desktop may connect to an older PC. Do not mask auth/network failures.
    if (!(error instanceof Error) || error.message !== 'unknown method: providers.catalog') throw error;
    const models = await client.call('providers.models', { id, refresh }) as string[];
    return { models, source: 'provider', state: 'stale', lastUpdatedAt: null, lastAttemptAt: null,
      warning: '연결된 PC는 모델 갱신 상태를 제공하지 않는 구버전입니다. 해당 PC의 Mr.Robot을 업데이트하세요.' };
  }
}

export function modelCatalogSummary(catalog: ProviderModelCatalog): string {
  const source = catalog.source === 'codex-model-list' ? 'Codex model/list' : catalog.source === 'claude-cli-help' ? 'Claude CLI 도움말' : '공급자 모델 목록';
  const state = catalog.state === 'fresh' ? '조회 완료' : catalog.state === 'stale' ? '이전 목록 · 갱신 확인 필요' : '조회 실패 · 저장된 모델만 표시';
  return `${source}${catalog.cliVersion ? ` · CLI ${catalog.cliVersion}` : ''} · ${catalog.models.length}개 · ${state}`;
}
