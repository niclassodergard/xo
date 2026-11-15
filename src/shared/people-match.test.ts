import { describe, expect, it } from 'vitest';
import { findPeopleInText, resolveMention } from './people-match.ts';

const p = (id: number, name: string, aliases: string[] = []) => ({ id, name, aliases });
const ids = (xs: { id: number }[]) => xs.map((x) => x.id);

describe('resolveMention', () => {
  const people = [p(1, 'Anna Berg', ['AB']), p(2, 'Åsa Lind'), p(3, 'Björn Öberg'), p(4, 'Bob'), p(5, 'Bo Nilsson')];

  it('matches full name, alias and first word, case-insensitively', () => {
    expect(ids(resolveMention('anna berg', people))).toEqual([1]);
    expect(ids(resolveMention('ab', people))).toEqual([1]);
    expect(ids(resolveMention('ANNA', people))).toEqual([1]);
  });

  it('handles Swedish letters', () => {
    expect(ids(resolveMention('åsa', people))).toEqual([2]);
    expect(ids(resolveMention('ÅSA', people))).toEqual([2]);
    expect(ids(resolveMention('björn', people))).toEqual([3]);
    expect(ids(resolveMention('Björn   Öberg', people))).toEqual([3]);
  });

  it('is whole-word only and ignores blank input', () => {
    expect(resolveMention('Ann', people)).toEqual([]);
    expect(ids(resolveMention('Bo', people))).toEqual([5]);
    expect(resolveMention('', people)).toEqual([]);
    expect(resolveMention('   ', people)).toEqual([]);
  });

  it('returns every candidate when ambiguous', () => {
    const two = [p(1, 'Anna Berg'), p(2, 'Anna Lund')];
    expect(ids(resolveMention('anna', two))).toEqual([1, 2]);
  });

  it('ignores blank aliases', () => {
    expect(resolveMention('x', [p(1, 'Zed', [''])])).toEqual([]);
  });
});

describe('findPeopleInText', () => {
  const people = [p(1, 'Anna Berg'), p(2, 'Åsa Lind', ['Åsis']), p(3, 'Bo Nilsson'), p(4, 'Bob Karlsson')];

  it('finds full names, aliases and unique first names', () => {
    expect(ids(findPeopleInText('talk to Anna Berg about hiring', people))).toEqual([1]);
    expect(ids(findPeopleInText('ask Anna about it', people))).toEqual([1]);
    expect(ids(findPeopleInText('fråga ÅSIS imorgon', people))).toEqual([2]);
    expect(ids(findPeopleInText('Åsa och Anna', people))).toEqual([1, 2]);
  });

  it('matches whole words only', () => {
    expect(findPeopleInText('Anne and Annabelle', people)).toEqual([]);
    expect(ids(findPeopleInText('I heard about Bob', people))).toEqual([4]);
    expect(findPeopleInText('I heard about it', people)).toEqual([]);
    expect(findPeopleInText('Ann called', [p(1, 'Anna')])).toEqual([]);
  });

  it('handles punctuation and possessives', () => {
    expect(ids(findPeopleInText("Anna's plan, (Anna).", people))).toEqual([1]);
  });

  it('uses first names only when unique', () => {
    const two = [p(1, 'Anna Berg'), p(2, 'Anna Lund')];
    expect(findPeopleInText('call Anna', two)).toEqual([]);
    expect(ids(findPeopleInText('call Anna Lund', two))).toEqual([2]);
  });

  it('requires an uppercase first letter in free text', () => {
    const will = [p(1, 'Will'), p(2, 'Mark Ek')];
    expect(ids(findPeopleInText('Will will call', will))).toEqual([1]);
    expect(findPeopleInText('I will call', will)).toEqual([]);
    expect(findPeopleInText('mark the doc', will)).toEqual([]);
    expect(ids(findPeopleInText('Mark the doc', will))).toEqual([2]);
    expect(ids(findPeopleInText('ASK ANNA', people))).toEqual([1]);
    expect(findPeopleInText('ask anna', people)).toEqual([]);
    expect(ids(findPeopleInText('ring Åsa', people))).toEqual([2]);
    expect(findPeopleInText('ring åsa', people)).toEqual([]);
    expect(ids(findPeopleInText('anna and Anna', people))).toEqual([1]);
  });

  it('returns distinct people and tolerates empty input', () => {
    expect(ids(findPeopleInText('Anna Berg and Anna', people))).toEqual([1]);
    expect(findPeopleInText('', people)).toEqual([]);
    expect(findPeopleInText('anything', [])).toEqual([]);
    expect(findPeopleInText('anything', [p(9, '', [''])])).toEqual([]);
  });
});

describe('precedence, hyphens and genitive', () => {
  it('exact name beats first-word match in resolveMention', () => {
    expect(ids(resolveMention('Bo', [p(1, 'Bo'), p(2, 'Bo Nilsson')]))).toEqual([1]);
    expect(ids(resolveMention('Bo', [p(2, 'Bo Nilsson'), p(3, 'Bo Ek')]))).toEqual([2, 3]);
  });

  it('longest span wins in free text', () => {
    expect(ids(findPeopleInText('talk to Anna Berg', [p(1, 'Anna'), p(2, 'Anna Berg')]))).toEqual([2]);
    expect(ids(findPeopleInText('talk to Anna and Anna Berg', [p(1, 'Anna'), p(2, 'Anna Berg')]))).toEqual([1, 2]);
  });

  it('hyphen joins words but apostrophe does not', () => {
    expect(findPeopleInText('Anna-Karin sa nej', [p(1, 'Anna Berg')])).toEqual([]);
    expect(findPeopleInText('Lars-Erik ringde', [p(1, 'Erik Holm')])).toEqual([]);
    expect(ids(findPeopleInText('Anna-Karin sa nej', [p(1, 'Anna-Karin')]))).toEqual([1]);
    expect(ids(findPeopleInText("Anna's plan", [p(1, 'Anna')]))).toEqual([1]);
    expect(ids(findPeopleInText('Anna - hej', [p(1, 'Anna')]))).toEqual([1]);
  });

  it('Swedish genitive', () => {
    expect(ids(resolveMention('Annas', [p(1, 'Anna Berg')]))).toEqual([1]);
    expect(ids(resolveMention('annas', [p(1, 'Anna'), p(2, 'Annas')]))).toEqual([2]);
    expect(ids(resolveMention('Jonas', [p(1, 'Jona'), p(2, 'Jonas')]))).toEqual([2]);
    expect(ids(findPeopleInText('Annas budget', [p(1, 'Anna')]))).toEqual([1]);
    expect(findPeopleInText('Annass budget', [p(1, 'Anna')])).toEqual([]);
    expect(ids(findPeopleInText('Jonas budget', [p(1, 'Jona'), p(2, 'Jonas')]))).toEqual([2]);
    expect(ids(findPeopleInText('Annas budget', [p(1, 'Anna'), p(2, 'Annas')]))).toEqual([2]);
  });
});
