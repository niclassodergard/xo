import { useState } from 'preact/hooks';
import { List } from './List.tsx';
import { TextEdit } from './TextEdit.tsx';

/**
 * Test document for the browser check (e2e/shell.spec.ts): exercises List and TextEdit with fake data. It is
 * only reachable at #/kit in a build made with `vite build --mode e2e` (see Panel.tsx); the production bundle
 * does not contain it.
 */
interface Row { id: number; text: string }

export default function KitDemo() {
  const [rows, setRows] = useState<Row[]>([{ id: 1, text: 'Row one' }, { id: 2, text: 'Row two' }, { id: 3, text: 'Row three' }]);
  const [last, setLast] = useState('none');
  const [next, setNext] = useState(4);
  const [entity, setEntity] = useState(1);
  return (
    <div>
      <p id="kit-last" role="status">{`last: ${last}`}</p>
      <TextEdit id="kit:1:text" value="" label="Kit text" placeholder="Kit text" onSave={async () => {}} />
      <button type="button" class="btn" onClick={() => setEntity((e) => (e === 1 ? 2 : 1))}>{`Switch entity (now ${entity})`}</button>
      <List
        draftId={`kit:${entity}:add`}
        label="Kit list" items={rows} empty="No rows."
        render={(r) => r.text}
        actions={(r) => [
          { id: 'toggle', label: 'Toggle', run: () => setLast(`toggle ${r.text}`) },
          { id: 'rename', label: 'Rename', run: () => setLast(`rename ${r.text}`) },
          { id: 'delete', label: 'Delete', danger: true, run: () => { setLast(`delete ${r.text}`); setRows((x) => x.filter((y) => y.id !== r.id)); } },
        ]}
        addPlaceholder="Add a row"
        onAdd={async (text) => {
          if (text === 'fail') throw new Error('nope');
          setRows((x) => [...x, { id: next, text }]);
          setNext((n) => n + 1);
        }}
      />
    </div>
  );
}
