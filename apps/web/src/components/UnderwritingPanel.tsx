import { useEffect, useMemo, useState } from 'react';
import type { Assumptions, Building, LineItem, MonthlyStatement, Statement, Underwriting } from '../types';
import { fmtPct, fmtUSD, parseNum } from '../lib/format';
import { buildProformaFromTtm, computeNoi, computeReturns } from '../underwriting/engine';

type UwTab = 'financials' | 'proforma-12' | 'assumptions' | 'rent-roll' | 'lease-roll';

function _bumpMonth(ym: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return ym;
  return `${Number(m[1]) + 1}-${m[2]}`;
}

function deriveProformaMonthly(ttm: MonthlyStatement | null | undefined, a: Assumptions): MonthlyStatement | null {
  if (!ttm) return null;
  const rg = a.rent_growth_pct ?? 0;
  const eg = a.expense_growth_pct ?? 0;
  const months = (ttm.months || []).map(_bumpMonth);
  const revenue = (ttm.revenue || []).map((li) => ({
    label: li.label,
    amounts: (li.amounts || []).map((x) => Math.round(x * (1 + rg) * 100) / 100),
  }));
  const expenses = (ttm.expenses || []).map((li) => ({
    label: li.label,
    amounts: (li.amounts || []).map((x) => Math.round(x * (1 + eg) * 100) / 100),
  }));
  return { months, revenue, expenses, source: 'derived' };
}

function sumLine(arr: number[] | undefined): number {
  if (!arr) return 0;
  let s = 0;
  for (const n of arr) if (typeof n === 'number' && isFinite(n)) s += n;
  return s;
}

function monthlyNoiSeries(m: MonthlyStatement | null | undefined): number[] {
  if (!m) return [];
  const rev: number[] = new Array(12).fill(0);
  const exp: number[] = new Array(12).fill(0);
  for (const li of m.revenue || []) for (let i = 0; i < 12; i++) rev[i] += li.amounts?.[i] ?? 0;
  for (const li of m.expenses || []) for (let i = 0; i < 12; i++) exp[i] += li.amounts?.[i] ?? 0;
  return rev.map((r, i) => r - exp[i]);
}

function formatMonthLabel(ym: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return ym || '';
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const n = Number(m[2]);
  return `${names[n - 1] ?? m[2]} ${m[1].slice(2)}`;
}

