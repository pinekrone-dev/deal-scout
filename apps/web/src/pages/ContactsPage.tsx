import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { addDoc, collection, deleteDoc, doc, onSnapshot, query, Timestamp, where } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { apiFetch } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useWorkspace } from '../lib/workspace';
import type { Contact } from '../types';

type Row = Contact & { id: string };

export default function ContactsPage() {
  const { user } = useAuth();
  const { currentOwnerUid, current } = useWorkspace();
  const [rows, setRows] = useState<Row[]>([]);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [bulkBusy, setBulkBusy] = useState(false);
  const nav = useNavigate();

  useEffect(() => {
    if (!user || !currentOwnerUid) return;
    const q = query(collection(db, 'contacts'), where('owner_uid', '==', currentOwnerUid));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const out: Row[] = [];
        snap.forEach((d) => out.push({ id: d.id, ...(d.data() as Contact) }));
        out.sort((a, b) => {
          const au = a.updated_at ? (typeof a.updated_at === 'number' ? a.updated_at : (a.updated_at as any).toMillis?.() ?? 0) : 0;
          const bu = b.updated_at ? (typeof b.updated_at === 'number' ? b.updated_at : (b.updated_at as any).toMillis?.() ?? 0) : 0;
          return bu - au;
        });
        setRows(out);
        setSelected((prev) => {
          const next: Record<string, boolean> = {};
          for (const r of out) if (prev[r.id]) next[r.id] = true;
          return next;
        });
      },
      (err) => {
        // eslint-disable-next-line no-console
        console.error('contacts query failed', err);
      }
    );
    return () => unsub();
  }, [user, currentOwnerUid]);

  const filtered = useMemo(() => {
    const f = filter.toLowerCase();
    if (!f) return rows;
    return rows.filter((r) =>
      (r.name ?? '').toLowerCase().includes(f) ||
      (r.firm ?? '').toLowerCase().includes(f) ||
      (r.email ?? '').toLowerCase().includes(f)
    );
  }, [rows, filter]);

  const selectedIds = useMemo(
    () => filtered.filter((r) => selected[r.id]).map((r) => r.id),
    [filtered, selected]
  );
  const selCount = selectedIds.length;
  const allFilteredSelected = filtered.length > 0 && filtered.every((r) => selected[r.id]);

  function toggleAll() {
    setSelected((prev) => {
      if (allFilteredSelected) {
        const next = { ...prev };
        for (const r of filtered) delete next[r.id];
        return next;
      }
      const next = { ...prev };
      for (const r of filtered) next[r.id] = true;
      return next;
    });
  }

  function toggle(id: string) {
    setSelected((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  async function createBlank() {
    if (!user || !currentOwnerUid) return;
    const now = Date.now();
    const ref = await addDoc(collection(db, 'contacts'), {
      name: 'New Contact',
      role: 'broker',
      owner_uid: currentOwnerUid,
      created_at: Timestamp.fromMillis(now),
      updated_at: Timestamp.fromMillis(now)
    });
    nav(`/contacts/${ref.id}`);
  }

  async function bulkDelete() {
    if (selCount === 0) return;
    const msg =
      selCount === 1
        ? 'Delete 1 selected contact and unlink from deals? This cannot be undone.'
        : `Delete ${selCount} selected contacts and unlink from deals? This cannot be undone.`;
    if (!window.confirm(msg)) return;
    setBulkBusy(true);
    const ids = [...selectedIds];
    try {
      const res = await apiFetch(
        '/api/contacts/bulk-delete',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids }),
        },
        30_000
      );
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`${res.status} ${body || res.statusText}`);
      }
      const data = await res.json().catch(() => ({} as any));
      setSelected({});
      if (Array.isArray(data?.errors) && data.errors.length > 0) {
        alert(`Deleted ${data.deleted ?? 0}; ${data.errors.length} failed. See console for details.`);
        // eslint-disable-next-line no-console
        console.warn('bulk-delete partial errors', data.errors);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('bulk-delete API failed, falling back to client-side', e);
      try {
        await Promise.allSettled(ids.map((id) => deleteDoc(doc(db, 'contacts', id))));
        setSelected({});
        alert(
          `Server cleanup failed (${e instanceof Error ? e.message : String(e)}). Deleted ${ids.length} contact docs directly; deal links were not unlinked. Ask to rerun server cleanup if needed.`
        );
      } catch (e2) {
        alert(`Delete failed: ${e2 instanceof Error ? e2.message : String(e2)}`);
      }
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Contacts</h1>
          <p className="text-sm text-ink-500">
            {rows.length} total
            {current && current.role !== 'owner' ? (
              <span className="ml-2 pill">Shared: {current.owner_email}</span>
            ) : null}
          </p>
        </div>
        <button className="btn-primary" onClick={createBlank}>New Contact</button>
      </div>

      <div className="card p-3 flex flex-wrap items-center gap-3">
        <input
          className="field max-w-md"
          placeholder="Search name, firm, email..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className="flex-1" />
        {selCount > 0 ? (
          <button
            className="btn text-red-700 border-red-300 hover:bg-red-50"
            disabled={bulkBusy}
            onClick={bulkDelete}
          >
            {bulkBusy ? 'Deleting...' : `Delete selected (${selCount})`}
          </button>
        ) : null}
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr>
              <th className="th w-8">
                <input
                  type="checkbox"
                  checked={allFilteredSelected}
                  onChange={toggleAll}
                  aria-label="Select all"
                />
              </th>
              <th className="th">Name</th>
              <th className="th">Role</th>
              <th className="th">Firm</th>
              <th className="th">Email</th>
              <th className="th">Phone</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id} className={`hover:bg-ink-50 ${selected[r.id] ? 'bg-accent-50' : ''}`}>
                <td className="td">
                  <input
                    type="checkbox"
                    checked={!!selected[r.id]}
                    onChange={() => toggle(r.id)}
                    aria-label={`Select ${r.name}`}
                  />
                </td>
                <td className="td">
                  <Link to={`/contacts/${r.id}`} className="text-accent-600 hover:underline">{r.name}</Link>
                </td>
                <td className="td"><span className="pill">{r.role}</span></td>
                <td className="td">{r.firm ?? ''}</td>
                <td className="td">{r.email ?? ''}</td>
                <td className="td">{r.phone ?? ''}</td>
              </tr>
            ))}
            {filtered.length === 0 ? (
              <tr><td colSpan={6} className="td text-center text-ink-500 py-6">No contacts.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
