import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { isIP } from 'node:net';

export type TrustProxy = false | number | string[];

/** Shared config handed to route modules. It never contains the OpenRouter API key. */
export interface Config {
  dbPath: string;
  host: string;
  port: number;
  publicOrigin: string;
  trustProxy: TrustProxy;
  cookieInsecure: boolean;
  production: boolean;
  sessionTtlDays: number;
  sessionIdleDays: number;
  llmModel: string;
  sttModel: string;
  /** Model for question answering (XO_QA_MODEL). */
  qaModel: string;
  classifyThreshold: number;
  /** Send `provider.zdr: true` on every OpenRouter request (XO_OPENROUTER_ZDR, default false). */
  openRouterZdr: boolean;
  llm: 'openrouter' | 'fake';
}

export interface LoadedConfig {
  config: Config;
  /**
   * The API key is returned separately so it never travels inside `deps.config`. The property is
   * non-enumerable: JSON.stringify, util.inspect and object spread of this result do not expose it.
   * Hand it only to the OpenRouter factory in main.ts. Never log it.
   */
  readonly openRouterApiKey: string | null;
}

export type ReadFile = (path: string) => string | null;

export interface LoadConfigOptions {
  /** Set false (CLI setup/export) to never touch the key file. Default true. */
  loadApiKey?: boolean;
  /** Receives warnings; messages never contain secrets. Default console.warn. */
  warn?: (message: string) => void;
  /** Returns permission bits of a file, or null if unknown. Injected in tests. */
  fileMode?: (path: string) => number | null;
}

/** Real file read: a missing file is `null`; any other failure is reported without file content. */
export const defaultReadFile: ReadFile = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('file could not be read');
  }
};

const defaultFileMode = (path: string): number | null => {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
};

function str(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const v = env[name]?.trim();
  return v ? v : undefined;
}

function bool(env: NodeJS.ProcessEnv, name: string, def: boolean): boolean {
  const v = str(env, name);
  if (v === undefined) return def;
  const l = v.toLowerCase();
  if (l === 'true' || l === '1') return true;
  if (l === 'false' || l === '0') return false;
  throw new Error(`${name} must be true or false`);
}

function num(env: NodeJS.ProcessEnv, name: string, def: number, min: number, max: number, integer: boolean): number {
  const v = str(env, name);
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    throw new Error(`${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`);
  }
  return n;
}

/** `vendor/name`, no `:variant` suffix (`:online` would enable web-search plugins on OpenRouter). */
function modelSlug(env: NodeJS.ProcessEnv, name: string, def: string): string {
  const v = str(env, name) ?? def;
  if (!/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(v)) {
    throw new Error(`${name} must be a model slug like vendor/name (no ":" variant suffix)`);
  }
  return v;
}

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'localhost' || h === '::1' || h === '[::1]' || /^127(\.\d{1,3}){3}$/.test(h);
}

/** `false`, a hop count (>= 1), or a comma-separated list of IPs / CIDRs. Never `true`. */
function parseTrustProxy(env: NodeJS.ProcessEnv): TrustProxy {
  const v = str(env, 'XO_TRUST_PROXY');
  const bad = new Error(
    'XO_TRUST_PROXY must be false, a hop count (integer >= 1) or a comma-separated list of proxy IPs/CIDRs ' +
      '("true" is refused: it would let any client spoof X-Forwarded-For)',
  );
  if (v === undefined || v.toLowerCase() === 'false') return false;
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    if (n < 1 || n > 32) throw bad;
    return n;
  }
  const parts = v.split(',').map((p) => p.trim());
  for (const p of parts) {
    const [ip, prefix, extra] = p.split('/');
    const family = ip ? isIP(ip) : 0;
    if (!family || extra !== undefined) throw bad;
    if (prefix !== undefined) {
      if (!/^\d+$/.test(prefix)) throw bad;
      const n = Number(prefix);
      if (n < 1 || n > (family === 4 ? 32 : 128)) throw bad; // /0 would trust everyone
    }
  }
  return parts;
}

function parseOrigin(env: NodeJS.ProcessEnv, production: boolean): URL {
  const v = str(env, 'XO_PUBLIC_ORIGIN');
  const shape = new Error('XO_PUBLIC_ORIGIN must be an origin such as https://xo.example.com');
  if (v === undefined) {
    if (production) throw new Error('XO_PUBLIC_ORIGIN is required in production');
    return new URL('http://localhost:5173');
  }
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw shape;
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || u.search || u.hash || u.pathname !== '/') {
    throw shape;
  }
  if (u.protocol === 'http:' && !isLoopbackHost(u.hostname)) {
    throw new Error('XO_PUBLIC_ORIGIN must use https unless the host is localhost, 127.0.0.1 or [::1]');
  }
  return u;
}

