import { describe, expect, it } from 'vitest';
import { findProjectsInText, resolveProjectMention } from './project-match.ts';
import type { ProjectLike } from './project-match.ts';

const P = (id: number, title: string, aliases: string[] = []): ProjectLike => ({ id, title, aliases });
const ids = (ps: ProjectLike[]): number[] => ps.map((p) => p.id);

describe('resolveProjectMention', () => {
  const projects = [P(1, 'Board deck'), P(2, 'Board meeting'), P(3, 'Apollo', ['Moon shot']), P(4, 'Åre-resa')];

  it('matches an exact title, alias or hyphenated/underscored form, ignoring case', () => {
    expect(ids(resolveProjectMention('apollo', projects))).toEqual([3]);
    expect(ids(resolveProjectMention('MOON  SHOT', projects))).toEqual([3]);
    expect(ids(resolveProjectMention('board-deck', projects))).toEqual([1]);
    expect(ids(resolveProjectMention('board_deck', projects))).toEqual([1]);
  });

  it('matches Swedish letters in NFC and NFD form', () => {
    expect(ids(resolveProjectMention('åre resa', projects))).toEqual([4]);
    expect(ids(resolveProjectMention('Åre-resa', projects))).toEqual([4]);
    expect(ids(resolveProjectMention('åre-resa', [P(9, 'Åre-resa')]))).toEqual([9]);
  });

  it('an exact match beats a prefix match', () => {
    const ps = [P(1, 'Board'), P(2, 'Board deck')];
    expect(ids(resolveProjectMention('board', ps))).toEqual([1]);
  });

  it('falls back to titles starting with the mention as whole words, several meaning ambiguous', () => {
    expect(ids(resolveProjectMention('board', projects))).toEqual([1, 2]);
    expect(ids(resolveProjectMention('boa', projects))).toEqual([]);
    expect(ids(resolveProjectMention('deck', projects))).toEqual([]);
  });

  it('returns nothing for blank mentions or no match', () => {
    expect(resolveProjectMention('  ', projects)).toEqual([]);
    expect(resolveProjectMention('zeta', projects)).toEqual([]);
    expect(resolveProjectMention('apollo', [])).toEqual([]);
  });
});

describe('findProjectsInText', () => {
  const projects = [P(1, 'Board deck'), P(2, 'Apollo'), P(3, 'Q4 plan', ['Kvartalet']), P(4, 'Go'), P(5, 'Åre-resa')];

  it('a multi-word title is a strong match, a single word is weak', () => {
    const r = findProjectsInText('finish the board deck for Apollo', projects);
    expect(ids(r.strong)).toEqual([1]);
    expect(ids(r.weak)).toEqual([2]);
  });

  it('matches aliases, hyphen forms and Swedish text', () => {
    expect(ids(findProjectsInText('kvartalet is late', projects).weak)).toEqual([3]);
    expect(ids(findProjectsInText('the q4-plan slipped', projects).strong)).toEqual([3]);
    expect(ids(findProjectsInText('planera Åre resa i vinter', projects).strong)).toEqual([5]);
    expect(ids(findProjectsInText('ÅRE-RESA', projects).strong)).toEqual([5]);
  });

  it('needs whole words, and ignores single words shorter than 3 characters', () => {
    expect(findProjectsInText('apollos plan, apollonia, the board decks', projects)).toEqual({ strong: [], weak: [] });
    expect(findProjectsInText('go go go', projects)).toEqual({ strong: [], weak: [] });
    expect(findProjectsInText('', projects)).toEqual({ strong: [], weak: [] });
  });

  it('a weak match inside another project\'s strong match is dropped', () => {
    const ps = [P(1, 'Apollo'), P(2, 'Apollo launch')];
    const r = findProjectsInText('prepare the apollo launch', ps);
    expect(ids(r.strong)).toEqual([2]);
    expect(ids(r.weak)).toEqual([]);
    expect(ids(findProjectsInText('prepare apollo', ps).weak)).toEqual([1]);
  });

  it('several strong matches are all reported', () => {
    const ps = [P(1, 'Board deck'), P(2, 'Q4 plan')];
    expect(ids(findProjectsInText('board deck and q4 plan', ps).strong)).toEqual([1, 2]);
  });

  it('only matches what it is given (done and deleted projects are filtered by the caller)', () => {
    expect(findProjectsInText('apollo', [])).toEqual({ strong: [], weak: [] });
  });
});
