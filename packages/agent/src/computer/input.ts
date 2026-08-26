import type { ShellResult } from '@mr-robot/shared';
import { runShell } from './shell.js';

/**
 * Mouse + keyboard control implemented through PowerShell and the Win32
 * user32.dll P/Invoke surface. No native npm modules to compile — this keeps
 * installation trivial and avoids ABI breakage across Node upgrades.
 */

const INPUT_CS = `using System;
using System.Runtime.InteropServices;
public static class NxInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, int dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  public const uint LEFTDOWN = 0x02, LEFTUP = 0x04, RIGHTDOWN = 0x08, RIGHTUP = 0x10;
  public const uint MIDDLEDOWN = 0x20, MIDDLEUP = 0x40, WHEEL = 0x0800, KEYUP = 0x0002;
}`;

function inputScript(body: string): string {
  return `Add-Type -TypeDefinition @'\n${INPUT_CS}\n'@\n${body}`;
}

export type MouseButton = 'left' | 'right' | 'middle';

function mouseDown(button: MouseButton): number {
  switch (button) {
    case 'right':
      return 0x08;
    case 'middle':
      return 0x20;
    default:
      return 0x02;
  }
}
function mouseUp(button: MouseButton): number {
  switch (button) {
    case 'right':
      return 0x10;
    case 'middle':
      return 0x40;
    default:
      return 0x04;
  }
}

export async function moveMouse(x: number, y: number): Promise<ShellResult> {
  const body = `[NxInput]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}) | Out-Null`;
  return runShell(inputScript(body), { shell: 'powershell', timeoutMs: 5000 });
}

export async function clickMouse(
  button: MouseButton,
  x?: number,
  y?: number,
  clicks = 1,
): Promise<ShellResult> {
  const lines: string[] = [];
  if (x !== undefined && y !== undefined) {
    lines.push(`[NxInput]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}) | Out-Null`);
  }
  const down = mouseDown(button);
  const up = mouseUp(button);
  for (let i = 0; i < Math.max(1, Math.min(10, clicks)); i++) {
    lines.push(`[NxInput]::mouse_event(${down}, 0, 0, 0, [UIntPtr]::Zero)`);
    lines.push(`[NxInput]::mouse_event(${up}, 0, 0, 0, [UIntPtr]::Zero)`);
  }
  return runShell(inputScript(lines.join('\n')), { shell: 'powershell', timeoutMs: 5000 });
}

export async function scrollMouse(delta: number): Promise<ShellResult> {
  const d = Math.round(delta);
  const body = `[NxInput]::mouse_event(${0x0800}, 0, 0, ${d}, [UIntPtr]::Zero)`;
  return runShell(inputScript(body), { shell: 'powershell', timeoutMs: 5000 });
}

const VK: Record<string, number> = {
  enter: 0x0d, return: 0x0d, tab: 0x09, escape: 0x1b, esc: 0x1b,
  backspace: 0x08, space: 0x20, delete: 0x2e, insert: 0x2d,
  home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  left: 0x25, right: 0x27, up: 0x26, down: 0x28,
  capslock: 0x14, numlock: 0x90, scrolllock: 0x91,
  ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, win: 0x5b, meta: 0x5b, cmd: 0x5b,
};

function keyVk(key: string): number {
  const k = key.toLowerCase();
  if (VK[k] !== undefined) return VK[k];
  if (/^[a-z]$/.test(k)) return k.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(k)) return k.charCodeAt(0);
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(k)) return 0x70 + (parseInt(k.slice(1), 10) - 1);
  // Default: treat single printable characters by their uppercase virtual key.
  return k.toUpperCase().charCodeAt(0);
}

export async function keyPress(key: string, modifiers: string[] = []): Promise<ShellResult> {
  const vk = keyVk(key);
  const mods = modifiers.map(keyVk);
  const lines: string[] = [];
  const down = (code: number) => `[NxInput]::keybd_event([byte]${code}, 0, 0, [UIntPtr]::Zero)`;
  const up = (code: number) => `[NxInput]::keybd_event([byte]${code}, 0, ${0x0002}, [UIntPtr]::Zero)`;
  for (const m of mods) lines.push(down(m));
  lines.push(down(vk));
  lines.push(up(vk));
  for (const m of [...mods].reverse()) lines.push(up(m));
  return runShell(inputScript(lines.join('\n')), { shell: 'powershell', timeoutMs: 5000 });
}

/** Escape characters that SendKeys treats as modifiers. */
function escapeSendKeys(text: string): string {
  const escaped = text.replace(/[+^%~(){}\[\]]/g, (c) => `{${c}}`);
  return escaped.replace(/\r?\n/g, '{ENTER}');
}

export async function typeText(text: string): Promise<ShellResult> {
  const safe = escapeSendKeys(text).replace(/'/g, "''");
  const cmd = `(New-Object -ComObject WScript.Shell).SendKeys('${safe}')`;
  return runShell(cmd, { shell: 'powershell', timeoutMs: 10000 });
}
