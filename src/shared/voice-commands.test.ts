import { describe, expect, it } from 'vitest';
import { parseVoiceCommand } from './voice-commands.ts';

const people = [
  { id: 1, name: 'Anna Berg', aliases: [] },
  { id: 2, name: 'Åsa Lind', aliases: ['Åsis'] },
  { id: 3, name: 'Bo', aliases: [] },
  { id: 4, name: 'Erik Ek', aliases: [] },
  { id: 5, name: 'Erik Holm', aliases: [] },
];

describe('parseVoiceCommand', () => {
  it.each(['open Anna', 'open anna', 'Open Anna.', 'show Anna Berg', 'Please open Anna.', 'open anna please', 'Can you open Anna?'])(
    'open_person: %s',
    (t) => expect(parseVoiceCommand(t, people)).toEqual({ type: 'open_person', personId: 1 }),
  );

  it.each([
    'start 1-1 with Anna',
    'Start one-on-one with Anna.',
    'start one on one with Anna',
    'start a 1-1 with anna',
    'start 1:1 with Anna',
    'start one to one with Anna',
    'start a meeting with Anna',
    'start a 1-1 meeting with Anna',
    'start 1 on 1 with Anna',
    'Please start a one-on-one with Anna Berg!',
  ])('start_meeting: %s', (t) => expect(parseVoiceCommand(t, people)).toEqual({ type: 'start_meeting', personId: 1 }));

  it.each([
    ['go to actions', 'actions'],
    ['Go to chat.', 'chat'],
    ['open notes', 'notes'],
    ['show people', 'people'],
    ['go to the notes page', 'notes'],
  ])('goto: %s', (t, view) => expect(parseVoiceCommand(t, people)).toEqual({ type: 'goto', view }));

  it('handles Swedish letters in names', () => {
    expect(parseVoiceCommand('open åsa', people)).toEqual({ type: 'open_person', personId: 2 });
    expect(parseVoiceCommand('start one on one with Åsis', people)).toEqual({ type: 'start_meeting', personId: 2 });
  });

  it('exact name beats first-word match', () => {
    const ps = [{ id: 1, name: 'Bo', aliases: [] }, { id: 2, name: 'Bo Nilsson', aliases: [] }];
    expect(parseVoiceCommand('open Bo', ps)).toEqual({ type: 'open_person', personId: 1 });
  });

  it('strips surrounding quotes', () => {
    expect(parseVoiceCommand('"Open Anna."', people)).toEqual({ type: 'open_person', personId: 1 });
    expect(parseVoiceCommand('\u201cOpen Anna.\u201d', people)).toEqual({ type: 'open_person', personId: 1 });
  });

  it('long transcripts are dictation and stay fast', () => {
    const t0 = Date.now();
    expect(parseVoiceCommand('open Anna' + ', '.repeat(5000), people)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('returns null for unknown or ambiguous people', () => {
    expect(parseVoiceCommand('open Zelda', people)).toBeNull();
    expect(parseVoiceCommand('start 1-1 with Zelda', people)).toBeNull();
    expect(parseVoiceCommand('open Erik', people)).toBeNull();
    expect(parseVoiceCommand('open Ann', people)).toBeNull();
  });

  it('returns null for ordinary sentences and dictation', () => {
    expect(parseVoiceCommand('open the window and call the bank', people)).toBeNull();
    expect(parseVoiceCommand('open the door', people)).toBeNull();
    expect(parseVoiceCommand('open', people)).toBeNull();
    expect(parseVoiceCommand('we should open a new office with Anna', people)).toBeNull();
    expect(parseVoiceCommand('go to lunch', people)).toBeNull();
    expect(parseVoiceCommand('start with Anna', people)).toBeNull();
    expect(parseVoiceCommand('', people)).toBeNull();
    expect(parseVoiceCommand('  ...  ', people)).toBeNull();
  });
});
