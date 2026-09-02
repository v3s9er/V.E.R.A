import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export type SecretVaultPurpose = 'provider' | 'pairing-administrator' | 'mcp-server-environment' | 'remote-link';

export interface SecretPurposeFallbackResult {
  plaintext: string;
  migratedFromLegacyProvider: boolean;
}

const ENTROPY: Record<SecretVaultPurpose, string> = {
  // Keep the legacy provider entropy byte-for-byte compatible.
  provider: 'Mr.Robot/provider-secrets/v1',
  // Domain separation prevents a provider ciphertext from being substituted
  // for the global administrator credential (or vice versa).
  'pairing-administrator': 'Mr.Robot/pairing-administrator/v1',
  // MCP process environments may contain arbitrary third-party credentials.
  // Keep their ciphertext outside both provider and administrator domains.
  'mcp-server-environment': 'Mr.Robot/mcp-server-environment/v1',
  // Tunnel and Access credentials are isolated from every other secret class.
  'remote-link': 'Mr.Robot/remote-link/v1',
};

function protectScript(entropy: string): string {
  return `Add-Type -AssemblyName System.Security;$data=[Console]::In.ReadToEnd();$bytes=[Text.Encoding]::UTF8.GetBytes($data);$entropy=[Text.Encoding]::UTF8.GetBytes('${entropy}');$out=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($out))`;
}

function unprotectScript(entropy: string): string {
  return `Add-Type -AssemblyName System.Security;$data=[Console]::In.ReadToEnd();$bytes=[Convert]::FromBase64String($data);$entropy=[Text.Encoding]::UTF8.GetBytes('${entropy}');$out=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$entropy,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Text.Encoding]::UTF8.GetString($out))`;
}

/** Windows DPAPI vault. Ciphertext is bound to the current Windows user. */
export class SecretVault {
  private readonly entropy: string;

  constructor(purpose: SecretVaultPurpose = 'provider') {
    this.entropy = ENTROPY[purpose];
  }

  protect(value: string): string {
    if (!value) return '';
    if (process.platform !== 'win32') throw new Error('Mr.Robot secret storage currently requires Windows DPAPI');
    const encoded = runPowerShell(protectScript(this.entropy), value);
    return `dpapi:v1:${encoded}`;
  }

  unprotect(value: string): string {
    if (!value) return '';
    const prefix = 'dpapi:v1:';
    if (!value.startsWith(prefix)) throw new Error('unsupported protected secret format');
    return runPowerShell(unprotectScript(this.entropy), value.slice(prefix.length));
  }
}

/**
 * Transitional reader for v0.3.x remote-link ciphertexts, which were written
 * with the provider entropy before remote-link domain separation existed.
 * Callers must persist a new remote-link ciphertext before using plaintext
 * returned from the legacy branch. No protected value or plaintext is included
 * in the terminal error.
 */
export function unprotectRemoteLinkWithLegacyProviderFallback(
  protectedValue: string,
  unprotectRemoteLink: (value: string) => string,
  unprotectLegacyProvider: (value: string) => string,
): SecretPurposeFallbackResult {
  try {
    return { plaintext: unprotectRemoteLink(protectedValue), migratedFromLegacyProvider: false };
  } catch {
    try {
      return { plaintext: unprotectLegacyProvider(protectedValue), migratedFromLegacyProvider: true };
    } catch {
      throw new Error('저장된 암호문을 현재 또는 구버전 보안 영역에서 해독할 수 없습니다.');
    }
  }
}

function runPowerShell(script: string, input: string): string {
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const encodedCommand = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand], {
    input,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.error?.message || result.stderr || `exit ${String(result.status)}`)
      .trim().replace(/[\r\n]+/g, ' ').slice(0, 512);
    throw new Error(`Windows DPAPI operation failed: ${detail}`);
  }
  return result.stdout.trim();
}
