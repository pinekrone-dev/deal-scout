import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, doc, onSnapshot, query, updateDoc, where } from 'firebase/firestore';
import { MapContainer, Marker, Popup, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { db } from '../lib/firebase';
import { useAuth } from '../lib/auth';
import { useWorkspace } from '../lib/workspace';
import type { Building } from '../types';
import { fmtUSD } from '../lib/format';

// Fix the default icon paths for Vite bundling.
delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

type Row = Building & { id: string };

function addrString(b: Building): string {
  return [b.address, b.city, b.state, b.zip].filter(Boolean).join(', ');
}

async function geocode(q: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const arr = (await res.json()) as Array<{ lat: string; lon: string }>;
    if (!arr.length) return null;
    const lat = Number.parseFloat(arr[0].lat);
    const lng = Number.parseFloat(arr[0].lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  } catch {
    return null;
  }
}

function FitBounds({ points }: { points: Array<[number, number]> }) {
  const map = useMap();
  useEffect(() => {
    if (points.length === 0) return;
    if (points.length === 1) {
      map.setView(points[0], 10);
      return;
    }
    const bounds = L.latLngBounds(points.map(([a, b]) => L.latLng(a, b)));
    map.fitBounds(bounds, { padding: [40, 40] });
  }, [points, map]);
  return null;
}

export default function DashboardPage() {
  const { user } = useAuth();
  const { workspaces, current, currentOwnerUid, select, loading: wsLoading } = useWorkspace();
  const [rows, setRows] = useState<Row[]>([]);
  const geocodingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!user || !currentOwnerUid) return;
    setRows([]); // clear when switching workspaces
    const q = query(collection(db, 'buildings'), where('owner_uid', '==', currentOwnerUid));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const out: Row[] = [];
        snap.forEach((d) => out.push({ id: d.id, ...(d.data() as Building) }));
        setRows(out);
      },
      (err) => {
        // eslint-disable-next-line no-console
        console.error('dashboard buildings query failed', err);
      }
    );
    return () => unsub();
  }, [user, currentOwnerUid]);

  // Lazy geocode any building that has an address but no lat/lng.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const b of rows) {
        if (cancelled) return;
        const hasCoords = typeof b.lat === 'number' && typeof b.lng === 'number';
        if (hasCoords) continue;
        const addr = addrString(b);
        if (!addr) continue;
        if (geocodingRef.current.has(b.id)) continue;
        geocodingRef.current.add(b.id);
        // Be polite to Nominatim: one request per second.
        const coords = await geocode(addr);
        if (cancelled) return;
        if (!coords) continue;
        try {
          await updateDoc(doc(db, 'buildings', b.id), { lat: coords.lat, lng: coords.lng });
        } catch {
          // ignore write errors here; snapshot will simply not update this one
        }
        await new Promise((r) => setTimeout(r, 1100));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rows]);

  const points = useMemo<Array<[number, number]>>(
    () =>
      rows
        .filter((r) => typeof r.lat === 'number' && typeof r.lng === 'number')
        .map((r) => [r.lat as number, r.lng as number]),
    [rows]
  );

  const plotted = rows.filter((r) => typeof r.lat === 'number' && typeof r.lng === 'number');
  const missingCoords = rows.length - plotted.length;

  const defaultCenter: [number, number] = [33.98, -118.45]; // West LA-ish
  const center: [number, number] = points[0] ?? defaultCenter;

  const showSwitcher = workspaces.length > 1;

  return (
    <div className="space-y-4">
      {showSwitcher ? (
        <div className="card p-2 flex flex-wrap items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-ink-500 px-2">Workspace:</span>
          {workspaces.map((w) => (
            <button
              key={w.owner_uid}
              className={`px-3 py-1.5 rounded text-sm font-medium border ${
                w.owner_uid === currentOwnerUid
                  ? 'bg-accent-600 text-white border-accent-600'
                  : 'bg-white text-ink-700 border-ink-200 hover:bg-ink-50'
              }`}
              onClick={() => select(w.owner_uid)}
            >
              {w.label}
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Dashboard</h1>
          <p className="text-sm text-ink-500">
            {wsLoading ? (
              'Loading workspace...'
            ) : (
              <>
                {rows.length} building{rows.length === 1 ? '' : 's'} / {plotted.length} on map
                {missingCoords > 0 ? <span className="text-ink-400"> &nbsp;({missingCoords} geocoding...)</span> : null}
                {current && current.role !== 'owner' ? (
                  <span className="ml-2 pill">Shared: {current.owner_email}</span>
                ) : null}
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/buildings" className="btn">Buildings</Link>
          <Link to="/deals" className="btn">Deals</Link>
        </div>
      </div>

      <div className="card overflow-hidden" style={{ height: 560 }}>
        <MapContainer
          center={center}
          zoom={10}
          style={{ height: '100%', width: '100%' }}
          scrollWheelZoom
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <FitBounds points={points} />
          {plotted.map((b) => (
            <Marker key={b.id} position={[b.lat as number, b.lng as number]}>
              <Popup>
                <div className="text-sm">
                  <div className="font-medium">
                    <Link to={`/buildings/${b.id}`}>{b.address || '(untitled)'}</Link>
                  </div>
                  <div className="text-ink-500">
                    {[b.city, b.state].filter(Boolean).join(', ')}
                  </div>
                  <div className="mt-1">
                    {b.asset_class}
                    {b.asking_price ? ` / ${fmtUSD(b.asking_price)}` : ''}
                  </div>
                </div>
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      </div>

      {rows.length === 0 && !wsLoading ? (
        <div className="card p-6 text-center text-sm text-ink-500">
          No buildings yet. Upload an OM on the Buildings tab or create one manually.
        </div>
      ) : null}
    </div>
  );
}
