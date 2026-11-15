import { describe, expect, it } from 'vitest';
import type { ProjectSummary } from '../../shared/api.ts';
import type { Action } from '../../shared/types.ts';
import {
  actionRowActions, actionsQuery, addAction, beginToggle, filterByDone, filterByPerson, groupActionsByProject, orderWithin, removeAction,
  replaceAction, visibleActions,
} from './actions-logic.ts';
import { appendPage } from '../lib/format.ts';

let n = 0;
function act(p: Partial<Action> = {}): Action {
  n++;
  return {
    id: n, text: `a${n}`, owner: 'me', status: 'open', personId: null, meetingId: null, projectId: null,
    createdAt: '2026-11-15T10:00:00Z', doneAt: null, ...p,
  };
}
const proj = (id: number, title: string, status: ProjectSummary['status'] = 'active'): ProjectSummary =>
  ({ id, title, aliases: [], status, openActions: 0, updatedAt: '2026-11-15T10:00:00Z' });

describe('groupActionsByProject', () => {
  it('orders active projects by title (Swedish), then on hold, then done, then No project', () => {
    const projects = [proj(1, 'Zeta'), proj(2, 'Åre-resa'), proj(3, 'Apollo'), proj(4, 'Hold', 'on_hold'), proj(5, 'Old', 'done')];
    const actions = [
      act({ projectId: 4 }), act({ projectId: 1 }), act({ projectId: 2 }), act({ projectId: 3 }), act({ projectId: 5 }), act({ projectId: null }),
    ];
    expect(groupActionsByProject(actions, projects).map((g) => g.title)).toEqual(['Apollo', 'Zeta', 'Åre-resa', 'Hold', 'Old', 'No project']);
  });

  it('puts an action whose project is unknown to the store under No project', () => {
    const a = act({ projectId: 99 });
    const none = groupActionsByProject([a], [proj(1, 'Apollo')]).find((g) => g.key === 'none')!;
    expect(none.actions).toEqual([a]);
    expect(groupActionsByProject([a], [proj(1, 'Apollo')]).map((g) => g.key)).toEqual(['none']);
  });

  it('leaves out projects without actions but always has No project', () => {
    const groups = groupActionsByProject([], [proj(1, 'Apollo')]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: 'none', projectId: null, actions: [] });
  });

  it('inside a group: mine before waiting-for, then oldest first; done is not a rank', () => {
    const a = act({ owner: 'them' }), b = act({ owner: 'me' }), c = act({ owner: 'me', status: 'done' }), d = act({ owner: 'me' });
    expect(orderWithin([d, c, b, a]).map((x) => x.id)).toEqual([b.id, c.id, d.id, a.id]);
    // Checking a row off does not move it.
    const before = orderWithin([b, d]).map((x) => x.id);
    expect(orderWithin([{ ...b, status: 'done' }, d]).map((x) => x.id)).toEqual(before);
    const input = [d, b];
    orderWithin(input);
    expect(input).toEqual([d, b]); // not mutated
  });

  it('groupActionsByProject orders the actions of each group with orderWithin and breaks title ties by id', () => {
    const x = act({ projectId: 1, owner: 'them' }), y = act({ projectId: 1 }), z = act({ projectId: 2 });
    const g = groupActionsByProject([z, x, y], [proj(2, 'Same'), proj(1, 'Same')]);
    expect(g.map((q) => q.projectId)).toEqual([1, 2, null]);
    expect(g[0]!.actions.map((q) => q.id)).toEqual([y.id, x.id]);
  });
});

describe('filters', () => {
  const a = act({ personId: 1 }), b = act({ personId: 2 }), c = act({ personId: null, status: 'done' });
  it('person filter keeps only that person; null keeps all', () => {
    expect(filterByPerson([a, b, c], 1)).toEqual([a]);
    expect(filterByPerson([a, b, c], null)).toHaveLength(3);
  });
  it('done actions are hidden unless asked for', () => {
    expect(filterByDone([a, b, c], false)).toEqual([a, b]);
    expect(filterByDone([a, b, c], true)).toHaveLength(3);
    expect(visibleActions([a, b, c], 2, true)).toEqual([b]);
  });
});

