/**
 * Bounded admission for credentialed HTTP file/sync traffic.
 *
 * Every transfer reserves its worst-case bytes before any stream or upstream
 * request starts. Completion replaces that reservation with rolling-window
 * byte debt. This makes parallel requests unable to oversubscribe the budget,
 * while aborted/failed requests still pay for bytes already handled.
 */

export interface FileTransferAdmissionOptions {
  globalActive: number;
  principalActive: number;
  windowMs: number;
  globalBytes: number;
  principalBytes: number;
  maxPrincipals: number;
}

interface ByteSample { at: number; bytes: number }
interface PrincipalState {
  active: number;
  reserved: number;
  samples: ByteSample[];
  lastSeen: number;
}

export interface FileTransferLease {
  settle(actualBytes?: number, now?: number): void;
}

export class FileTransferAdmissionError extends Error {
  readonly status = 429;
}

const DEFAULTS: FileTransferAdmissionOptions = {
  globalActive: 8,
  principalActive: 2,
  windowMs: 15 * 60_000,
  globalBytes: 16 * 1024 * 1024 * 1024,
  principalBytes: 4 * 1024 * 1024 * 1024,
  maxPrincipals: 2_048,
};

function boundedBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('전송 예약 크기가 올바르지 않습니다.');
  return value;
}

function sum(samples: ByteSample[]): number {
  return samples.reduce((total, sample) => total + sample.bytes, 0);
}

export class FileTransferAdmission {
  private readonly options: FileTransferAdmissionOptions;
  private readonly principals = new Map<string, PrincipalState>();
  private globalActive = 0;
  private globalReserved = 0;
  private globalSamples: ByteSample[] = [];

  constructor(options: Partial<FileTransferAdmissionOptions> = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  acquire(principalValue: string, reservationValue: number, now = Date.now()): FileTransferLease {
    const principal = String(principalValue).slice(0, 256);
    if (!principal) throw new FileTransferAdmissionError('전송 주체를 확인할 수 없습니다.');
    const reservation = boundedBytes(reservationValue);
    this.prune(now);

    let state = this.principals.get(principal);
    if (!state) {
      if (this.principals.size >= this.options.maxPrincipals) {
        throw new FileTransferAdmissionError('전송 주체 한도가 찼습니다. 잠시 후 다시 시도하세요.');
      }
      state = { active: 0, reserved: 0, samples: [], lastSeen: now };
      this.principals.set(principal, state);
    }
    state.lastSeen = now;

    if (this.globalActive >= this.options.globalActive) {
      throw new FileTransferAdmissionError('이 PC에서 동시에 처리할 수 있는 파일 전송 수를 초과했습니다.');
    }
    if (state.active >= this.options.principalActive) {
      throw new FileTransferAdmissionError('이 기기의 동시 파일 전송 수를 초과했습니다.');
    }
    if (sum(this.globalSamples) + this.globalReserved + reservation > this.options.globalBytes) {
      throw new FileTransferAdmissionError('이 PC의 파일 전송 사용량 한도에 도달했습니다. 잠시 후 다시 시도하세요.');
    }
    if (sum(state.samples) + state.reserved + reservation > this.options.principalBytes) {
      throw new FileTransferAdmissionError('이 기기의 파일 전송 사용량 한도에 도달했습니다. 잠시 후 다시 시도하세요.');
    }

    state.active += 1;
    state.reserved += reservation;
    this.globalActive += 1;
    this.globalReserved += reservation;
    let open = true;

    return {
      settle: (actualValue = 0, settledAt = Date.now()): void => {
        if (!open) return;
        open = false;
        const actual = boundedBytes(actualValue);
        state!.active = Math.max(0, state!.active - 1);
        state!.reserved = Math.max(0, state!.reserved - reservation);
        state!.lastSeen = settledAt;
        this.globalActive = Math.max(0, this.globalActive - 1);
        this.globalReserved = Math.max(0, this.globalReserved - reservation);
        if (actual > 0) {
          state!.samples.push({ at: settledAt, bytes: actual });
          this.globalSamples.push({ at: settledAt, bytes: actual });
        }
        this.prune(settledAt);
      },
    };
  }

  snapshot(): { active: number; reserved: number; principals: number; bytes: number } {
    return {
      active: this.globalActive,
      reserved: this.globalReserved,
      principals: this.principals.size,
      bytes: sum(this.globalSamples),
    };
  }

  private prune(now: number): void {
    const cutoff = now - this.options.windowMs;
    this.globalSamples = this.globalSamples.filter((sample) => sample.at > cutoff);
    for (const [principal, state] of this.principals) {
      state.samples = state.samples.filter((sample) => sample.at > cutoff);
      if (state.active === 0 && state.reserved === 0 && state.samples.length === 0) this.principals.delete(principal);
    }
  }
}
