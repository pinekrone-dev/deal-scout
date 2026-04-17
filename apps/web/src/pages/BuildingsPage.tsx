import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { addDoc, collection, onSnapshot, orderBy, query, Timestamp } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { uploadOM } from '../lib/api';
import type { Building, AssetClass } from '../types';
import { ASSET_CLASSES } from '../types';
import { fmtNum, fmtPct, fmtUSD } from '../lib/format';

type Row = Building & { id: string };

export default function BuildingsPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [filter, setFilter] = useState('');
  const [assetFilter, setAssetFilter] = useState<AssetClass | ''>('');
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const nav = useNavigate();

  useEffect(() => {
    const q = query(collection(db, 'buildings'), orderBy('updated_at', 'desc'));
    const unsub = onSnapshot(q, (snap) => {
      const out: Row[] = [];
      snap.forEach((d) => out.push({ id: d.id, ...(d.data() as Building) }));
      setRows(out);
    });
    return () => unsub();
  }, []);

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
    const now = Date.now();
    const payload: Building = {
      address: 'New Building',
      asset_class: 'multifamily',
      created_at: now,
      updated_at: now
    };
    const ref = await addDoc(collection(db, 'buildings'), {
      ...payload,
      created_at: Timestamp.fromMillis(now),
      updated_at: Timestamp.fromMillis(now)
    });
    nav(`/buildings/${ref.id}`);
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const { ingestion_id } = await uploadOM(Array.from(files));
      nav(`/ingest/${ingestion_id}`);
    } catch (e) {
      alert(`Upload failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Buildings</h1>
          <p className="text-sm text-ink-500">{rows.length} total</p>
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
              </tr>
            ))}
            {filtered.length === 0 ? (
              <tr><td colSpan={7} className="td text-center text-ink-500 py-8">No buildings yet.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