describe('optimistic toggle', () => {
  it('flips the status and records the id as in flight', () => {
    const a = act();
    const inflight = new Set<number>();
    const r = beginToggle([a], a.id, inflight, '2026-11-15T12:00:00Z')!;
    expect(r.status).toBe('done');
    expect(r.actions[0]).toMatchObject({ status: 'done', doneAt: '2026-11-15T12:00:00Z' });
    expect(r.previous).toBe(a);
    expect(inflight.has(a.id)).toBe(true);
  });

  it('checks the in-flight guard before changing anything', () => {
    const a = act();
    const inflight = new Set<number>([a.id]);
    const list = [a];
    expect(beginToggle(list, a.id, inflight, 'x')).toBeNull();
    expect(list[0]!.status).toBe('open'); // untouched
    expect(inflight.size).toBe(1);
  });

  it('reopens a done action and clears doneAt; an unknown id does nothing and is not marked', () => {
    const a = act({ status: 'done', doneAt: '2026-11-14T00:00:00Z' });
    const inflight = new Set<number>();
    expect(beginToggle([a], a.id, inflight, 'x')!.actions[0]).toMatchObject({ status: 'open', doneAt: null });
    const other = new Set<number>();
    expect(beginToggle([a], 9999, other, 'x')).toBeNull();
    expect(other.size).toBe(0);
  });
});

describe('list edits and paging', () => {
  it('replace, remove and add keep the rest and never duplicate', () => {
    const a = act(), b = act();
    expect(replaceAction([a, b], { ...a, text: 'new' })[0]!.text).toBe('new');
    expect(replaceAction([a], { ...b })).toEqual([a]);
    expect(removeAction([a, b], a.id)).toEqual([b]);
    const c = act();
    expect(addAction([a], c).map((x) => x.id)).toEqual([c.id, a.id]);
    expect(addAction([a, c], { ...c, text: 'again' })).toHaveLength(2);
  });

  it('a next page is merged after the current items without duplicates', () => {
    const a = act(), b = act(), c = act();
    expect(appendPage([a, b], [b, c]).map((x) => x.id)).toEqual([a.id, b.id, c.id]);
  });

  it('builds the query: status, person, cursor', () => {
    expect(actionsQuery({ status: 'open', personId: null })).toBe('status=open&limit=200');
    expect(actionsQuery({ status: 'done', personId: 7, before: 40 })).toBe('status=done&personId=7&limit=100&before=40');
  });
});

describe('actionRowActions', () => {
  const handlers = () => {
    const calls: string[] = [];
    const mk = (n: string) => () => { calls.push(n); };
    return { calls, h: { toggle: mk('toggle'), edit: mk('edit'), pickProject: mk('project'), pickPerson: mk('person'), toggleOwner: mk('owner'), remove: mk('remove') } };
  };

  it('with a project chip: Done first (the default), then Edit, Project…, Person…, owner, Delete as the only danger', () => {
    const acts = actionRowActions(act(), handlers().h, { withProject: true });
    expect(acts.map((a) => a.id)).toEqual(['done', 'edit', 'project', 'person', 'owner', 'delete']);
    expect(acts.map((a) => a.label)).toEqual(['Done', 'Edit', 'Project…', 'Person…', 'Mark waiting', 'Delete']);
    expect(acts.filter((a) => a.danger).map((a) => a.id)).toEqual(['delete']);
  });

  it('without a project chip there is no Project…', () => {
    expect(actionRowActions(act(), handlers().h, { withProject: false }).map((a) => a.id)).toEqual(['done', 'edit', 'person', 'owner', 'delete']);
  });

  it('labels follow the state: Reopen for a done action, Mark mine for a waiting one', () => {
    const acts = actionRowActions(act({ status: 'done', owner: 'them' }), handlers().h, { withProject: true });
    expect(acts[0]!.label).toBe('Reopen');
    expect(acts.find((a) => a.id === 'owner')!.label).toBe('Mark mine');
  });

  it('each chip calls its own handler with the action', () => {
    const { calls, h } = handlers();
    for (const a of actionRowActions(act(), h, { withProject: true })) void a.run();
    expect(calls).toEqual(['toggle', 'edit', 'project', 'person', 'owner', 'remove']);
  });
});
