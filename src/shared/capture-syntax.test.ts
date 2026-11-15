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
    ['/ask a', 'question', null],
    ['/q a', 'question', null],
    ['/ASK a', 'question', null],
  ])('%s', (raw, kind, owner) => {
    expect(parseCapture(raw)).toEqual({ forcedKind: kind, forcedOwner: owner, mentions: [], projectMentions: [], text: 'a' });
  });

  it('accepts a bare command with no text', () => {
    expect(parseCapture('/todo')).toMatchObject({ forcedKind: 'action', text: '' });
  });

  it('leaves unknown commands alone', () => {
    expect(parseCapture('/xyz hello')).toEqual({ forcedKind: null, forcedOwner: null, mentions: [], projectMentions: [], text: '/xyz hello' });
    expect(parseCapture('/todos hello').forcedKind).toBeNull();
  });

  it('only recognises a leading command', () => {
    expect(parseCapture('call /todo later').forcedKind).toBeNull();
    expect(parseCapture('/todo/x')).toMatchObject({ forcedKind: null, text: '/todo/x' });
  });

  it('plain text and surrounding whitespace', () => {
    expect(parseCapture('  hello world \n')).toEqual({ forcedKind: null, forcedOwner: null, mentions: [], projectMentions: [], text: 'hello world' });
    expect(parseCapture('')).toMatchObject({ text: '', mentions: [] });
  });
});

describe('parseCapture mentions', () => {
  it('@name becomes the plain name', () => {
    expect(parseCapture('/wait @anna budget numbers')).toEqual({
      forcedKind: 'action', forcedOwner: 'them', mentions: ['anna'], projectMentions: [], text: 'anna budget numbers',
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
    expect(parseCapture('mail bo@example.com now')).toMatchObject({ mentions: [], projectMentions: [], text: 'mail bo@example.com now' });
    expect(parseCapture('meet @ noon')).toMatchObject({ mentions: [], projectMentions: [], text: 'meet @ noon' });
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
    expect(parseCapture('/todo@anna call')).toEqual({ forcedKind: null, forcedOwner: null, mentions: [], projectMentions: [], text: '/todo@anna call' });
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

describe('parseCapture #project mentions', () => {
  const pm = (raw: string) => parseCapture(raw).projectMentions;

  it('finds #name and replaces it with the plain name in the text', () => {
    expect(parseCapture('/todo #apollo fix slides')).toMatchObject({ projectMentions: ['apollo'], text: 'apollo fix slides', forcedKind: 'action' });
  });

  it('finds #"Two words" and curly or Swedish quoted titles', () => {
    expect(parseCapture('fix #"Board deck" now')).toMatchObject({ projectMentions: ['Board deck'], text: 'fix Board deck now' });
    expect(pm('fix #\u201cBoard  deck\u201d now')).toEqual(['Board deck']);
    expect(pm('fix #\u201eBoard deck\u201d now')).toEqual(['Board deck']);
  });

  it('keeps hyphens inside a name and trims trailing ones', () => {
    expect(pm('see #board-deck.')).toEqual(['board-deck']);
    expect(parseCapture('see #apollo- now')).toMatchObject({ projectMentions: ['apollo'], text: 'see apollo- now' });
  });

  it('finds a mention mid-sentence and only reports each in order', () => {
    expect(pm('talk to Anna about #apollo and #zeta later')).toEqual(['apollo', 'zeta']);
  });

  it.each([
    ['issue #42 is open'],
    ['see #1'],
    ['a#b is not a project'],
    ['x9#y'],
    ['# heading'],
    ['#_x'],
    ['#-x'],
    ['mail me@x.se'],
    ['#"" empty'],
  ])('leaves %s alone', (raw) => {
    const r = parseCapture(raw);
    expect(r.projectMentions).toEqual([]);
    expect(r.text).toBe(raw.trim());
  });

  it('handles Swedish letters and decomposed (NFD) input', () => {
    expect(pm('plan #Åre-resa')).toEqual(['Åre-resa']);
    expect(pm('plan #A\u030Are'.normalize('NFD'))).toEqual(['Åre']);
    expect(pm('plan #\u201cÖstra hamnen\u201d')).toEqual(['Östra hamnen']);
  });

  it('keeps @person and #project apart', () => {
    expect(parseCapture('/note @anna about #apollo')).toMatchObject({ mentions: ['anna'], projectMentions: ['apollo'], text: 'anna about apollo' });
  });

  it('stays linear on hostile input', () => {
    const t0 = Date.now();
    parseCapture('#' + 'a'.repeat(50_000));
    parseCapture('#"' + 'a '.repeat(50_000));
    parseCapture('#a'.repeat(20_000));
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('parseCapture question prefixes', () => {
  it('/ask keeps the question text and its @mentions, and needs a whole-word command', () => {
    expect(parseCapture('/ask what did I promise @Anna?')).toMatchObject({
      forcedKind: 'question', mentions: ['Anna'], text: 'what did I promise Anna?',
    });
    expect(parseCapture('/asks what').forcedKind).toBeNull();
    expect(parseCapture('/question what').forcedKind).toBeNull();
    expect(parseCapture('please /ask what').forcedKind).toBeNull();
    expect(parseCapture('/ask')).toMatchObject({ forcedKind: 'question', text: '' });
  });
});
