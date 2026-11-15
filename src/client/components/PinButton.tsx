import type { Id } from '../../shared/types.ts';
import { isPinned, togglePin } from '../lib/nav.ts';

/** Pin / Unpin toggle for a person or project (a real button: click, touch, Tab, Enter and Space). */
export function PinButton(props: { kind: 'person' | 'project'; id: Id }) {
  const pinned = isPinned(props.kind, props.id);
  return (
    <button
      type="button" class="btn" aria-pressed={pinned} title={pinned ? 'Unpin from the sidebar' : 'Pin to the sidebar'}
      onClick={() => { void togglePin(props.kind, props.id); }}
    >
      {pinned ? 'Unpin' : 'Pin'}
    </button>
  );
}
