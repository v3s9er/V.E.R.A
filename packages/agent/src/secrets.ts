import { spawnSync } from 'node:child_process';

const ENTROPY = 'Mr.Robot/provider-secrets/v1';
const PROTECT_SCRIPT = `Add-Type -AssemblyName System.Security;$data=[Console]::In.ReadToEnd();$bytes=[Text.Encoding]::UTF8.GetBytes($data);$entropy=[Text.Encoding]::UTF8.GetBytes('${ENTROPY}');$out=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($out))`;
const UNPROTECT_SCRIPT = `Add-Type -AssemblyName System.Security;$data=[Console]::In.ReadToEnd();$bytes=[Convert]::FromBase64String($data);$entropy=[Text.Encoding]::UTF8.GetBytes('${ENTROPY}');$out=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$entropy,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Text.Encoding]::UTF8.GetString($out))`;

/** Windows DPAPI vault. Ciphertext is bound to the current Windows user. */
export class SecretVault {
  private readonly protectedByValue = new Map<string, string>();

  protect(value: string): string {
    if (!value) return '';
    const cached = this.protectedByValue.get(value);
    if (cached) return cached;
    if (process.platform !== 'win32') throw new Error('Mr.Robot secret storage currently requires Windows DPAPI');
    const encoded = runPowerShell(PROTECT_SCRIPT, value);
    const result = `dpapi:v1:${encoded}`;
    this.protectedByValue.set(value, result);
    return result;
  }

  unprotect(value: string): string {
    if (!value) return '';
    const prefix = 'dpapi:v1:';
    if (!value.startsWith(prefix)) throw new Error('unsupported protected secret format');
    const plain = runPowerShell(UNPROTECT_SCRIPT, value.slice(prefix.length));
    this.protectedByValue.set(plain, value);
    return plain;
  }
}

function runPowerShell(script: string, input: string): string {
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    input,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`Windows DPAPI operation failed: ${(result.stderr || '').trim() || `exit ${result.status}`}`);
  return result.stdout.trim();
}
