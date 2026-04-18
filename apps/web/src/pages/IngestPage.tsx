import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { confirmIngestion, getIngestion } from '../lib/api';
import type { AssetClass, Contact } from '../types';
import { ASSET_CLASSES } from '../types';
import { parseNum } from '../lib/format';

type Extracted = {
  building?: {
    address?: string;
    city?: string;
    state?: string;
    zip?: string;
    asset_class?: AssetClass;
    units?: number;
    sf?: number;
    nrsf?: number;
    keys?: number;
    year_built?: number;
    year_renovated?: number;
    occupancy?: number;
    current_noi?: number;
    asking_price?: number;
    cap_rate?: number;
    notes?: string;
  };
  contacts?: Array<Partial<Contact>>;
  financials?: {
    ttm?: { revenue?: Array<{ label: string; amount: number }>; expenses?: Array<{ label: string; amount: number }> };
    ttm_period?: { start_month?: string; end_month?: string; label?: string };
    ttm_monthly?: {
      months?: string[];
      revenue?: Array<{ label: string; amounts: number[] }>;
      expenses?: Array<{ label: string; amounts: number[] }>;
    };
    proforma_12mo?: {
      months?: string[];
      revenue?: Array<{ label: string; amounts: number[] }>;
      expenses?: Array<{ label: string; amounts: number[] }>;
    };
  };
};