export default function UnderwritingPanel({
  building,
  initial,
  onSave
}: {
  building: Building;
  initial: Underwriting;
  onSave: (uw: Underwriting) => Promise<void>;
}) {
  const [ttm, setTtm] = useState<Statement>(initial.ttm);
  const [assumptions, setAssumptions] = useState<Assumptions>(initial.assumptions);
  const [rentRoll, setRentRoll] = useState(initial.rent_roll ?? []);
  const [leaseRoll, setLeaseRoll] = useState(initial.lease_roll ?? []);
  const [ttmMonthly] = useState<MonthlyStatement | null>(initial.ttm_monthly ?? null);
  const [proformaMonthlyOM] = useState<MonthlyStatement | null>(initial.proforma_12mo_monthly ?? null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<UwTab>('financials');

  useEffect(() => {
    setTtm(initial.ttm);
    setAssumptions(initial.assumptions);
    setRentRoll(initial.rent_roll ?? []);
    setLeaseRoll(initial.lease_roll ?? []);
    setDirty(false);
  }, [initial]);

  // All derived values recompute live as inputs change.
  const proforma = useMemo(() => buildProformaFromTtm(ttm, assumptions), [ttm, assumptions]);
  const returns = useMemo(
    () => computeReturns(building, ttm, proforma, assumptions),
    [building, ttm, proforma, assumptions]
  );

  const ttmNoi = useMemo(() => computeNoi(ttm), [ttm]);
  const proformaNoi = useMemo(() => computeNoi(proforma), [proforma]);

  // Prefer the OM's own 12-month proforma; otherwise derive one from TTM monthly.
  const proformaMonthly = useMemo<MonthlyStatement | null>(() => {
    if (proformaMonthlyOM) return proformaMonthlyOM;
    return deriveProformaMonthly(ttmMonthly, assumptions);
  }, [proformaMonthlyOM, ttmMonthly, assumptions]);

  function updateItem(scope: 'revenue' | 'expenses', idx: number, patch: Partial<LineItem>) {
    setTtm((s) => {
      const next = { ...s, [scope]: s[scope].map((li, i) => (i === idx ? { ...li, ...patch } : li)) };
      next.noi = computeNoi(next);
      return next;
    });
    setDirty(true);
  }

  function addItem(scope: 'revenue' | 'expenses') {
    setTtm((s) => ({ ...s, [scope]: [...s[scope], { label: 'New line', amount: 0 }] }));
    setDirty(true);
  }

  function removeItem(scope: 'revenue' | 'expenses', idx: number) {
    setTtm((s) => ({ ...s, [scope]: s[scope].filter((_, i) => i !== idx) }));
    setDirty(true);
  }

  function updateAssumption<K extends keyof Assumptions>(key: K, value: Assumptions[K]) {
    setAssumptions((a) => ({ ...a, [key]: value }));
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    try {
      const uw: Underwriting = {
        ...initial,
        ttm: { ...ttm, noi: ttmNoi },
        proforma_12mo: { ...proforma, noi: proformaNoi },
        assumptions,
        rent_roll: rentRoll,
        lease_roll: leaseRoll,
        returns,
        version: initial.version,
        building_id: building.id ?? initial.building_id,
        asset_class: building.asset_class
      };
      await onSave(uw);
      setDirty(false);
    } finally {
      setSaving(false);
    }
  }

  const ac = building.asset_class;
  const showRentRoll = ac === 'multifamily';
  const showLeaseRoll = ['office', 'retail', 'industrial', 'mixed-use'].includes(ac);
  const isLand = ac === 'land';

  const hasMonthly = !!(ttmMonthly || proformaMonthly);
  const tabs: { id: UwTab; label: string; show: boolean }[] = [
    { id: 'financials', label: 'Financials', show: true },
    { id: 'proforma-12', label: '12-Month Proforma', show: !isLand && hasMonthly },
    { id: 'assumptions', label: 'Assumptions', show: !isLand },
    { id: 'rent-roll', label: 'Rent Roll', show: showRentRoll },
    { id: 'lease-roll', label: 'Lease Roll', show: showLeaseRoll }
  ];

  return (
    <div className="space-y-4">
      {isLand ? (
        <div className="card p-4">
          <div className="text-ink-700 font-medium">Land deal</div>
          <p className="text-sm text-ink-500 mt-1">
            Land has no operating cashflows. Use the Overview tab for price, zoning, and entitlement notes.
          </p>
        </div>
      ) : null}

      {/* Live returns panel is always visible so Kevin can see the effect of any input change at a glance. */}
      <div className="card p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="font-semibold">Returns <span className="text-xs text-ink-500 font-normal">(live)</span></div>
          <div className="text-xs text-ink-500">NOI TTM {fmtUSD(ttmNoi)} / Proforma {fmtUSD(proformaNoi)}</div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Metric label="Levered IRR" value={returns.irr !== null ? fmtPct(returns.irr) : '-'} />
          <Metric label="Equity Multiple" value={returns.equity_multiple !== null ? `${returns.equity_multiple.toFixed(2)}x` : '-'} />
          <Metric label="CoC Year 1" value={returns.coc_yr1 !== null ? fmtPct(returns.coc_yr1) : '-'} />
          <Metric label="DSCR" value={returns.dscr !== null ? returns.dscr.toFixed(2) : '-'} />
        </div>
      </div>

      <div className="flex items-center gap-1 border-b border-ink-200">
        {tabs.filter((t) => t.show).map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 py-2 text-sm font-medium border-b-2 ${
              tab === t.id ? 'border-accent-600 text-ink-900' : 'border-transparent text-ink-500 hover:text-ink-800'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'financials' ? (
        <div className="card p-3">
          <StatementTable
            ttm={ttm}
            proforma={proforma}
            readOnly={isLand}
            onUpdate={updateItem}
            onAdd={addItem}
            onRemove={removeItem}
          />
        </div>
      ) : null}

      {tab === 'proforma-12' ? (
        <MonthlyTables
          ttm={ttmMonthly}
          proforma={proformaMonthly}
        />
      ) : null}

      {tab === 'assumptions' && !isLand ? (
        <AssumptionsTab ac={ac} assumptions={assumptions} update={updateAssumption} />
      ) : null}

      {tab === 'rent-roll' && showRentRoll ? (
        <RentRollEditor rows={rentRoll} onChange={(r) => { setRentRoll(r); setDirty(true); }} />
      ) : null}

      {tab === 'lease-roll' && showLeaseRoll ? (
        <LeaseRollEditor rows={leaseRoll} onChange={(r) => { setLeaseRoll(r); setDirty(true); }} />
      ) : null}

      <div className="flex items-center gap-3">
        <button className="btn-primary" onClick={save} disabled={!dirty || saving}>
          {saving ? 'Saving...' : dirty ? `Save as version ${initial.version + 1}` : 'Saved'}
        </button>
        <span className="text-xs text-ink-500">Current version: {initial.version}</span>
      </div>
    </div>
  );
}

function AssumptionsTab({
  ac,
  assumptions,
  update
}: {
  ac: Building['asset_class'];
  assumptions: Assumptions;
  update: <K extends keyof Assumptions>(key: K, value: Assumptions[K]) => void;
}) {
  return (
    <div className="card p-4 space-y-4">
      <div>
        <h3 className="font-semibold">Growth & operations</h3>
        <p className="text-xs text-ink-500">All numbers recompute the proforma and returns live.</p>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <AssumptionField label="Rent Growth %" value={assumptions.rent_growth_pct * 100} onChange={(v) => update('rent_growth_pct', v / 100)} />
        <AssumptionField label="Vacancy %" value={assumptions.vacancy_pct * 100} onChange={(v) => update('vacancy_pct', v / 100)} />
        <AssumptionField label="Expense Growth %" value={assumptions.expense_growth_pct * 100} onChange={(v) => update('expense_growth_pct', v / 100)} />
        <AssumptionField label="Mgmt Fee %" value={assumptions.mgmt_fee_pct * 100} onChange={(v) => update('mgmt_fee_pct', v / 100)} />
        <AssumptionField
          label={ac === 'hospitality' ? 'CapEx / key' : ac === 'multifamily' ? 'CapEx / unit' : 'CapEx reserve'}
          value={assumptions.capex_reserve_per_unit}
          onChange={(v) => update('capex_reserve_per_unit', v)}
          prefix="$"
        />
        {['office', 'retail', 'industrial', 'mixed-use'].includes(ac) ? (
          <AssumptionField
            label="TI / LC per SF"
            value={assumptions.ti_lc_reserve_per_sf ?? 0}
            onChange={(v) => update('ti_lc_reserve_per_sf', v)}
            prefix="$"
          />
        ) : null}
      </div>

      <div>
        <h3 className="font-semibold">Exit & hold</h3>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <AssumptionField label="Exit Cap %" value={assumptions.exit_cap * 100} onChange={(v) => update('exit_cap', v / 100)} />
        <AssumptionField label="Hold Years" value={assumptions.hold_years} onChange={(v) => update('hold_years', Math.round(v))} />
      </div>

      <div>
        <h3 className="font-semibold">Debt</h3>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <AssumptionField label="LTV %" value={assumptions.ltv * 100} onChange={(v) => update('ltv', v / 100)} />
        <AssumptionField label="Rate %" value={assumptions.rate * 100} onChange={(v) => update('rate', v / 100)} />
        <AssumptionField label="Amort Years" value={assumptions.amort_years ?? 30} onChange={(v) => update('amort_years', Math.round(v))} />
      </div>
    </div>
  );
}

function StatementTable({
  ttm,
  proforma,
  readOnly,
  onUpdate,
  onAdd,
  onRemove
}: {
  ttm: Statement;
  proforma: Statement;
  readOnly: boolean;
  onUpdate: (scope: 'revenue' | 'expenses', idx: number, patch: Partial<LineItem>) => void;
  onAdd: (scope: 'revenue' | 'expenses') => void;
  onRemove: (scope: 'revenue' | 'expenses', idx: number) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr>
            <th className="th w-1/2">Line Item</th>
            <th className="th text-right">TTM</th>
            <th className="th text-right">Proforma Y1</th>
            <th className="th w-8"></th>
          </tr>
        </thead>
        <tbody>
          <SectionHeader label="Revenue" onAdd={readOnly ? undefined : () => onAdd('revenue')} />
          {ttm.revenue.map((li, i) => (
            <tr key={`rev-${i}`}>
              <td className="td">
                <input
                  className="field"
                  value={li.label}
                  onChange={(e) => onUpdate('revenue', i, { label: e.target.value })}
                  readOnly={readOnly}
                />
              </td>
              <td className="td">
                <input
                  className="field num"
                  value={li.amount}
                  onChange={(e) => onUpdate('revenue', i, { amount: parseNum(e.target.value) })}
                  readOnly={readOnly}
                />
              </td>
              <td className="td num text-ink-500">{fmtUSD(proforma.revenue[i]?.amount ?? 0)}</td>
              <td className="td">
                {!readOnly ? (
                  <button className="btn-ghost text-xs" onClick={() => onRemove('revenue', i)}>x</button>
                ) : null}
              </td>
            </tr>
          ))}
          <SectionHeader label="Expenses" onAdd={readOnly ? undefined : () => onAdd('expenses')} />
          {ttm.expenses.map((li, i) => (
            <tr key={`exp-${i}`}>
              <td className="td">
                <input
                  className="field"
                  value={li.label}
                  onChange={(e) => onUpdate('expenses', i, { label: e.target.value })}
                  readOnly={readOnly}
                />
              </td>
              <td className="td">
                <input
                  className="field num"
                  value={li.amount}
                  onChange={(e) => onUpdate('expenses', i, { amount: parseNum(e.target.value) })}
                  readOnly={readOnly}
                />
              </td>
              <td className="td num text-ink-500">{fmtUSD(proforma.expenses[i]?.amount ?? 0)}</td>
              <td className="td">
                {!readOnly ? (
                  <button className="btn-ghost text-xs" onClick={() => onRemove('expenses', i)}>x</button>
                ) : null}
              </td>
            </tr>
          ))}
          <tr className="bg-ink-50">
            <td className="td font-semibold">NOI</td>
            <td className="td num font-semibold">{fmtUSD(ttm.noi || computeNoi(ttm))}</td>
            <td className="td num font-semibold">{fmtUSD(proforma.noi || computeNoi(proforma))}</td>
            <td className="td"></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function SectionHeader({ label, onAdd }: { label: string; onAdd?: () => void }) {
  return (
    <tr>
      <td colSpan={4} className="px-2 py-1.5 bg-ink-100 border-b border-ink-200 text-xs font-semibold uppercase tracking-wide text-ink-600 flex items-center justify-between">
        <span>{label}</span>
        {onAdd ? <button className="btn-ghost text-xs py-0.5" onClick={onAdd}>+ add line</button> : null}
      </td>
    </tr>
  );
}

function AssumptionField({
  label,
  value,
  onChange,
  prefix
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  prefix?: string;
}) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className="relative">
        {prefix ? <span className="absolute left-2 top-1 text-ink-500 text-sm">{prefix}</span> : null}
        <input
          className={`field num ${prefix ? 'pl-6' : ''}`}
          value={value}
          onChange={(e) => onChange(parseNum(e.target.value))}
        />
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-ink-200 bg-ink-50 p-3">
      <div className="label">{label}</div>
      <div className="num text-xl font-semibold">{value}</div>
    </div>
  );
}

function RentRollEditor({
  rows,
  onChange
}: {
  rows: NonNullable<Underwriting['rent_roll']>;
  onChange: (r: NonNullable<Underwriting['rent_roll']>) => void;
}) {
  return (
    <div className="card p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="font-semibold">Rent Roll</div>
        <button
          className="btn-ghost text-xs"
          onClick={() => onChange([...rows, { unit: '', unit_type: '', sf: 0, rent: 0, status: 'vacant' }])}
        >
          + add unit
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">Unit</th>
              <th className="th">Type</th>
              <th className="th text-right">SF</th>
              <th className="th text-right">Rent</th>
              <th className="th">Status</th>
              <th className="th">Lease End</th>
              <th className="th"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="td"><input className="field" value={r.unit ?? ''} onChange={(e) => onChange(rows.map((x, j) => j === i ? { ...x, unit: e.target.value } : x))} /></td>
                <td className="td"><input className="field" value={r.unit_type ?? ''} onChange={(e) => onChange(rows.map((x, j) => j === i ? { ...x, unit_type: e.target.value } : x))} /></td>
                <td className="td"><input className="field num" value={r.sf ?? 0} onChange={(e) => onChange(rows.map((x, j) => j === i ? { ...x, sf: parseNum(e.target.value) } : x))} /></td>
                <td className="td"><input className="field num" value={r.rent ?? 0} onChange={(e) => onChange(rows.map((x, j) => j === i ? { ...x, rent: parseNum(e.target.value) } : x))} /></td>
                <td className="td">
                  <select className="field" value={r.status ?? 'vacant'} onChange={(e) => onChange(rows.map((x, j) => j === i ? { ...x, status: e.target.value as NonNullable<typeof r.status> } : x))}>
                    <option value="occupied">occupied</option>
                    <option value="vacant">vacant</option>
                    <option value="model">model</option>
                    <option value="down">down</option>
                  </select>
                </td>
                <td className="td"><input className="field" value={r.lease_end ?? ''} onChange={(e) => onChange(rows.map((x, j) => j === i ? { ...x, lease_end: e.target.value } : x))} /></td>
                <td className="td"><button className="btn-ghost text-xs" onClick={() => onChange(rows.filter((_, j) => j !== i))}>x</button></td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr><td colSpan={7} className="td text-center text-ink-500">No units added.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LeaseRollEditor({
  rows,
  onChange
}: {
  rows: NonNullable<Underwriting['lease_roll']>;
  onChange: (r: NonNullable<Underwriting['lease_roll']>) => void;
}) {
  return (
    <div className="card p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="font-semibold">Lease Roll</div>
        <button
          className="btn-ghost text-xs"
          onClick={() => onChange([...rows, { tenant: '', suite: '', sf: 0, rent_psf: 0, start: '', expiration: '', options: '', recovery: 'NNN' }])}
        >
          + add tenant
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">Tenant</th>
              <th className="th">Suite</th>
              <th className="th text-right">SF</th>
              <th className="th text-right">Rent / SF</th>
              <th className="th">Start</th>
              <th className="th">Expiration</th>
              <th className="th">Options</th>
              <th className="th">Recovery</th>
              <th className="th"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="td"><input className="field" value={r.tenant ?? ''} onChange={(e) => onChange(rows.map((x, j) => j === i ? { ...x, tenant: e.target.value } : x))} /></td>
                <td className="td"><input className="field" value={r.suite ?? ''} onChange={(e) => onChange(rows.map((x, j) => j === i ? { ...x, suite: e.target.value } : x))} /></td>
                <td className="td"><input className="field num" value={r.sf ?? 0} onChange={(e) => onChange(rows.map((x, j) => j === i ? { ...x, sf: parseNum(e.target.value) } : x))} /></td>
                <td className="td"><input className="field num" value={r.rent_psf ?? 0} onChange={(e) => onChange(rows.map((x, j) => j === i ? { ...x, rent_psf: parseNum(e.target.value) } : x))} /></td>
                <td className="td"><input className="field" value={r.start ?? ''} onChange={(e) => onChange(rows.map((x, j) => j === i ? { ...x, start: e.target.value } : x))} /></td>
                <td className="td"><input className="field" value={r.expiration ?? ''} onChange={(e) => onChange(rows.map((x, j) => j === i ? { ...x, expiration: e.target.value } : x))} /></td>
                <td className="td"><input className="field" value={r.options ?? ''} onChange={(e) => onChange(rows.map((x, j) => j === i ? { ...x, options: e.target.value } : x))} /></td>
                <td className="td"><input className="field" value={r.recovery ?? ''} onChange={(e) => onChange(rows.map((x, j) => j === i ? { ...x, recovery: e.target.value } : x))} /></td>
                <td className="td"><button className="btn-ghost text-xs" onClick={() => onChange(rows.filter((_, j) => j !== i))}>x</button></td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr><td colSpan={9} className="td text-center text-ink-500">No tenants added.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MonthlyGrid({
  title,
  tag,
  data,
}: {
  title: string;
  tag?: string;
  data: MonthlyStatement;
}) {
  const months = (data.months || []).slice(0, 12);
  while (months.length < 12) months.push('');
  const revTotals = months.map((_, i) =>
    (data.revenue || []).reduce((s, li) => s + (li.amounts?.[i] ?? 0), 0)
  );
  const expTotals = months.map((_, i) =>
    (data.expenses || []).reduce((s, li) => s + (li.amounts?.[i] ?? 0), 0)
  );
  const noiSeries = monthlyNoiSeries(data);
  const revAnnual = revTotals.reduce((a, b) => a + b, 0);
  const expAnnual = expTotals.reduce((a, b) => a + b, 0);
  const noiAnnual = noiSeries.reduce((a, b) => a + b, 0);

  return (
    <div className="card p-3 overflow-x-auto">
      <div className="flex items-center justify-between mb-2">
        <div className="font-semibold">{title}</div>
        {tag ? <span className="pill text-xs">{tag}</span> : null}
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr>
            <th className="th text-left sticky left-0 bg-white z-10 min-w-[160px]">Line item</th>
            {months.map((m, i) => (
              <th key={i} className="th text-right whitespace-nowrap">{formatMonthLabel(m)}</th>
            ))}
            <th className="th text-right whitespace-nowrap">Annual</th>
          </tr>
        </thead>
        <tbody>
          <tr className="bg-ink-50">
            <td colSpan={14} className="td text-[11px] uppercase tracking-wide font-semibold text-ink-600">Revenue</td>
          </tr>
          {(data.revenue || []).map((li, idx) => (
            <tr key={`r-${idx}`}>
              <td className="td sticky left-0 bg-white z-10">{li.label}</td>
              {months.map((_, i) => (
                <td key={i} className="td num">{fmtUSD(li.amounts?.[i] ?? 0)}</td>
              ))}
              <td className="td num font-medium">{fmtUSD(sumLine(li.amounts))}</td>
            </tr>
          ))}
          <tr className="bg-ink-50">
            <td className="td font-semibold sticky left-0 bg-ink-50 z-10">Total revenue</td>
            {revTotals.map((v, i) => (
              <td key={i} className="td num font-semibold">{fmtUSD(v)}</td>
            ))}
            <td className="td num font-semibold">{fmtUSD(revAnnual)}</td>
          </tr>

          <tr className="bg-ink-50">
            <td colSpan={14} className="td text-[11px] uppercase tracking-wide font-semibold text-ink-600">Expenses</td>
          </tr>
          {(data.expenses || []).map((li, idx) => (
            <tr key={`e-${idx}`}>
              <td className="td sticky left-0 bg-white z-10">{li.label}</td>
              {months.map((_, i) => (
                <td key={i} className="td num">{fmtUSD(li.amounts?.[i] ?? 0)}</td>
              ))}
              <td className="td num font-medium">{fmtUSD(sumLine(li.amounts))}</td>
            </tr>
          ))}
          <tr className="bg-ink-50">
            <td className="td font-semibold sticky left-0 bg-ink-50 z-10">Total expenses</td>
            {expTotals.map((v, i) => (
              <td key={i} className="td num font-semibold">{fmtUSD(v)}</td>
            ))}
            <td className="td num font-semibold">{fmtUSD(expAnnual)}</td>
          </tr>

          <tr className="bg-accent-50">
            <td className="td font-bold sticky left-0 bg-accent-50 z-10">NOI</td>
            {noiSeries.map((v, i) => (
              <td key={i} className="td num font-bold">{fmtUSD(v)}</td>
            ))}
            <td className="td num font-bold">{fmtUSD(noiAnnual)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function MonthlyTables({
  ttm,
  proforma,
}: {
  ttm: MonthlyStatement | null;
  proforma: MonthlyStatement | null;
}) {
  if (!ttm && !proforma) {
    return (
      <div className="card p-4 text-sm text-ink-500">
        The OM did not include a month-by-month P&amp;L, so we can't show a 12-month view here.
        Upload a T12 or monthly operating statement and the system will populate this tab automatically.
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {ttm ? (
        <MonthlyGrid
          title="TTM monthly (from OM)"
          tag={ttm.source === 'om' ? 'OM source' : 'Derived'}
          data={ttm}
        />
      ) : null}
      {proforma ? (
        <MonthlyGrid
          title="12-Month Proforma"
          tag={proforma.source === 'om' ? 'OM source' : 'Derived from TTM + growth'}
          data={proforma}
        />
      ) : null}
    </div>
  );
}
