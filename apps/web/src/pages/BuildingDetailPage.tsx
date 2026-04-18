import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  query,
  setDoc,
  Timestamp,
  updateDoc,
  where
} from 'firebase/firestore';
import { arrayRemove, arrayUnion } from 'firebase/firestore';
import { db, auth } from '../lib/firebase';
import { useAuth } from '../lib/auth';
import { useWorkspace } from '../lib/workspace';
import { apiFetch } from '../lib/api';
import type { AssetClass, Building, Contact } from '../types';
import { ASSET_CLASSES } from '../types';
import { fmtNum, fmtPct, fmtUSD, parseNum } from '../lib/format';

type Tab = 'overview' | 'documents' | 'contacts';

export default function BuildingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const { currentOwnerUid } = useWorkspace();
  const nav = useNavigate();
  const [tab, setTab] = useState<Tab>('overview');
  const [building, setBuilding] = useState<Building | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [contacts, setContacts] = useState<(Contact & { id: string })[]>([]);
  const [allContacts, setAllContacts] = useState<(Contact & { id: string })[]>([]);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!id) return;
    setMissing(false);
    setLoadError(null);
    let settled = false;
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'buildings', id));
        if (settled) return;
        if (snap.exists()) {
          setBuilding({ id: snap.id, ...(snap.data() as Building) });
        } else {
          setMissing(true);
        }
      } catch (e) {
        if (!settled) setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    const unsub = onSnapshot(
      doc(db, 'buildings', id),
      (snap) => {
        settled = true;
        if (snap.exists()) {
          setBuilding({ id: snap.id, ...(snap.data() as Building) });
          setMissing(false);
        } else {
          setMissing(true);
        }
      },
      (err) => {
        settled = true;
        setLoadError(err?.message ?? String(err));
      }
    );
    return () => { settled = true; unsub(); };
  }, [id]);

  // Underwriting docs are owned by the building's owner_uid (the workspace),
  // so query by the building's owner to support members reading a shared workspace.
  const buildingOwnerUid = building?.owner_uid ?? currentOwnerUid ?? null;

  useEffect(() => {
    if (!id || !user || !buildingOwnerUid) return;
    const q = query(
      collection(db, 'contacts'),
      where('owner_uid', '==', buildingOwnerUid),
      where('related_buildings', 'array-contains', id)
    );
    const unsub = onSnapshot(q, (snap) => {
      const out: (Contact & { id: string })[] = [];
      snap.forEach((d) => out.push({ id: d.id, ...(d.data() as Contact) }));
      setContacts(out);
    });
    return () => unsub();
  }, [id, user, buildingOwnerUid]);

  // All contacts in the workspace so the "Assign contact" picker has options.
  useEffect(() => {
    if (!user || !buildingOwnerUid) return;
    const q = query(collection(db, 'contacts'), where('owner_uid', '==', buildingOwnerUid));
    const unsub = onSnapshot(q, (snap) => {
      const out: (Contact & { id: string })[] = [];
      snap.forEach((d) => out.push({ id: d.id, ...(d.data() as Contact) }));
      out.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      setAllContacts(out);
    });
    return () => unsub();
  }, [user, buildingOwnerUid]);

  async function linkContact(contactId: string) {
    if (!id) return;
    await updateDoc(doc(db, 'contacts', contactId), {
      related_buildings: arrayUnion(id),
      updated_at: Timestamp.now(),
    });
  }

  async function unlinkContact(contactId: string) {
    if (!id) return;
    await updateDoc(doc(db, 'contacts', contactId), {
      related_buildings: arrayRemove(id),
      updated_at: Timestamp.now(),
    });
  }

  async function patchBuilding(p: Partial<Building>) {
    if (!id) return;
    await updateDoc(doc(db, 'buildings', id), { ...p, updated_at: Timestamp.fromMillis(Date.now()) });
  }

  async function deleteBuilding() {
    if (!id) return;
    if (!window.confirm(`Delete "${building?.address || 'this building'}" and all related underwriting, deals, and OM files? This cannot be undone.`)) {
      return;
    }
    setDeleting(true);
    try {
      const res = await apiFetch(`/api/buildings/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const text = await res.text();
        if (res.status === 404 || res.status === 405) {
          await deleteDoc(doc(db, 'buildings', id));
        } else {
          throw new Error(`${res.status} ${text}`);
        }
      }
      nav('/buildings');
    } catch (e) {
      alert(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDeleting(false);
    }
  }

  if (loadError) {
    return (
      <div className="card p-6 space-y-2">
        <div className="text-red-600 font-medium">Could not load building {id}.</div>
        <div className="text-sm text-ink-700 whitespace-pre-wrap">{loadError}</div>
        <div className="text-xs text-ink-500">Signed in as: {auth.currentUser?.email ?? 'anonymous'}</div>
      </div>
    );
  }
  if (missing) {
    return (
      <div className="card p-6 space-y-2">
        <div className="text-amber-600 font-medium">Building {id} does not exist in Firestore.</div>
        <div className="text-sm text-ink-500">
          The save returned a building id but the doc was not found. This usually means the write hit a different project
          or the create transaction was rolled back. <Link to="/buildings" className="text-accent-600 hover:underline">Back to Buildings</Link>.
        </div>
        <div className="text-xs text-ink-500">Signed in as: {auth.currentUser?.email ?? 'anonymous'}</div>
      </div>
    );
  }
  if (!building) {
    return <div className="text-sm text-ink-500">Loading building...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-wide text-ink-500">
            <Link to="/buildings" className="hover:underline">Buildings</Link> / {building.address}
          </div>
          <h1 className="text-xl font-semibold">{building.address || '(untitled)'}</h1>
          <div className="text-sm text-ink-500">
            {[building.city, building.state, building.zip].filter(Boolean).join(', ')}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="pill">{building.asset_class}</span>
          <span className="pill">NOI {fmtUSD(building.current_noi ?? null)}</span>
          <span className="pill">Cap {fmtPct(building.cap_rate ?? null)}</span>
          <button
            className="btn-ghost text-xs text-red-600"
            onClick={deleteBuilding}
            disabled={deleting}
            title="Delete this building"
          >
            {deleting ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      </div>

      <div className="flex items-center gap-1 border-b border-ink-200">
        {(['overview', 'documents', 'contacts'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-2 text-sm font-medium border-b-2 ${
              tab === t ? 'border-accent-600 text-ink-900' : 'border-transparent text-ink-500 hover:text-ink-800'
            }`}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === 'overview' ? <OverviewTab building={building} patch={patchBuilding} /> : null}

      {tab === 'documents' ? <DocumentsTab building={building} /> : null}

      {tab === 'contacts' ? (
        <ContactsTab
          contacts={contacts}
          allContacts={allContacts}
          onLink={linkContact}
          onUnlink={unlinkContact}
        />
      ) : null}
    </div>
  );
}

