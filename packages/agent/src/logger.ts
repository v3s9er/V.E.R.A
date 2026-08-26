import { EventBus } from './eventbus.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: number;
  level: LogLevel;
  scope: string;
  message: string;
}

export class Logger {
  constructor(
    private bus: EventBus,
    private scope: string,
  ) {}

  private write(level: LogLevel, message: string): void {
    const entry: LogEntry = { ts: Date.now(), level, scope: this.scope, message };
    this.bus.emit('log', entry);

    // Desktop builds can outlive the terminal that launched them. Windows then
    // reports EPIPE when console.* writes to the closed inherited pipe. Logging
    // must never bring down the in-process agent or Electron main process.
    try {
      // eslint-disable-next-line no-console
      (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(
        `[${level}] [${this.scope}] ${message}`,
      );
    } catch {
      // The structured event above remains available to the UI/log subscribers.
    }
  }

  debug(message: string): void {
    if (process.env.MR_ROBOT_DEBUG === '1') this.write('debug', message);
  }

  info(message: string): void {
    this.write('info', message);
  }

  warn(message: string): void {
    this.write('warn', message);
  }

  error(message: string): void {
    this.write('error', message);
  }

  child(scope: string): Logger {
    return new Logger(this.bus, `${this.scope}:${scope}`);
  }
}
