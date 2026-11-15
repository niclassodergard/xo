import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';
import type { LoadConfigOptions, ReadFile } from './config.ts';

// A made-up value that only exists in this test file.
const KEY = 'sk-test-not-a-real-key-123';
const noFile: ReadFile = () => null;
const quiet: LoadConfigOptions = { warn: () => {}, fileMode: () => 0o600 };
const load = (env: NodeJS.ProcessEnv, read: ReadFile = noFile) => loadConfig(env, read, quiet);

describe('loadConfig defaults', () => {
  it('uses documented defaults', () => {
    const { config: c, openRouterApiKey } = load({});
    expect(c.host).toBe('127.0.0.1');
    expect(c.port).toBe(3000);
    expect(c.publicOrigin).toBe('http://localhost:5173');
    expect(c.trustProxy).toBe(false);
    expect(c.cookieInsecure).toBe(false);
    expect(c.production).toBe(false);
    expect(c.sessionTtlDays).toBe(30);
    expect(c.sessionIdleDays).toBe(7);
    expect(c.llmModel).toBe('anthropic/claude-haiku-4.5');
    expect(c.sttModel).toBe('openai/whisper-1');
    expect(c.qaModel).toBe('anthropic/claude-sonnet-5.5');
    expect(c.classifyThreshold).toBe(0.8);
    expect(c.llm).toBe('openrouter');
    expect(c.openRouterZdr).toBe(false);
    expect(openRouterApiKey).toBeNull();
    expect(c.dbPath.endsWith('/.xo/xo.db')).toBe(true);
  });

  it('reads overrides', () => {
    const { config: c } = load({ XO_PORT: '8080', XO_HOST: '0.0.0.0', XO_CLASSIFY_THRESHOLD: '0.5', XO_LLM: 'fake', XO_DB_PATH: '/data/x.db' });
    expect(c).toMatchObject({ port: 8080, host: '0.0.0.0', classifyThreshold: 0.5, llm: 'fake', dbPath: '/data/x.db' });
  });

  it('passes :memory: through unresolved', () => {
    expect(load({ XO_DB_PATH: ':memory:' }).config.dbPath).toBe(':memory:');
  });
});

