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
  const { currentOwnerUid, current } = useWorkspace();
  const [rows, setRows] = useState<Row[]>([]);
  const [filter, setFilter] = useState('');
  const [assetFilter, setAssetFilter] = useState<AssetClass | ''>('');
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
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

  async function createBlank() {
    if (!user || !currentOwnerUid) return;
    const now = Date.now();
    const payload: Building = {
      address: 'New Building',
      asset_class: 'multifamily',
      created_at: now,
      updated_at: now
    };
    const ref = await addDoc(collection(db, 'buildings'), {
      ...payload,
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

  async function removeBuilding(id: string, address: string) {
    if (!window.confirm(`Delete "${address || 'this building'}" and all of its underwriting, deals, and OM files? This cannot be undone.`)) {
      return;
    }
    setDeleting(id);
    try {
      // Prefer API endpoint for proper cascade. Fall back to Firestore delete if API fails.
      const res = await apiFetch(`/api/buildings/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const text = await res.text();
        if (res.status === 404 || res.status === 405) {
          // API doesn't have the endpoint yet — fall back to direct delete.
          await deleteDoc(doc(db, 'buildings', id));
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
          <button
            className="btn"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? 'Uploading...' : 'Upload OM'}
          </button>
          <button className="btn-primary" onClick={createBlank}>New Building</button>
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
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">Address</th>
              <th className="th">Asset</th>
              <th className="th text-right">Units / SF</th>
              <th className="th text-right">NOI</th>
              <th className="th text-right">Asking</th>
              <th className="th text-right">Cap</th>
              <th className="th text-right">Occ</th>
              <th className="th"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id} className="hover:bg-ink-50">
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
                <td className="td text-right">
                  <button
                    className="btn-ghost text-xs text-red-600"
                    onClick={() => removeBuilding(r.id, r.address || '')}
                    disabled={deleting === r.id}
                    title="Delete building"
                  >
                    {deleting === r.id ? '...' : 'Delete'}
                  </button>
                </td>
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
