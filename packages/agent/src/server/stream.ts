import type { ScreenFrame } from '@mr-robot/shared';
import { captureScreen } from '../computer/screen.js';

/**
 * Per-client screen streaming for the remote-control mode. Frames are pushed
 * as `computer.stream.frame` events at a bounded FPS; captures never overlap
 * (a slow capture skips the next tick instead of queueing), and `stop()` /
 * disconnect always clears the interval — no leaked timers.
 */
export class ScreenStreamController {
  private timer: NodeJS.Timeout | null = null;
  private capturing = false;
  private stopped = false;

  constructor(private readonly send: (frame: ScreenFrame) => void) {}

  start(fps = 2, quality = 60): void {
    this.stop();
    this.stopped = false;
    const clamped = Math.max(0.5, Math.min(10, fps));
    const interval = Math.max(150, Math.round(1000 / clamped));
    const tick = async (): Promise<void> => {
      if (this.capturing || this.stopped) return;
      this.capturing = true;
      try {
        const frame = await captureScreen(quality);
        if (!this.stopped && frame.dataUrl) this.send(frame);
      } catch {
        /* skip unreadable frame */
      } finally {
        this.capturing = false;
      }
    };
    this.timer = setInterval(() => {
      void tick();
    }, interval);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
