import { randomUUID } from 'node:crypto';
import type { ModelRole, ProviderAddInput, ProviderConfig, ProviderInfo } from '@mr-robot/shared';
import { ConfigStore, defaultProviderBaseUrl } from '../config.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAICompatibleProvider } from './openai.js';
import { CliProvider } from './cli.js';
import type { AiProvider } from './provider.js';

function instantiate(c: ProviderConfig): AiProvider {
  switch (c.type) {
    case 'codex-cli':
    case 'claude-cli':
      return new CliProvider(c.id, c.label, c.type, '', c.model, c.command || (c.type === 'codex-cli' ? 'codex' : 'claude'), c.args);
    case 'anthropic':
      return new AnthropicProvider(c.id, c.label, 'anthropic', c.baseUrl, c.model, c.apiKey);
    case 'ollama':
      return new OpenAICompatibleProvider(c.id, c.label, 'ollama', c.baseUrl, c.model, c.apiKey, c.headers);
    default:
      return new OpenAICompatibleProvider(c.id, c.label, 'openai-compatible', c.baseUrl, c.model, c.apiKey, c.headers);
  }
}

function normalizeBaseUrl(type: ProviderConfig['type'], value: string): string {
  if (type.endsWith('-cli')) return '';
  const trimmed = value.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Base URL은 http:// 또는 https://로 시작하는 올바른 주소여야 합니다.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Base URL은 HTTP(S) 주소만 사용할 수 있습니다.');
  return trimmed;
}

function defaultModel(type: ProviderConfig['type']): string {
  switch (type) {
    case 'anthropic': return 'claude-sonnet-5';
    case 'ollama': return 'llama3.1';
    case 'codex-cli': return 'gpt-5.6-terra';
    case 'claude-cli': return 'sonnet';
    default: return 'gpt-5.6-terra';
  }
}

/**
 * Holds every configured provider and keeps the on-disk config in sync.
 * Providers can be added/removed at runtime without restarting the server.
 */
export class ProviderRegistry {
  private providers = new Map<string, AiProvider>();

  constructor(private readonly config: ConfigStore) {
    this.reload();
  }

  reload(): void {
    this.providers.clear();
    for (const c of this.config.providers) {
      try {
        this.providers.set(c.id, instantiate(c));
      } catch {
        // invalid provider skipped; still listed so the user can fix/remove it
      }
    }
  }

  list(): ProviderInfo[] {
    return this.config.providers.map((p) => {
      const source = p.source ?? (p.type === 'ollama' ? 'local' : p.type.endsWith('-cli') ? 'subscription' : 'api');
      return ({
      id: p.id,
      label: p.label,
      type: p.type,
      baseUrl: p.baseUrl,
      model: p.model,
      hasKey: Boolean(p.apiKey),
      isDefault: p.isDefault,
      source,
      costTier: source === 'free' || source === 'local' ? 0 : (p.costTier ?? 1),
      supportedReasoning: this.providers.get(p.id)?.supportedReasoning ?? ['auto'],
      });
    });
  }

  get(id: string): AiProvider | undefined {
    return this.providers.get(id);
  }

  getForModel(id: string, model?: string): AiProvider | undefined {
    const selectedModel = model?.trim();
    if (!selectedModel) return this.get(id);
    const config = this.config.providers.find((provider) => provider.id === id);
    if (!config) return undefined;
    if (config.model === selectedModel) return this.get(id);
    return instantiate({ ...config, model: selectedModel });
  }

  default(): AiProvider | undefined {
    const def = this.config.providers.find((p) => p.isDefault);
    if (def) return this.providers.get(def.id);
    const first = this.config.providers[0];
    return first ? this.providers.get(first.id) : undefined;
  }

  resolve(role: ModelRole, preferredId?: string, preferredModel?: string, roleProviders?: string[]): AiProvider | undefined {
    if (preferredId) {
      const preferred = this.getForModel(preferredId, preferredModel);
      if (preferred) return preferred;
    }
    for (const id of roleProviders ?? this.config.routing.roles[role] ?? []) {
      const provider = this.providers.get(id);
      if (provider) return provider;
    }
    return this.default();
  }

  toolCapable(excludeId?: string): AiProvider | undefined {
    const preferred = this.resolve('general');
    if (preferred?.supportsTools && preferred.id !== excludeId) return preferred;
    return [...this.providers.values()].find((p) => p.supportsTools && p.id !== excludeId);
  }

  add(input: ProviderAddInput): ProviderInfo {
    const id = randomUUID();
    const type = input.type ?? 'openai-compatible';
    const source = input.source ?? (type === 'ollama' ? 'local' : type.endsWith('-cli') ? 'subscription' : 'api');
    const baseUrl = normalizeBaseUrl(type, input.baseUrl ?? defaultProviderBaseUrl(type));
    const cfg: ProviderConfig = {
      id,
      label: input.label || type,
      type,
      baseUrl,
      model: input.model || defaultModel(type),
      apiKey: input.apiKey ?? '',
      isDefault: this.config.providers.length === 0,
      source,
      command: input.command,
      args: input.args,
      costTier: source === 'free' || source === 'local' ? 0 : Math.max(0, Math.min(5, input.costTier ?? 1)),
      inputCostPerMillion: input.inputCostPerMillion,
      outputCostPerMillion: input.outputCostPerMillion,
    };
    this.config.upsertProvider(cfg);
    this.reload();
    return this.list().find((p) => p.id === id)!;
  }

  remove(id: string): void {
    this.config.removeProvider(id);
    this.reload();
  }

  setDefault(id: string): void {
    this.config.setDefaultProvider(id);
    this.reload();
  }

  updateModel(id: string, model: string): ProviderInfo {
    if (!model.trim() || !this.config.patchProvider(id, { model: model.trim() })) throw new Error('provider not found');
    this.reload();
    return this.list().find((p) => p.id === id)!;
  }

  async models(id: string): Promise<string[]> {
    const provider = this.providers.get(id);
    if (!provider) throw new Error('provider not found');
    return provider.models();
  }

  async test(id: string): Promise<{ ok: boolean; error?: string }> {
    const p = this.providers.get(id);
    if (!p) return { ok: false, error: 'provider not found' };
    try {
      return await p.ping();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
