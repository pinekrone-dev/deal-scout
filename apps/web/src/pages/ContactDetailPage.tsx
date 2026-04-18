import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  arrayRemove,
  arrayUnion,
  collection,
  doc,
  onSnapshot,
  query,
  Timestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../lib/auth';
import { useWorkspace } from '../lib/workspace';
import type { Building, Contact, ContactRole } from '../types';

const ROLES: ContactRole[] = ['broker', 'sponsor', 'owner', 'lender', 'tenant', 'other'];

type BRow = Building & { id: string };

export default function ContactDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const { currentOwnerUid } = useWorkspace();
  const [contact, setContact] = useState<Contact | null>(null);
  const [buildings, setBuildings] = useState<BRow[]>([]);
  const [picked, setPicked] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!id) return;
    const unsub = onSnapshot(doc(db, 'contacts', id), (snap) => {
      if (snap.exists()) setContact({ id: snap.id, ...(snap.data() as Contact) });
    });
    return () => unsub();
  }, [id]);

  // Load buildings from the contact's workspace (falls back to current workspace).
  const ownerUid = (contact as any)?.owner_uid ?? currentOwnerUid ?? null;
  useEffect(() => {
    if (!user || !ownerUid) return;
    const q = query(collection(db, 'buildings'), where('owner_uid', '==', ownerUid));
    const unsub = onSnapshot(q, (snap) => {
      const out: BRow[] = [];
      snap.forEach((d) => out.push({ id: d.id, ...(d.data() as Building) }));
      out.sort((a, b) => (a.address || '').localeCompare(b.address || ''));
      setBuildings(out);
    });
    return () => unsub();
  }, [user, ownerUid]);

  async function patch(p: Partial<Contact>) {
    if (!id) return;
    await updateDoc(doc(db, 'contacts', id), { ...p, updated_at: Timestamp.fromMillis(Date.now()) });
  }

  const related: string[] = (contact as any)?.related_buildings ?? [];
  const linkedSet = useMemo(() => new Set(related), [related]);
  const linkedBuildings = useMemo(
    () => buildings.filter((b) => linkedSet.has(b.id)),
    [buildings, linkedSet]
  );
  const availableBuildings = useMemo(
    () => buildings.filter((b) => !linkedSet.has(b.id)),
    [buildings, linkedSet]
  );

  async function linkBuilding() {
    if (!id || !picked) return;
    setBusy(true);
    try {
      await updateDoc(doc(db, 'contacts', id), {
        related_buildings: arrayUnion(picked),
        updated_at: Timestamp.now(),
      });
      setPicked('');
    } catch (e) {
      alert(`Link failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function unlinkBuilding(bid: string) {
    if (!id) return;
    if (!window.confirm('Unlink this building from the contact?')) return;
    setBusy(true);
    try {
      await updateDoc(doc(db, 'contacts', id), {
        related_buildings: arrayRemove(bid),
        updated_at: Timestamp.now(),
      });
    } catch (e) {
      alert(`Unlink failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  if (!contact) return <div className="text-sm text-ink-500">Loading...</div>;

  return (
    <div className="space-y-4">
      <div className="text-xs uppercase tracking-wide text-ink-500">
        <Link to="/contacts" className="hover:underline">Contacts</Link> / {contact.name}
      </div>
      <div className="card p-4 grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <div className="label">Name</div>
          <input className="field" value={contact.name ?? ''} onChange={(e) => patch({ name: e.target.value })} />
        </div>
        <div>
          <div className="label">Role</div>
          <select
            className="field"
            value={contact.role}
            onChange={(e) => patch({ role: e.target.value as ContactRole })}
          >
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div>
          <div className="label">Firm</div>
          <input className="field" value={contact.firm ?? ''} onChange={(e) => patch({ firm: e.target.value })} />
        </div>
        <div>
          <div className="label">Email</div>
          <input className="field" value={contact.email ?? ''} onChange={(e) => patch({ email: e.target.value })} />
        </div>
        <div>
          <div className="label">Phone</div>
          <input className="field" value={contact.phone ?? ''} onChange={(e) => patch({ phone: e.target.value })} />
        </div>
        <div>
          <div className="label">LinkedIn</div>
          <input className="field" value={contact.linkedin ?? ''} onChange={(e) => patch({ linkedin: e.target.value })} />
        </div>
        <div className="md:col-span-2">
          <div className="label">Notes</div>
          <textarea
            className="field min-h-[120px]"
            value={contact.notes ?? ''}
            onChange={(e) => patch({ notes: e.target.value })}
          />
        </div>
      </div>

      <div className="card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Related buildings</h2>
          <Link to="/buildings" className="text-xs text-accent-600 hover:underline">Manage buildings</Link>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="text-sm text-ink-600">Assign building:</label>
          <select
            className="field max-w-md"
            value={picked}
            onChange={(e) => setPicked(e.target.value)}
            disabled={busy || availableBuildings.length === 0}
          >
            <option value="">
              {availableBuildings.length === 0
                ? (buildings.length === 0 ? 'No buildings in this workspace' : 'All buildings already linked')
                : 'Pick a building...'}
            </option>
            {availableBuildings.map((b) => (
              <option key={b.id} value={b.id}>
                {b.address || '(untitled)'}
                {[b.city, b.state].filter(Boolean).length > 0
                  ? ` — ${[b.city, b.state].filter(Boolean).join(', ')}`
                  : ''}
              </option>
            ))}
          </select>
          <button className="btn-primary" onClick={linkBuilding} disabled={!picked || busy}>
            {busy ? 'Linking...' : 'Link to contact'}
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">Address</th>
                <th className="th">City / State</th>
                <th className="th">Asset</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody>
              {linkedBuildings.map((b) => (
                <tr key={b.id} className="hover:bg-ink-50">
                  <td className="td">
                    <Link to={`/buildings/${b.id}`} className="text-accent-600 hover:underline">
                      {b.address || '(untitled)'}
                    </Link>
                  </td>
                  <td className="td">{[b.city, b.state].filter(Boolean).join(', ')}</td>
                  <td className="td"><span className="pill">{b.asset_class}</span></td>
                  <td className="td text-right">
                    <button
                      className="btn-ghost text-xs text-red-600"
                      onClick={() => unlinkBuilding(b.id)}
                      disabled={busy}
                    >
                      Unlink
                    </button>
                  </td>
                </tr>
              ))}
              {linkedBuildings.length === 0 ? (
                <tr><td colSpan={4} className="td text-center text-ink-500 py-6">No linked buildings. Use the picker above.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
