import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  addDoc,
  collection,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  Timestamp,
  updateDoc,
  where
} from 'firebase/firestore';
import { db, auth } from '../lib/firebase';
import type { AssetClass, Building, Contact, Underwriting } from '../types';
import { ASSET_CLASSES } from '../types';
import UnderwritingPanel from '../components/UnderwritingPanel';
import { blankUnderwriting } from '../underwriting/engine';
import { fmtNum, fmtPct, fmtUSD, parseNum } from '../lib/format';

type Tab = 'overview' | 'underwriting' | 'documents' | 'contacts';

export default function BuildingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [tab, setTab] = useState<Tab>('overview');
  const [building, setBuilding] = useState<Building | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [underwriting, setUnderwriting] = useState<Underwriting | null>(null);
  const [uwLoading, setUwLoading] = useState(true);
  const [contacts, setContacts] = useState<(Contact & { id: string })[]>([]);

  useEffect(() => {
    if (!id) return;
    setMissing(false);
    setLoadError(null);
    let settled = false;
    // One-shot fetch so we get a definitive answer fast and can show a real error.
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
    // Live listener keeps it in sync after the first fetch.
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

  useEffect(() => {
    if (!id) return;
    const q = query(
      collection(db, 'underwriting'),
      where('building_id', '==', id),
      orderBy('version', 'desc')
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        if (!snap.empty) {
          const d = snap.docs[0];
          setUnderwriting({ id: d.id, ...(d.data() as Underwriting) });
        } else {
          setUnderwriting(null);
        }
        setUwLoading(false);
      },
      () => { setUwLoading(false); }
    );
    return () => unsub();
  }, [id]);

  useEffect(() => {
    if (!id) return;
    const q = query(collection(db, 'contacts'), where('related_buildings', 'array-contains', id));
    const unsub = onSnapshot(q, (snap) => {
      const out: (Contact & { id: string })[] = [];
      snap.forEach((d) => out.push({ id: d.id, ...(d.data() as Contact) }));
      setContacts(out);
    });
    return () => unsub();
  }, [id]);

  async function patchBuilding(p: Partial<Building>) {
    if (!id) return;
    await updateDoc(doc(db, 'buildings', id), { ...p, updated_at: Timestamp.fromMillis(Date.now()) });
  }

  async function createInitialUnderwriting() {
    if (!id || !building) return;
    const uw = blankUnderwriting({ ...building, id });
    const ref = await addDoc(collection(db, 'underwriting'), {
      ...uw,
      created_at: Timestamp.fromMillis(Date.now())
    });
    setUnderwriting({ ...uw, id: ref.id });
  }

  async function saveNewVersion(uw: Underwriting) {
    if (!id) return;
    const nextVersion = (underwriting?.version ?? 0) + 1;
    const payload = { ...uw, version: nextVersion, building_id: id };
    await setDoc(doc(collection(db, 'underwriting')), {
      ...payload,
      created_at: Timestamp.fromMillis(Date.now())
    });
    // Also update building-level rollup
    await patchBuilding({
      current_noi: uw.ttm.noi,
      cap_rate: building?.asking_price ? uw.ttm.noi / building.asking_price : undefined
    });
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
        </div>
      </div>

      <div className="flex items-center gap-1 border-b border-ink-200">
        {(['overview', 'underwriting', 'documents', 'contacts'] as Tab[]).map((t) => (
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

      {tab === 'underwriting' ? (
        <div>
          {uwLoading ? (
            <div className="text-sm text-ink-500">Loading underwriting...</div>
          ) : underwriting ? (
            <UnderwritingPanel
              building={building}
              initial={underwriting}
              onSave={saveNewVersion}
            />
          ) : (
            <div className="card p-6 text-center">
              <div className="text-ink-700 font-medium">No underwriting yet.</div>
              <div className="text-sm text-ink-500">Start with a template based on asset class.</div>
              <button className="btn-primary mt-4" onClick={createInitialUnderwriting}>
                Create Underwriting
              </button>
            </div>
          )}
        </div>
      ) : null}

      {tab === 'documents' ? <DocumentsTab building={building} /> : null}

      {tab === 'contacts' ? <ContactsTab contacts={contacts} /> : null}
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

function ContactsTab({ contacts }: { contacts: (Contact & { id: string })[] }) {
  return (
    <div className="card overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr>
            <th className="th">Name</th>
            <th className="th">Role</th>
            <th className="th">Firm</th>
            <th className="th">Email</th>
            <th className="th">Phone</th>
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
            </tr>
          ))}
          {contacts.length === 0 ? (
            <tr><td colSpan={5} className="td text-center text-ink-500 py-6">No linked contacts yet.</td></tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