export default function IngestPage() {
  const { ingestionId } = useParams<{ ingestionId: string }>();
  const [status, setStatus] = useState<'pending' | 'running' | 'done' | 'error'>('pending');
  const [extracted, setExtracted] = useState<Extracted | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const nav = useNavigate();

  useEffect(() => {
    if (!ingestionId) return;
    let cancelled = false;
    async function poll() {
      while (!cancelled) {
        try {
          const r = await getIngestion(ingestionId!);
          setStatus(r.extraction_status);
          if (r.raw_extraction) setExtracted(r.raw_extraction as Extracted);
          if (r.error) setError(r.error);
          if (r.extraction_status === 'done' || r.extraction_status === 'error') return;
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
          return;
        }
        await new Promise((res) => setTimeout(res, 2000));
      }
    }
    poll();
    return () => { cancelled = true; };
  }, [ingestionId]);

  async function confirm() {
    if (!ingestionId || !extracted) return;
    setSaving(true);
    try {
      const r = await confirmIngestion(ingestionId, extracted as unknown as Record<string, unknown>);
      nav(`/buildings/${r.building_id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  function updateBuilding<K extends keyof NonNullable<Extracted['building']>>(key: K, value: NonNullable<Extracted['building']>[K]) {
    setExtracted((x) => ({ ...(x ?? {}), building: { ...((x?.building ?? {}) as NonNullable<Extracted['building']>), [key]: value } }));
  }

  function updateContact(i: number, patch: Partial<Contact>) {
    setExtracted((x) => {
      const list = [...(x?.contacts ?? [])];
      list[i] = { ...list[i], ...patch };
      return { ...(x ?? {}), contacts: list };
    });
  }

  function addContact() {
    setExtracted((x) => ({ ...(x ?? {}), contacts: [...(x?.contacts ?? []), { name: '', role: 'broker' }] }));
  }

  function removeContact(i: number) {
    setExtracted((x) => ({ ...(x ?? {}), contacts: (x?.contacts ?? []).filter((_, j) => j !== i) }));
  }

  if (status === 'pending' || status === 'running') {
    return (
      <div className="card p-6">
        <div className="text-ink-700 font-medium">Extracting OM...</div>
        <div className="text-sm text-ink-500">Running Gemini vision extraction. This takes 10-60 seconds per document.</div>
        <div className="mt-4 h-2 bg-ink-200 rounded overflow-hidden">
          <div className="h-2 bg-accent-500 animate-pulse w-1/3" />
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return <div className="card p-6 text-red-600">Extraction failed: {error ?? 'unknown error'}</div>;
  }

  const b = extracted?.building ?? {};
  const contacts = extracted?.contacts ?? [];
  const fin = extracted?.financials ?? {};

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Review extracted data</h1>
        <p className="text-sm text-ink-500">Edit anything that looks wrong. Confirm to create the Building, Contacts, and Underwriting records.</p>
      </div>

      <div className="card p-4 space-y-3">
        <div className="font-semibold">Building</div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <Field label="Address" value={b.address ?? ''} onChange={(v) => updateBuilding('address', v)} />
          <Field label="City" value={b.city ?? ''} onChange={(v) => updateBuilding('city', v)} />
          <Field label="State" value={b.state ?? ''} onChange={(v) => updateBuilding('state', v)} />
          <Field label="Zip" value={b.zip ?? ''} onChange={(v) => updateBuilding('zip', v)} />
          <div>
            <div className="label">Asset Class</div>
            <select
              className="field"
              value={b.asset_class ?? 'multifamily'}
              onChange={(e) => updateBuilding('asset_class', e.target.value as AssetClass)}
            >
              {ASSET_CLASSES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <NumField label="Units" value={b.units} onChange={(v) => updateBuilding('units', v)} />
          <NumField label="SF" value={b.sf} onChange={(v) => updateBuilding('sf', v)} />
          <NumField label="Keys" value={b.keys} onChange={(v) => updateBuilding('keys', v)} />
          <NumField label="NRSF" value={b.nrsf} onChange={(v) => updateBuilding('nrsf', v)} />
          <NumField label="Year Built" value={b.year_built} onChange={(v) => updateBuilding('year_built', v)} />
          <NumField label="Year Renovated" value={b.year_renovated} onChange={(v) => updateBuilding('year_renovated', v)} />
          <NumField label="Occupancy %" value={b.occupancy !== undefined ? b.occupancy * 100 : undefined} onChange={(v) => updateBuilding('occupancy', v / 100)} />
          <NumField label="Asking Price" value={b.asking_price} onChange={(v) => updateBuilding('asking_price', v)} />
          <NumField label="Current NOI" value={b.current_noi} onChange={(v) => updateBuilding('current_noi', v)} />
          <NumField label="Cap Rate %" value={b.cap_rate !== undefined ? b.cap_rate * 100 : undefined} onChange={(v) => updateBuilding('cap_rate', v / 100)} />
        </div>
        <div>
          <div className="label">Notes</div>
          <textarea className="field min-h-[80px]" value={b.notes ?? ''} onChange={(e) => updateBuilding('notes', e.target.value)} />
        </div>
      </div>

      <div className="card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="font-semibold">Contacts</div>
          <button className="btn-ghost text-xs" onClick={addContact}>+ add contact</button>
        </div>
        {contacts.length === 0 ? <div className="text-sm text-ink-500">No contacts extracted.</div> : null}
        {contacts.map((c, i) => (
          <div key={i} className="grid grid-cols-2 md:grid-cols-5 gap-2 items-end">
            <Field label="Name" value={c.name ?? ''} onChange={(v) => updateContact(i, { name: v })} />
            <div>
              <div className="label">Role</div>
              <select className="field" value={c.role ?? 'broker'} onChange={(e) => updateContact(i, { role: e.target.value as Contact['role'] })}>
                {['broker','sponsor','owner','lender','tenant','other'].map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <Field label="Firm" value={c.firm ?? ''} onChange={(v) => updateContact(i, { firm: v })} />
            <Field label="Email" value={c.email ?? ''} onChange={(v) => updateContact(i, { email: v })} />
            <div className="flex gap-2 items-end">
              <Field label="Phone" value={c.phone ?? ''} onChange={(v) => updateContact(i, { phone: v })} />
              <button className="btn-ghost text-xs" onClick={() => removeContact(i)}>x</button>
            </div>
          </div>
        ))}
      </div>

      <div className="card p-4 space-y-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="font-semibold">TTM Financials (preview)</div>
          <div className="flex items-center gap-2 text-xs">
            {fin.ttm_period?.label ? <span className="pill">{fin.ttm_period.label}</span> : null}
            {fin.ttm_monthly ? <span className="pill">Monthly detail extracted</span> : null}
            {fin.proforma_12mo ? <span className="pill">OM proforma extracted</span> : null}
          </div>
        </div>
        <div className="text-xs text-ink-500">
          These annual totals will populate the Underwriting tab. If the OM included a monthly P&amp;L or
          a 12-month proforma, they'll be visible on the Underwriting &rarr; 12-Month Proforma tab.
        </div>
        <div className="grid grid-cols-2 gap-6">
          <div>
            <div className="label">Revenue</div>
            <ul className="text-sm">
              {(fin.ttm?.revenue ?? []).map((li, i) => <li key={i} className="flex justify-between border-b border-ink-100 py-0.5"><span>{li.label}</span><span className="num">{Math.round(li.amount).toLocaleString()}</span></li>)}
            </ul>
          </div>
          <div>
            <div className="label">Expenses</div>
            <ul className="text-sm">
              {(fin.ttm?.expenses ?? []).map((li, i) => <li key={i} className="flex justify-between border-b border-ink-100 py-0.5"><span>{li.label}</span><span className="num">{Math.round(li.amount).toLocaleString()}</span></li>)}
            </ul>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button className="btn-primary" onClick={confirm} disabled={saving || !b.address}>
          {saving ? 'Saving...' : 'Confirm and Create'}
        </button>
        <button className="btn" onClick={() => nav('/buildings')}>Cancel</button>
        {!b.address && !saving ? (
          <div className="text-sm text-amber-600">Address is required. Fill it in above to enable Confirm.</div>
        ) : null}
        {error ? <div className="text-sm text-red-600 whitespace-pre-wrap">{error}</div> : null}
      </div>
    </div>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <div className="label">{label}</div>
      <input className="field" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function NumField({ label, value, onChange }: { label: string; value: number | undefined; onChange: (v: number) => void }) {
  return (
    <div>
      <div className="label">{label}</div>
      <input
        className="field num"
        value={value ?? ''}
        onChange={(e) => onChange(parseNum(e.target.value))}
      />
    </div>
  );
}
