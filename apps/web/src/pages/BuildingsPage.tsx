import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { addDoc, collection, deleteDoc, doc, onSnapshot, query, Timestamp, where } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { apiFetch, uploadOM } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useWorkspace } from '../lib/workspace';
import type { Building, AssetClass } from '../types';
import { ASSET_CLASSES } from '../types';
import { fmtNum, fmtPct, fmtUSD } from '../lib/format';

type Row = Building & { id: string };

export default function BuildingsPage() {
  const { user } = useAuth();
  const { currentOwnerUid, current, can } = useWorkspace();
  const [rows, setRows] = useState<Row[]>([]);
  const [filter, setFilter] = useState('');
  const [assetFilter, setAssetFilter] = useState<AssetClass | ''>('');
  const [uploading, setUploading] = useState(false);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [bulkBusy, setBulkBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const nav = useNavigate();

  useEffect(() => {
    if (!user || !currentOwnerUid) return;
    const q = query(collection(db, 'buildings'), where('owner_uid', '==', currentOwnerUid));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const out: Row[] = [];
        snap.forEach((d) => out.push({ id: d.id, ...(d.data() as Building) }));
        out.sort((a, b) => {
          const au = a.updated_at ? (typeof a.updated_at === 'number' ? a.updated_at : (a.updated_at as any).toMillis?.() ?? 0) : 0;
          const bu = b.updated_at ? (typeof b.updated_at === 'number' ? b.updated_at : (b.updated_at as any).toMillis?.() ?? 0) : 0;
          return bu - au;
        });
        setRows(out);
        // Prune selections for rows that disappeared.
        setSelected((prev) => {
          const next: Record<string, boolean> = {};
          for (const r of out) if (prev[r.id]) next[r.id] = true;
          return next;
        });
      },
      (err) => {
        // eslint-disable-next-line no-console
        console.error('buildings query failed', err);
      }
    );
    return () => unsub();
  }, [user, currentOwnerUid]);

  const filtered = useMemo(() => {
    const f = filter.toLowerCase();
    return rows.filter((r) => {
      if (assetFilter && r.asset_class !== assetFilter) return false;
      if (!f) return true;
      return (
        r.address?.toLowerCase().includes(f) ||
        r.city?.toLowerCase().includes(f) ||
        r.state?.toLowerCase().includes(f) ||
        (r.notes ?? '').toLowerCase().includes(f)
      );
    });
  }, [rows, filter, assetFilter]);

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
    const ref = await addDoc(collection(db, 'buildings'), {
      address: 'New Building',
      asset_class: 'multifamily',
      owner_uid: currentOwnerUid,
      created_at: Timestamp.fromMillis(now),
      updated_at: Timestamp.fromMillis(now)
    });
    nav(`/buildings/${ref.id}`);
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const { ingestion_id } = await uploadOM(Array.from(files), currentOwnerUid ?? undefined);
      nav(`/ingest/${ingestion_id}`);
    } catch (e) {
      alert(`Upload failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function bulkDelete() {
    if (selCount === 0) return;
    const msg =
      selCount === 1
        ? 'Delete 1 selected building and all linked underwriting, deals, and OM files? This cannot be undone.'
        : `Delete ${selCount} selected buildings and all linked underwriting, deals, and OM files? This cannot be undone.`;
    if (!window.confirm(msg)) return;
    setBulkBusy(true);
    const ids = [...selectedIds];
    try {
      // Server-side cascade (fast path).
      const res = await apiFetch(
        '/api/buildings/bulk-delete',
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
      // Network-level failure (Safari "Load failed", CORS, cold start).
      // Fall back to direct Firestore deletes so the user isn't stuck.
      // eslint-disable-next-line no-console
      console.warn('bulk-delete API failed, falling back to client-side', e);
      try {
        await Promise.allSettled(ids.map((id) => deleteDoc(doc(db, 'buildings', id))));
        setSelected({});
        alert(
          `Server cleanup failed (${e instanceof Error ? e.message : String(e)}). Deleted ${ids.length} building docs directly; linked underwriting/OM docs were not cascaded. Ask to rerun server cleanup if needed.`
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
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Buildings</h1>
          <p className="text-sm text-ink-500">
            {rows.length} total
            {current && current.role !== 'owner' ? (
              <span className="ml-2 pill">Shared: {current.owner_email}</span>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            multiple
            accept="application/pdf,image/*"
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
          {can('create') ? (
            <>
              <button
                className="btn"
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
              >
                {uploading ? 'Uploading...' : 'Upload OM'}
              </button>
              <button className="btn-primary" onClick={createBlank}>New Building</button>
            </>
          ) : null}
        </div>
      </div>

      <div className="card p-3 flex flex-wrap items-center gap-3">
        <input
          className="field max-w-xs"
          placeholder="Search address, city, notes..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <select
          className="field max-w-xs"
          value={assetFilter}
          onChange={(e) => setAssetFilter(e.target.value as AssetClass | '')}
        >
          <option value="">All asset classes</option>
          {ASSET_CLASSES.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <div className="flex-1" />
        {selCount > 0 && can('delete') ? (
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
              <th className="th">Address</th>
              <th className="th">Asset</th>
              <th className="th text-right">Units / SF</th>
              <th className="th text-right">NOI</th>
              <th className="th text-right">Asking</th>
              <th className="th text-right">Cap</th>
              <th className="th text-right">Occ</th>
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
                    aria-label={`Select ${r.address}`}
                  />
                </td>
                <td className="td">
                  <Link to={`/buildings/${r.id}`} className="text-accent-600 hover:underline">
                    {r.address || '(untitled)'}
                  </Link>
                  <div className="text-xs text-ink-500">
                    {[r.city, r.state].filter(Boolean).join(', ')}
                  </div>
                </td>
                <td className="td"><span className="pill">{r.asset_class}</span></td>
                <td className="td num">
                  {r.units ? `${fmtNum(r.units)} u` : ''}
                  {r.sf ? ` / ${fmtNum(r.sf)} sf` : ''}
                </td>
                <td className="td num">{fmtUSD(r.current_noi ?? null)}</td>
                <td className="td num">{fmtUSD(r.asking_price ?? null)}</td>
                <td className="td num">{fmtPct(r.cap_rate ?? null)}</td>
                <td className="td num">{fmtPct(r.occupancy ?? null, 1)}</td>
              </tr>
            ))}
            {filtered.length === 0 ? (
              <tr><td colSpan={8} className="td text-center text-ink-500 py-8">No buildings yet.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
