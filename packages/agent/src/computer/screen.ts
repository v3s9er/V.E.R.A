import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ScreenFrame, ScreenSize } from '@mr-robot/shared';
import { runShell } from './shell.js';

const SIZE_PS = `Add-Type -AssemblyName System.Windows.Forms
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
Write-Output ($b.Width.ToString() + ',' + $b.Height.ToString() + ',' + $b.X.ToString() + ',' + $b.Y.ToString())`;

const CAPTURE_PS = `Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
$g.Dispose()
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$ep = New-Object System.Drawing.Imaging.EncoderParameters 1
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([long]$env:MR_ROBOT_Q)
$bmp.Save($env:MR_ROBOT_CAP, $codec, $ep)
$bmp.Dispose()`;

export async function screenSize(): Promise<ScreenSize> {
  const res = await runShell(SIZE_PS, { shell: 'powershell', timeoutMs: 8000 });
  const m = /(\d+),(\d+)/.exec(res.stdout.trim());
  if (m) return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
  return { width: 0, height: 0 };
}

/** Capture the virtual screen to a JPEG data URL. */
export async function captureScreen(quality = 70): Promise<ScreenFrame> {
  const q = Math.max(10, Math.min(100, Math.round(quality)));
  const path = join(tmpdir(), `mr-robot-cap-${randomBytes(6).toString('hex')}.jpg`);
  const res = await runShell(CAPTURE_PS, {
    shell: 'powershell',
    timeoutMs: 15000,
    env: { MR_ROBOT_CAP: path, MR_ROBOT_Q: String(q) },
  });
  if (!res.ok) {
    return { dataUrl: '', width: 0, height: 0, ts: Date.now() };
  }
  try {
    const buf = await fs.readFile(path);
    const size = await screenSize();
    return {
      dataUrl: `data:image/jpeg;base64,${buf.toString('base64')}`,
      width: size.width,
      height: size.height,
      ts: Date.now(),
    };
  } finally {
    await fs.rm(path, { force: true }).catch(() => undefined);
  }
}
