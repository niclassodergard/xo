export interface LoginLimiterOptions {
  now: () => Date;
  perIpMax?: number;
  globalMax?: number;
  perDeviceMax?: number;
  windowMs?: number;
}

export interface LimitResult { allowed: boolean; retryAfterSeconds: number }

export interface LoginLimiter {
  /**
   * Reserve an attempt. Called BEFORE any credential check, so a locked-out caller costs no scrypt work
   * and concurrent requests cannot slip past the limit. When not allowed nothing is recorded.
   * With `deviceId` (a verified trusted-device id) only that device's own bucket applies: the per-IP
   * and global limits neither block nor count the attempt. Without it, the per-IP and global limits apply.
   */
  attempt(ip: string, deviceId?: string | null): LimitResult;
  /** Give back the attempt reserved by `attempt` (call on a successful login only). */
  succeed(ip: string, deviceId?: string | null): void;
}

const SWEEP_THRESHOLD = 1024;

/** In-memory sliding-window limiter on login attempts: per device, per IP and global. */
export function createLoginLimiter(opts: LoginLimiterOptions): LoginLimiter {
  const perIpMax = opts.perIpMax ?? 5;
  const globalMax = opts.globalMax ?? 20;
  const perDeviceMax = opts.perDeviceMax ?? 5;
  const windowMs = opts.windowMs ?? 15 * 60_000;
  const byIp = new Map<string, number[]>();
  const byDevice = new Map<string, number[]>();
  let global: number[] = [];

  const fresh = (list: number[], cutoff: number): number[] => {
    let i = 0;
    while (i < list.length && (list[i] as number) <= cutoff) i++;
    return i === 0 ? list : list.slice(i);
  };
  // Seconds until the entry that blocks us (the one `max` back from the end) leaves the window.
  const wait = (list: number[], max: number, nowMs: number): number =>
    Math.max(1, Math.ceil(((list[list.length - max] as number) + windowMs - nowMs) / 1000));
  const sweep = (map: Map<string, number[]>, cutoff: number): void => {
    if (map.size < SWEEP_THRESHOLD) return;
    for (const [k, v] of map) {
      const f = fresh(v, cutoff);
      if (f.length === 0) map.delete(k);
      else map.set(k, f);
    }
  };
  const store = (map: Map<string, number[]>, key: string, list: number[]): void => {
    if (list.length > 0) map.set(key, list);
    else map.delete(key);
  };
  const pop = (map: Map<string, number[]>, key: string): void => {
    const list = map.get(key);
    if (list && list.length > 0) {
      list.pop();
      store(map, key, list);
    }
  };

  return {
    attempt(ip, deviceId) {
      const nowMs = opts.now().getTime();
      const cutoff = nowMs - windowMs;
      if (deviceId) {
        sweep(byDevice, cutoff);
        const mine = fresh(byDevice.get(deviceId) ?? [], cutoff);
        if (mine.length >= perDeviceMax) {
          store(byDevice, deviceId, mine);
          return { allowed: false, retryAfterSeconds: wait(mine, perDeviceMax, nowMs) };
        }
        mine.push(nowMs);
        byDevice.set(deviceId, mine);
        return { allowed: true, retryAfterSeconds: 0 };
      }
      global = fresh(global, cutoff);
      sweep(byIp, cutoff);
      const mine = fresh(byIp.get(ip) ?? [], cutoff);
      let retry = 0;
      if (mine.length >= perIpMax) retry = Math.max(retry, wait(mine, perIpMax, nowMs));
      if (global.length >= globalMax) retry = Math.max(retry, wait(global, globalMax, nowMs));
      if (retry > 0) {
        store(byIp, ip, mine);
        return { allowed: false, retryAfterSeconds: retry };
      }
      mine.push(nowMs);
      byIp.set(ip, mine);
      global.push(nowMs);
      return { allowed: true, retryAfterSeconds: 0 };
    },
    succeed(ip, deviceId) {
      if (deviceId) {
        pop(byDevice, deviceId);
        return;
      }
      pop(byIp, ip);
      global.pop();
    },
  };
}
