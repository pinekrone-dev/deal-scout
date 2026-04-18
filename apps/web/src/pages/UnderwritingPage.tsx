import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  addDoc,
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  setDoc,
  Timestamp,
  where,
} from 'firebase/firestore';
import { db } from '../lib/firebase';
import { apiFetch } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useWorkspace } from '../lib/workspace';
import type { Assumptions, Building, Underwriting } from '../types';
import { fmtUSD } from '../lib/format';
import UnderwritingPanel from '../components/UnderwritingPanel';

type BRow = Building & { id: string };

const DEFAULT_ASSUMPTIONS: Assumptions = {
  rent_growth_pct: 0.03,
  vacancy_pct: 0.05,
  expense_growth_pct: 0.025,
  mgmt_fee_pct: 0.03,
  capex_reserve_per_unit: 300,
  exit_cap: 0.06,
  hold_years: 5,
  ltv: 0.65,
  rate: 0.065,
  amort_years: 30,
};

function emptyUnderwriting(b: BRow): Underwriting {
  return {
    building_id: b.id,
    asset_class: b.asset_class,
    ttm: { revenue: [], expenses: [], noi: 0 },
    proforma_12mo: { revenue: [], expenses: [], noi: 0 },
    assumptions: { ...DEFAULT_ASSUMPTIONS },
    rent_roll: [],
    lease_roll: [],
    returns: { irr: null, equity_multiple: null, coc_yr1: null, dscr: null },
    version: 1,
  };
}