function OverviewTab({ building, patch }: { building: Building; patch: (p: Partial<Building>) => Promise<void> }) {
  const ac = building.asset_class;
  const showUnits = ['multifamily', 'mixed-use', 'other'].includes(ac);
  const showSf = ['office', 'retail', 'industrial', 'mixed-use', 'other'].includes(ac);
  const showKeys = ac === 'hospitality';
  const showNrsf = ac === 'self-storage';
  const showLand = ac === 'land';
  const showHotelRates = ac === 'hospitality';

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div className="card p-4 md:col-span-2 space-y-4">
        <div>
          <div className="label">Address</div>
          <input
            className="field"
            value={building.address ?? ''}
            onChange={(e) => patch({ address: e.target.value })}
          />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <div className="label">City</div>
            <input className="field" value={building.city ?? ''} onChange={(e) => patch({ city: e.target.value })} />
          </div>
          <div>
            <div className="label">State</div>
            <input className="field" value={building.state ?? ''} onChange={(e) => patch({ state: e.target.value })} />
          </div>
          <div>
            <div className="label">Zip</div>
            <input className="field" value={building.zip ?? ''} onChange={(e) => patch({ zip: e.target.value })} />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <div className="label">Asset Class</div>
            <select
              className="field"
              value={building.asset_class}
              onChange={(e) => patch({ asset_class: e.target.value as AssetClass })}
            >
              {ASSET_CLASSES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          {showUnits ? (
            <div>
              <div className="label">Units</div>
              <input
                className="field num"
                value={building.units ?? ''}
                onChange={(e) => patch({ units: parseNum(e.target.value) })}
              />
            </div>
          ) : null}
          {showSf ? (
            <div>
              <div className="label">Rentable SF</div>
              <input
                className="field num"
                value={building.sf ?? ''}
                onChange={(e) => patch({ sf: parseNum(e.target.value) })}
              />
            </div>
          ) : null}
          {showKeys ? (
            <div>
              <div className="label">Keys</div>
              <input
                className="field num"
                value={building.keys ?? ''}
                onChange={(e) => patch({ keys: parseNum(e.target.value) })}
              />
            </div>
          ) : null}
          {showNrsf ? (
            <div>
              <div className="label">NRSF</div>
              <input
                className="field num"
                value={building.nrsf ?? ''}
                onChange={(e) => patch({ nrsf: parseNum(e.target.value) })}
              />
            </div>
          ) : null}
        </div>

        {showLand ? (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="label">Zoning</div>
              <input className="field" value={building.zoning ?? ''} onChange={(e) => patch({ zoning: e.target.value })} />
            </div>
            <div>
              <div className="label">Entitlements</div>
              <input className="field" value={building.entitlements ?? ''} onChange={(e) => patch({ entitlements: e.target.value })} />
            </div>
          </div>
        ) : null}

        <div className="grid grid-cols-4 gap-3">
          <div>
            <div className="label">Year Built</div>
            <input className="field num" value={building.year_built ?? ''} onChange={(e) => patch({ year_built: parseNum(e.target.value) })} />
          </div>
          <div>
            <div className="label">Year Renovated</div>
            <input className="field num" value={building.year_renovated ?? ''} onChange={(e) => patch({ year_renovated: parseNum(e.target.value) })} />
          </div>
          <div>
            <div className="label">Occupancy %</div>
            <input
              className="field num"
              value={building.occupancy !== undefined && building.occupancy !== null ? building.occupancy * 100 : ''}
              onChange={(e) => patch({ occupancy: parseNum(e.target.value) / 100 })}
            />
          </div>
          <div>
            <div className="label">Asking Price</div>
            <input
              className="field num"
              value={building.asking_price ?? ''}
              onChange={(e) => patch({ asking_price: parseNum(e.target.value) })}
            />
          </div>
        </div>

        {showHotelRates ? (
          <div className="grid grid-cols-3 gap-3">
            <div>
              <div className="label">ADR</div>
              <input className="field num" value={building.adr ?? ''} onChange={(e) => patch({ adr: parseNum(e.target.value) })} />
            </div>
            <div>
              <div className="label">RevPAR</div>
              <input className="field num" value={building.revpar ?? ''} onChange={(e) => patch({ revpar: parseNum(e.target.value) })} />
            </div>
          </div>
        ) : null}

        <div>
          <div className="label">Notes</div>
          <textarea
            className="field min-h-[120px]"
            value={building.notes ?? ''}
            onChange={(e) => patch({ notes: e.target.value })}
          />
        </div>
      </div>

      <aside className="card p-4 space-y-3">
        <div>
          <div className="label">Current NOI</div>
          <div className="num text-lg">{fmtUSD(building.current_noi ?? null)}</div>
        </div>
        <div>
          <div className="label">Cap Rate</div>
          <div className="num text-lg">{fmtPct(building.cap_rate ?? null)}</div>
        </div>
        <div>
          <div className="label">Units / SF</div>
          <div className="num">{fmtNum(building.units ?? 0)} / {fmtNum(building.sf ?? 0)}</div>
        </div>
      </aside>
    </div>
  );
}

