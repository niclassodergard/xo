import { describe, expect, it } from 'vitest';
import { parseCapture } from './capture-syntax.ts';

describe('parseCapture prefixes', () => {
  it.each([
    ['/note a', 'note', null],
    ['/n a', 'note', null],
    ['/todo a', 'action', 'me'],
    ['/t a', 'action', 'me'],
    ['/action a', 'action', 'me'],
    ['/wait a', 'action', 'them'],
    ['/w a', 'action', 'them'],
    ['/agenda a', 'agenda', null],
    ['/a a', 'agenda', null],
    ['/TODO a', 'action', 'me'],
  ])('%s', (raw, kind, owner) => {
    expect(parseCapture(raw)).toEqual({ forcedKind: kind, forcedOwner: owner, mentions: [], text: 'a' });
  });

  it('accepts a bare command with no text', () => {
    expect(parseCapture('/todo')).toMatchObject({ forcedKind: 'action', text: '' });
  });

  it('leaves unknown commands alone', () => {
    expect(parseCapture('/xyz hello')).toEqual({ forcedKind: null, forcedOwner: null, mentions: [], text: '/xyz hello' });
    expect(parseCapture('/todos hello').forcedKind).toBeNull();
  });

  it('only recognises a leading command', () => {
    expect(parseCapture('call /todo later').forcedKind).toBeNull();
    expect(parseCapture('/todo/x')).toMatchObject({ forcedKind: null, text: '/todo/x' });
  });

  it('plain text and surrounding whitespace', () => {
    expect(parseCapture('  hello world \n')).toEqual({ forcedKind: null, forcedOwner: null, mentions: [], text: 'hello world' });
    expect(parseCapture('')).toMatchObject({ text: '', mentions: [] });
  });
});

describe('parseCapture mentions', () => {
  it('@name becomes the plain name', () => {
    expect(parseCapture('/wait @anna budget numbers')).toEqual({
      forcedKind: 'action', forcedOwner: 'them', mentions: ['anna'], text: 'anna budget numbers',
    });
  });

  it('quoted full names', () => {
    expect(parseCapture('/agenda @"Anna Berg" hiring plan')).toMatchObject({
      mentions: ['Anna Berg'], text: 'Anna Berg hiring plan',
    });
  });

  it('mid-sentence, with punctuation, several mentions', () => {
    const r = parseCapture('Ask @Åsa, and @Björn.');
    expect(r.mentions).toEqual(['Åsa', 'Björn']);
    expect(r.text).toBe('Ask Åsa, and Björn.');
  });

  it('possessive and hyphenated names', () => {
    expect(parseCapture('see @Anna\'s plan')).toMatchObject({ mentions: ['Anna'], text: "see Anna's plan" });
    expect(parseCapture('ping @Anna-Lisa')).toMatchObject({ mentions: ['Anna-Lisa'] });
  });

  it('does not treat e-mail addresses or a lone @ as mentions', () => {
    expect(parseCapture('mail bo@example.com now')).toMatchObject({ mentions: [], text: 'mail bo@example.com now' });
    expect(parseCapture('meet @ noon')).toMatchObject({ mentions: [], text: 'meet @ noon' });
    expect(parseCapture('@"" x')).toMatchObject({ mentions: [] });
  });

  it('mention right after the prefix', () => {
    expect(parseCapture('/note @anna likes tea')).toMatchObject({ forcedKind: 'note', mentions: ['anna'] });
  });
});

describe('parseCapture robustness', () => {
  it('accepts curly and Swedish quotes', () => {
    for (const raw of ['/agenda @”Anna Berg” budget', '/agenda @„Anna Berg“ budget', '/agenda @“Anna Berg” budget']) {
      expect(parseCapture(raw)).toMatchObject({ mentions: ['Anna Berg'], text: 'Anna Berg budget' });
    }
  });

  it('normalises decomposed input', () => {
    const r = parseCapture('ring @Åsa idag');
    expect(r.mentions).toEqual(['Åsa']);
    expect(r.text).toBe('ring Åsa idag');
  });

  it('/todo@anna is neither a command nor a mention', () => {
    expect(parseCapture('/todo@anna call')).toEqual({ forcedKind: null, forcedOwner: null, mentions: [], text: '/todo@anna call' });
  });

  it('stays fast on pathological input', () => {
    const t0 = Date.now();
    parseCapture('@' + '-'.repeat(20000));
    parseCapture('@"'.repeat(5000));
    parseCapture('@a'.repeat(5000));
    parseCapture(', '.repeat(5000));
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