export default function UnderwritingPage() {
  const { user } = useAuth();
  const { currentOwnerUid, current } = useWorkspace();
  const nav = useNavigate();
  const params = useParams();

  const [buildings, setBuildings] = useState<BRow[]>([]);
  const [filter, setFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(params.id ?? null);
  const [uw, setUw] = useState<Underwriting | null>(null);
  const [loadingUw, setLoadingUw] = useState(false);
  const [exporting, setExporting] = useState(false);

  // Live list of buildings in the active workspace.
  useEffect(() => {
    if (!user || !currentOwnerUid) return;
    const q = query(collection(db, 'buildings'), where('owner_uid', '==', currentOwnerUid));
    const unsub = onSnapshot(q, (snap) => {
      const out: BRow[] = [];
      snap.forEach((d) => out.push({ id: d.id, ...(d.data() as Building) }));
      out.sort((a, b) => (a.address || '').localeCompare(b.address || ''));
      setBuildings(out);
    });
    return () => unsub();
  }, [user, currentOwnerUid]);

  // Auto-select the first building if none chosen.
  useEffect(() => {
    if (selectedId) return;
    if (buildings.length > 0) {
      setSelectedId(buildings[0].id);
    }
  }, [buildings, selectedId]);

  // When selection changes, load its underwriting doc (live).
  useEffect(() => {
    if (!selectedId) {
      setUw(null);
      return;
    }
    setLoadingUw(true);
    const q = query(
      collection(db, 'underwriting'),
      where('building_id', '==', selectedId)
    );
    const unsub = onSnapshot(q, (snap) => {
      if (snap.empty) {
        const b = buildings.find((x) => x.id === selectedId);
        setUw(b ? emptyUnderwriting(b) : null);
      } else {
        const first = snap.docs[0];
        setUw({ id: first.id, ...(first.data() as Omit<Underwriting, 'id'>) });
      }
      setLoadingUw(false);
    });
    return () => unsub();
  }, [selectedId, buildings]);

  const filtered = useMemo(() => {
    const f = filter.toLowerCase();
    if (!f) return buildings;
    return buildings.filter(
      (b) =>
        (b.address || '').toLowerCase().includes(f) ||
        (b.city || '').toLowerCase().includes(f) ||
        (b.state || '').toLowerCase().includes(f) ||
        (b.asset_class || '').toLowerCase().includes(f)
    );
  }, [buildings, filter]);

  const selected = buildings.find((b) => b.id === selectedId) || null;

  async function save(next: Underwriting) {
    if (!selected || !currentOwnerUid) return;
    const payload = {
      ...next,
      building_id: selected.id,
      owner_uid: currentOwnerUid,
      updated_at: Timestamp.now(),
    };
    if (next.id) {
      await setDoc(doc(db, 'underwriting', next.id), payload, { merge: true });
    } else {
      // Look for an existing doc so we don't double up.
      const existing = await getDoc(doc(db, 'underwriting', `${selected.id}_v1`)).catch(() => null);
      if (existing && existing.exists()) {
        await setDoc(doc(db, 'underwriting', existing.id), payload, { merge: true });
      } else {
        await addDoc(collection(db, 'underwriting'), { ...payload, created_at: Timestamp.now() });
      }
    }
  }

  async function exportXlsx() {
    if (!selectedId || !selected) return;
    setExporting(true);
    try {
      const res = await apiFetch(`/api/underwriting/${selectedId}/export.xlsx`);
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const aTag = document.createElement('a');
      aTag.href = url;
      const safe = (selected.address || 'underwriting').replace(/[^a-z0-9]/gi, '_');
      aTag.download = `${safe}_underwriting.xlsx`;
      document.body.appendChild(aTag);
      aTag.click();
      aTag.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Underwriting</h1>
          <p className="text-sm text-ink-500">
            {buildings.length} propert{buildings.length === 1 ? 'y' : 'ies'} in this workspace
            {current && current.role !== 'owner' ? (
              <span className="ml-2 pill">Shared: {current.owner_email}</span>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="btn"
            disabled={!selectedId || exporting}
            onClick={exportXlsx}
            title="Download an Excel workbook with live formulas"
          >
            {exporting ? 'Exporting...' : 'Export to Excel'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-4">
        {/* Sidebar: property list */}
        <aside className="col-span-12 md:col-span-3">
          <div className="card p-3 space-y-2">
            <input
              className="field"
              placeholder="Search properties..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <div className="max-h-[75vh] overflow-y-auto divide-y divide-ink-100 -mx-3">
              {filtered.length === 0 ? (
                <div className="px-3 py-6 text-center text-sm text-ink-500">No properties.</div>
              ) : (
                filtered.map((b) => {
                  const active = b.id === selectedId;
                  return (
                    <button
                      key={b.id}
                      onClick={() => {
                        setSelectedId(b.id);
                        nav(`/underwriting/${b.id}`, { replace: true });
                      }}
                      className={`w-full text-left px-3 py-2 text-sm ${
                        active ? 'bg-accent-50' : 'hover:bg-ink-50'
                      }`}
                    >
                      <div className={`font-medium truncate ${active ? 'text-accent-700' : 'text-ink-900'}`}>
                        {b.address || '(untitled)'}
                      </div>
                      <div className="text-xs text-ink-500 truncate">
                        {[b.city, b.state].filter(Boolean).join(', ') || b.asset_class}
                      </div>
                      {b.asking_price ? (
                        <div className="text-xs text-ink-600 mt-0.5">{fmtUSD(b.asking_price)}</div>
                      ) : null}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </aside>

        {/* Main pane: model */}
        <section className="col-span-12 md:col-span-9">
          {!selected ? (
            <div className="card p-8 text-center text-ink-500">
              Select a property from the list to underwrite it.
            </div>
          ) : loadingUw || !uw ? (
            <div className="card p-8 text-center text-ink-500">Loading model...</div>
          ) : (
            <div className="space-y-4">
              <div className="card p-3 flex items-center justify-between">
                <div>
                  <div className="font-semibold">{selected.address}</div>
                  <div className="text-xs text-ink-500">
                    {selected.asset_class}
                    {selected.units ? ` / ${selected.units} units` : ''}
                    {selected.asking_price ? ` / ${fmtUSD(selected.asking_price)}` : ''}
                  </div>
                </div>
              </div>
              <UnderwritingPanel building={selected} initial={uw} onSave={save} />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