function DocumentsTab({ building }: { building: Building }) {
  const docs = building.documents ?? [];
  return (
    <div className="card p-4">
      <div className="label">Documents</div>
      {docs.length === 0 ? (
        <div className="text-sm text-ink-500">No documents attached. Upload via the OM flow on the Buildings page.</div>
      ) : (
        <ul className="mt-2 text-sm text-ink-800">
          {docs.map((d, i) => (
            <li key={i} className="py-1 border-b border-ink-100 break-all">
              <a className="text-accent-600 hover:underline" href={d} target="_blank" rel="noreferrer">{d}</a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ContactsTab({
  contacts,
  allContacts,
  onLink,
  onUnlink,
}: {
  contacts: (Contact & { id: string })[];
  allContacts: (Contact & { id: string })[];
  onLink: (contactId: string) => Promise<void>;
  onUnlink: (contactId: string) => Promise<void>;
}) {
  const [picked, setPicked] = useState('');
  const [busy, setBusy] = useState(false);
  const linkedIds = new Set(contacts.map((c) => c.id));
  const available = allContacts.filter((c) => !linkedIds.has(c.id));

  async function assign() {
    if (!picked) return;
    setBusy(true);
    try {
      await onLink(picked);
      setPicked('');
    } catch (e) {
      alert(`Assign failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove(contactId: string, name: string) {
    if (!window.confirm(`Unlink "${name || 'this contact'}" from this building?`)) return;
    setBusy(true);
    try {
      await onUnlink(contactId);
    } catch (e) {
      alert(`Unlink failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="card p-3 flex flex-wrap items-center gap-2">
        <label className="text-sm text-ink-600">Assign contact:</label>
        <select
          className="field max-w-sm"
          value={picked}
          onChange={(e) => setPicked(e.target.value)}
          disabled={busy || available.length === 0}
        >
          <option value="">{available.length === 0 ? 'All contacts already linked' : 'Pick a contact...'}</option>
          {available.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name || '(unnamed)'}{c.firm ? ` — ${c.firm}` : ''}{c.role ? ` [${c.role}]` : ''}
            </option>
          ))}
        </select>
        <button className="btn-primary" onClick={assign} disabled={!picked || busy}>
          {busy ? 'Linking...' : 'Link to building'}
        </button>
        <div className="flex-1" />
        <Link to="/contacts" className="text-xs text-accent-600 hover:underline">Manage contacts</Link>
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
            {contacts.map((c) => (
              <tr key={c.id} className="hover:bg-ink-50">
                <td className="td">
                  <Link to={`/contacts/${c.id}`} className="text-accent-600 hover:underline">{c.name}</Link>
                </td>
                <td className="td"><span className="pill">{c.role}</span></td>
                <td className="td">{c.firm ?? ''}</td>
                <td className="td">{c.email ?? ''}</td>
                <td className="td">{c.phone ?? ''}</td>
                <td className="td text-right">
                  <button
                    className="btn-ghost text-xs text-red-600"
                    onClick={() => remove(c.id, c.name || '')}
                    disabled={busy}
                  >
                    Unlink
                  </button>
                </td>
              </tr>
            ))}
            {contacts.length === 0 ? (
              <tr><td colSpan={6} className="td text-center text-ink-500 py-6">No linked contacts yet. Use the picker above.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
