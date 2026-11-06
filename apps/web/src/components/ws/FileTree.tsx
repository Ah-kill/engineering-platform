import { useMemo, useState } from 'react';
import type { GitFile, TreeEntry } from '../../api';

interface Node { name: string; path: string; type: 'file' | 'dir'; skipped?: boolean; children: Node[] }

function build(entries: TreeEntry[]): Node[] {
  const root: Node = { name: '', path: '', type: 'dir', children: [] };
  const dirs = new Map<string, Node>([['', root]]);
  for (const e of entries) {
    const idx = e.path.lastIndexOf('/');
    const parent = dirs.get(idx === -1 ? '' : e.path.slice(0, idx)) ?? root;
    const node: Node = { name: e.path.slice(idx + 1), path: e.path, type: e.type, skipped: e.skipped, children: [] };
    parent.children.push(node);
    if (e.type === 'dir') dirs.set(e.path, node);
  }
  return root.children;
}

const STATUS_LETTER: Record<GitFile['status'], string> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U' };

export function FileTree({ entries, changes, activePath, onOpen, filter }: {
  entries: TreeEntry[];
  changes: GitFile[];
  activePath?: string;
  onOpen(path: string): void;
  filter: string;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const changeMap = useMemo(() => new Map(changes.map((c) => [c.path, c.status])), [changes]);
  const nodes = useMemo(() => build(entries), [entries]);

  if (filter.trim()) {
    const f = filter.toLowerCase();
    const hits = entries.filter((e) => e.type === 'file' && e.path.toLowerCase().includes(f)).slice(0, 300);
    return (
      <ul className="tree" role="listbox" aria-label="Matching files">
        {hits.map((e) => (
          <li key={e.path}>
            <button className={`tree-row${e.path === activePath ? ' active' : ''}`} onClick={() => onOpen(e.path)} title={e.path}>
              <span className="tree-name">{e.path}</span>
            </button>
          </li>
        ))}
        {!hits.length && <li className="muted tree-empty">No matching files</li>}
      </ul>
    );
  }

  const toggle = (p: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });

  const render = (list: Node[], depth: number) => (
    <ul className="tree" role={depth === 0 ? 'tree' : 'group'}>
      {list.map((n) => {
        const status = changeMap.get(n.path);
        const isOpen = open.has(n.path);
        return (
          <li key={n.path} role="treeitem" aria-expanded={n.type === 'dir' ? isOpen : undefined}>
            <button
              className={`tree-row${n.path === activePath ? ' active' : ''}${status ? ` st-${status}` : ''}`}
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => (n.type === 'dir' ? !n.skipped && toggle(n.path) : onOpen(n.path))}
              title={n.skipped ? `${n.path} (not listed)` : n.path}
            >
              <span className="tree-icon" aria-hidden>{n.type === 'dir' ? (isOpen ? '▾' : '▸') : ''}</span>
              <span className={`tree-name${n.skipped ? ' muted' : ''}`}>{n.name}</span>
              {status && <span className="tree-status">{STATUS_LETTER[status]}</span>}
            </button>
            {n.type === 'dir' && isOpen && n.children.length > 0 && render(n.children, depth + 1)}
          </li>
        );
      })}
    </ul>
  );

  return render(nodes, 0);
}
