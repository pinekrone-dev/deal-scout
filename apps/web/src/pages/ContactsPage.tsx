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
  const [deleting, setDeleting] = useState<string | null>(null);
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

  async function removeContact(id: string, name: string) {
    if (!window.confirm(`Delete "${name || 'this contact'}" and unlink from deals? This cannot be undone.`)) {
      return;
    }
    setDeleting(id);
    try {
      const res = await apiFetch(`/api/contacts/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const text = await res.text();
        if (res.status === 404 || res.status === 405) {
          await deleteDoc(doc(db, 'contacts', id));
        } else {
          throw new Error(`${res.status} ${text}`);
        }
      }
    } catch (e) {
      alert(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDeleting(null);
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

      <div className="card p-3">
        <input
          className="field max-w-md"
          placeholder="Search name, firm, email..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">Name</th>
              <th className="th">Role</th>
              <th className="th">Firm</th>
              <th className="th">Email</th>
              <th className="th">Phone</th>
              <th className="th"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id} className="hover:bg-ink-50">
                <td className="td">
                  <Link to={`/contacts/${r.id}`} className="text-accent-600 hover:underline">{r.name}</Link>
                </td>
                <td className="td"><span className="pill">{r.role}</span></td>
                <td className="td">{r.firm ?? ''}</td>
                <td className="td">{r.email ?? ''}</td>
                <td className="td">{r.phone ?? ''}</td>
                <td className="td text-right">
                  <button
                    className="btn-ghost text-xs text-red-600"
                    onClick={() => removeContact(r.id, r.name || '')}
                    disabled={deleting === r.id}
                  >
                    {deleting === r.id ? '...' : 'Delete'}
                  </button>
                </td>
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
