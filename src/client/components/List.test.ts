import { describe, expect, it } from 'vitest';
import { setDraft, drafts } from '../lib/store.ts';
import { addDraftKey } from './List.tsx';

describe('List add-field draft key', () => {
  it('is derived from draftId, so the same list label for two entities never shares text', () => {
    expect(addDraftKey('person:12:agenda')).not.toBe(addDraftKey('person:13:agenda'));
    setDraft(addDraftKey('person:12:agenda'), 'for Anna');
    expect(drafts.value[addDraftKey('person:13:agenda')]).toBeUndefined();
    expect(drafts.value[addDraftKey('person:12:agenda')]).toBe('for Anna');
    drafts.value = {};
  });

  it('does not collide with editor drafts (TextEdit ids)', () => {
    expect(addDraftKey('note:1:body')).not.toBe('note:1:body');
  });
});
