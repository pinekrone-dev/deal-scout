import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  Timestamp,
  updateDoc,
  where
} from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../lib/auth';
import type { Building, Deal, DealStatus } from '../types';
import { DEAL_STATUSES } from '../types';
import { fmtUSD } from '../lib/format';

type DealRow = Deal & { id: string };

export default function DealsPage() {
  const { user } = useAuth();
  const [deals, setDeals] = useState<DealRow[]>([]);
  const [buildings, setBuildings] = useState<Record<string, Building>>({});

  useEffect(() => {
    if (!user) return;
    const q = query(
      collection(db, 'deals'),
      where('owner_uid', '==', user.uid),
      orderBy('updated_at', 'desc')
    );
    const unsub = onSnapshot(q, (snap) => {
      const out: DealRow[] = [];
      snap.forEach((d) => out.push({ id: d.id, ...(d.data() as Deal) }));
      setDeals(out);
    });
    return () => unsub();
  }, [user]);

  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, 'buildings'), where('owner_uid', '==', user.uid));
    const unsub = onSnapshot(q, (snap) => {
      const map: Record<string, Building> = {};
      snap.forEach((d) => (map[d.id] = d.data() as Building));
      setBuildings(map);
    });
    return () => unsub();
  }, [user]);

  const byStatus = useMemo(() => {
    const out: Record<DealStatus, DealRow[]> = {
      sourcing: [], underwriting: [], loi: [], diligence: [], won: [], lost: []
    };
    for (const d of deals) {
      (out[d.status] ??= []).push(d);
    }
    return out;
  }, [deals]);

  async function addDeal(status: DealStatus) {
    if (!user) return;
    const now = Date.now();
    await addDoc(collection(db, 'deals'), {
      building_id: '',
      contact_ids: [],
      status,
      owner_uid: user.uid,
      created_at: Timestamp.fromMillis(now),
      updated_at: Timestamp.fromMillis(now)
    });
  }

  async function move(id: string, next: DealStatus) {
    await updateDoc(doc(db, 'deals', id), { status: next, updated_at: Timestamp.fromMillis(Date.now()) });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Deals</h1>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        {DEAL_STATUSES.map((s) => (
          <div key={s} className="card p-3 min-h-[300px] flex flex-col">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-semibold capitalize">{s}</div>
              <button className="btn-ghost text-xs" onClick={() => addDeal(s)}>+</button>
            </div>
            <div className="flex-1 space-y-2">
              {(byStatus[s] ?? []).map((d) => {
                const b = buildings[d.building_id];
                return (
                  <div key={d.id} className="rounded border border-ink-200 bg-ink-50 p-2 text-sm">
                    <div className="font-medium truncate">
                      {b ? (
                        <Link to={`/buildings/${d.building_id}`} className="text-accent-600 hover:underline">
                          {b.address}
                        </Link>
                      ) : (
                        <span className="text-ink-500">Unlinked</span>
                      )}
                    </div>
                    {b ? <div className="text-xs text-ink-500">{b.asset_class} / {fmtUSD(b.asking_price ?? null)}</div> : null}
                    <div className="mt-1 flex items-center gap-1 flex-wrap">
                      {DEAL_STATUSES.filter((x) => x !== s).map((x) => (
                        <button key={x} className="pill hover:bg-white" onClick={() => move(d.id, x)}>
                          {x}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