function loadApiKey(env: NodeJS.ProcessEnv, readFile: ReadFile, opts: LoadConfigOptions): string | null {
  const fromEnv = str(env, 'OPENROUTER_API_KEY');
  if (fromEnv) return fromEnv;
  const path = resolve(str(env, 'OPENROUTER_KEY_FILE') ?? './.openrouter-key');
  let content: string | null;
  try {
    content = readFile(path);
  } catch {
    // Deliberately drop the underlying error: it must never carry file content.
    throw new Error('OPENROUTER_KEY_FILE could not be read');
  }
  if (content === null) return null;
  const key = content.trim();
  if (!key) throw new Error('OPENROUTER_KEY_FILE is empty');
  const mode = (opts.fileMode ?? defaultFileMode)(path);
  if (mode !== null && (mode & 0o077) !== 0) {
    (opts.warn ?? console.warn)(`OPENROUTER_KEY_FILE ${path} is accessible by group/others; run chmod 600 on it`);
  }
  return key;
}

export function loadConfig(
  env: NodeJS.ProcessEnv,
  readFile: ReadFile = defaultReadFile,
  opts: LoadConfigOptions = {},
): LoadedConfig {
  const production = env['NODE_ENV'] === 'production';
  const origin = parseOrigin(env, production);
  if (production && origin.protocol !== 'https:') {
    throw new Error('XO_PUBLIC_ORIGIN must use https in production');
  }
  const host = str(env, 'XO_HOST') ?? '127.0.0.1';
  const cookieInsecure = bool(env, 'XO_COOKIE_INSECURE', false);
  if (cookieInsecure) {
    if (production) throw new Error('XO_COOKIE_INSECURE must not be set when NODE_ENV=production');
    if (!isLoopbackHost(origin.hostname)) {
      throw new Error('XO_COOKIE_INSECURE is only allowed when XO_PUBLIC_ORIGIN is localhost, 127.0.0.1 or [::1]');
    }
    if (!isLoopbackHost(host)) {
      throw new Error('XO_COOKIE_INSECURE is only allowed when XO_HOST is a loopback address');
    }
  }
  const llm = str(env, 'XO_LLM') ?? 'openrouter';
  if (llm !== 'openrouter' && llm !== 'fake') throw new Error('XO_LLM must be openrouter or fake');

  const sessionTtlDays = num(env, 'XO_SESSION_TTL_DAYS', 30, 1, 3650, false);
  const sessionIdleDays = num(env, 'XO_SESSION_IDLE_DAYS', 7, 1, 3650, false);
  if (sessionIdleDays > sessionTtlDays) {
    throw new Error('XO_SESSION_IDLE_DAYS must not exceed XO_SESSION_TTL_DAYS');
  }

  const dbEnv = str(env, 'XO_DB_PATH');
  const config: Config = {
    dbPath: dbEnv === ':memory:' ? dbEnv : resolve(dbEnv ?? `${homedir()}/.xo/xo.db`),
    host,
    port: num(env, 'XO_PORT', 3000, 1, 65535, true),
    publicOrigin: origin.origin,
    trustProxy: parseTrustProxy(env),
    cookieInsecure,
    production,
    sessionTtlDays,
    sessionIdleDays,
    llmModel: modelSlug(env, 'XO_LLM_MODEL', 'anthropic/claude-haiku-4.5'),
    sttModel: modelSlug(env, 'XO_STT_MODEL', 'openai/whisper-1'),
    qaModel: modelSlug(env, 'XO_QA_MODEL', 'anthropic/claude-sonnet-5.5'),
    openRouterZdr: bool(env, 'XO_OPENROUTER_ZDR', false),
    classifyThreshold: num(env, 'XO_CLASSIFY_THRESHOLD', 0.8, 0, 1, false),
    llm,
  };
  const key = opts.loadApiKey === false ? null : loadApiKey(env, readFile, opts);
  const result = { config } as { config: Config; openRouterApiKey: string | null };
  Object.defineProperty(result, 'openRouterApiKey', { value: key, enumerable: false });
  return result;
}