describe('loadConfig validation', () => {
  it.each([
    [{ XO_PORT: 'abc' }],
    [{ XO_PORT: '0' }],
    [{ XO_PORT: '70000' }],
    [{ XO_PORT: '1.5' }],
    [{ XO_SESSION_TTL_DAYS: '-1' }],
    [{ XO_SESSION_IDLE_DAYS: 'x' }],
    [{ XO_SESSION_TTL_DAYS: '5', XO_SESSION_IDLE_DAYS: '6' }],
    [{ XO_CLASSIFY_THRESHOLD: '1.5' }],
    [{ XO_LLM: 'other' }],
    [{ XO_PUBLIC_ORIGIN: 'not a url' }],
    [{ XO_PUBLIC_ORIGIN: 'ftp://example.com' }],
    [{ XO_PUBLIC_ORIGIN: 'https://example.com/path' }],
    [{ XO_PUBLIC_ORIGIN: 'https://user:pw@example.com' }],
    [{ XO_PUBLIC_ORIGIN: 'http://xo.example.com' }],
  ])('rejects %j', (env) => {
    expect(() => load(env)).toThrow();
  });

  it('normalises the origin via URL (case, default port, trailing slash)', () => {
    expect(load({ XO_PUBLIC_ORIGIN: 'HTTPS://XO.Example.com:443/' }).config.publicOrigin).toBe('https://xo.example.com');
  });

  it('allows an http origin only on loopback hosts', () => {
    for (const o of ['http://localhost:5173', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
      expect(load({ XO_PUBLIC_ORIGIN: o }).config.publicOrigin).toBe(o);
    }
  });

  it('refuses XO_COOKIE_INSECURE in production', () => {
    expect(() => load({ NODE_ENV: 'production', XO_COOKIE_INSECURE: 'true', XO_PUBLIC_ORIGIN: 'https://xo.example.com' })).toThrow(/XO_COOKIE_INSECURE/);
  });

  it('allows XO_COOKIE_INSECURE only for a loopback origin and loopback host', () => {
    expect(load({ XO_COOKIE_INSECURE: 'true' }).config.cookieInsecure).toBe(true);
    expect(() => load({ XO_COOKIE_INSECURE: 'true', XO_PUBLIC_ORIGIN: 'https://xo.example.com' })).toThrow(/XO_COOKIE_INSECURE/);
    expect(() => load({ XO_COOKIE_INSECURE: 'true', XO_HOST: '0.0.0.0' })).toThrow(/XO_HOST/);
    expect(() => load({ XO_COOKIE_INSECURE: 'true', XO_HOST: '192.168.1.5' })).toThrow(/XO_HOST/);
    expect(load({ XO_COOKIE_INSECURE: 'true', XO_HOST: '::1' }).config.cookieInsecure).toBe(true);
  });

  it('requires XO_PUBLIC_ORIGIN in production', () => {
    expect(() => load({ NODE_ENV: 'production' })).toThrow(/XO_PUBLIC_ORIGIN/);
  });

  it('requires https in production even on loopback', () => {
    expect(() => load({ NODE_ENV: 'production', XO_PUBLIC_ORIGIN: 'http://localhost:3000' })).toThrow(/https/);
  });

  it('accepts a production config', () => {
    expect(load({ NODE_ENV: 'production', XO_PUBLIC_ORIGIN: 'https://xo.example.com' }).config.production).toBe(true);
  });
});

describe('XO_TRUST_PROXY', () => {
  it('parses false, hop counts and IP/CIDR lists', () => {
    expect(load({}).config.trustProxy).toBe(false);
    expect(load({ XO_TRUST_PROXY: 'false' }).config.trustProxy).toBe(false);
    expect(load({ XO_TRUST_PROXY: '1' }).config.trustProxy).toBe(1);
    expect(load({ XO_TRUST_PROXY: '10.0.0.1, 172.16.0.0/12,::1' }).config.trustProxy).toEqual(['10.0.0.1', '172.16.0.0/12', '::1']);
  });

  it.each(['true', '0', '-1', 'yes', '1.5', '0.0.0.0/0', '10.0.0.0/33', '10.0.0.1/', 'not-an-ip', '10.0.0.1,', '10.0.0.1/8/8'])('rejects %s', (v) => {
    expect(() => load({ XO_TRUST_PROXY: v })).toThrow(/XO_TRUST_PROXY/);
  });
});

describe('API key loading', () => {
  it('env var wins over the file and the file is not read', () => {
    let reads = 0;
    const r = load({ OPENROUTER_API_KEY: KEY }, () => { reads++; return 'file-key'; });
    expect(r.openRouterApiKey).toBe(KEY);
    expect(reads).toBe(0);
  });

  it('falls back to the file, trimmed', () => {
    expect(load({}, () => `  ${KEY}\n`).openRouterApiKey).toBe(KEY);
  });

  it('treats an empty env var as unset', () => {
    expect(load({ OPENROUTER_API_KEY: '  ' }, () => KEY).openRouterApiKey).toBe(KEY);
  });

  it('defaults to ./.openrouter-key and honours OPENROUTER_KEY_FILE', () => {
    const paths: string[] = [];
    load({}, (p) => { paths.push(p); return null; });
    load({ OPENROUTER_KEY_FILE: '/run/secrets/or' }, (p) => { paths.push(p); return null; });
    expect(paths[0]?.endsWith('/.openrouter-key')).toBe(true);
    expect(paths[1]).toBe('/run/secrets/or');
  });

  it('missing file means no key and no error', () => {
    expect(load({}, () => null).openRouterApiKey).toBeNull();
  });

  it('loadApiKey:false never touches the file or the env key', () => {
    let reads = 0;
    const r = loadConfig({ OPENROUTER_API_KEY: KEY }, () => { reads++; return KEY; }, { ...quiet, loadApiKey: false });
    expect(reads).toBe(0);
    expect(r.openRouterApiKey).toBeNull();
  });

  it('empty file is an error that does not leak content', () => {
    expect(() => load({}, () => ' \n')).toThrow(/empty/);
  });

  it('unreadable file is an error without the underlying message', () => {
    try {
      load({}, () => { throw new Error(`EACCES ${KEY}`); });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toMatch(/could not be read/);
      expect((err as Error).message).not.toContain(KEY);
    }
  });

  it('warns (path only) when the key file is group/world accessible', () => {
    const warnings: string[] = [];
    loadConfig({ OPENROUTER_KEY_FILE: '/x/key' }, () => KEY, { warn: (m) => warnings.push(m), fileMode: () => 0o644 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('/x/key');
    expect(warnings[0]).not.toContain(KEY);
    const none: string[] = [];
    loadConfig({ OPENROUTER_KEY_FILE: '/x/key' }, () => KEY, { warn: (m) => none.push(m), fileMode: () => 0o600 });
    expect(none).toEqual([]);
  });

  it('keeps the key out of config, JSON, inspect, spread and error messages', () => {
    const r = load({ OPENROUTER_API_KEY: KEY });
    expect(r.openRouterApiKey).toBe(KEY);
    for (const v of [JSON.stringify(r), inspect(r), JSON.stringify({ ...r }), JSON.stringify(r.config), inspect(r.config), JSON.stringify({ ...r.config })]) {
      expect(v).not.toContain(KEY);
    }
    expect(Object.values(r.config)).not.toContain(KEY);
    try {
      load({ OPENROUTER_API_KEY: KEY, XO_PORT: 'bad' });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain(KEY);
    }
  });
});

describe('OpenRouter ZDR and model slugs', () => {
  it('parses XO_OPENROUTER_ZDR', () => {
    expect(load({ XO_OPENROUTER_ZDR: 'true' }).config.openRouterZdr).toBe(true);
    expect(load({ XO_OPENROUTER_ZDR: '0' }).config.openRouterZdr).toBe(false);
    expect(() => load({ XO_OPENROUTER_ZDR: 'maybe' })).toThrow(/XO_OPENROUTER_ZDR/);
  });

  it('accepts vendor/name slugs', () => {
    const { config } = load({ XO_LLM_MODEL: 'google/gemini-2.5-flash', XO_STT_MODEL: 'openai/whisper-large-v3' });
    expect(config.llmModel).toBe('google/gemini-2.5-flash');
    expect(load({ XO_QA_MODEL: 'anthropic/claude-sonnet-4.6' }).config.qaModel).toBe('anthropic/claude-sonnet-4.6');
  });

  it('rejects variant suffixes and malformed slugs', () => {
    for (const bad of ['anthropic/claude-haiku-4.5:online', 'noslash', 'a/b/c', '/x', 'a b/c']) {
      expect(() => load({ XO_LLM_MODEL: bad })).toThrow(/XO_LLM_MODEL/);
      expect(() => load({ XO_STT_MODEL: bad })).toThrow(/XO_STT_MODEL/);
      expect(() => load({ XO_QA_MODEL: bad })).toThrow(/XO_QA_MODEL/);
    }
  });
});
