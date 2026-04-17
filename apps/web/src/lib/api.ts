import { auth, apiBase } from './firebase';

async function authHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const u = auth.currentUser;
  const token = u ? await u.getIdToken() : null;
  return {
    ...extra,
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = await authHeaders((init.headers as Record<string, string>) ?? {});
  const url = apiBase ? `${apiBase.replace(/\/$/, '')}${path}` : path;
  return fetch(url, { ...init, headers });
}

export async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers as Record<string, string> ?? {}) }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

export async function uploadOM(files: File[]): Promise<{ ingestion_id: string }> {
  const form = new FormData();
  for (const f of files) form.append('files', f, f.name);
  const headers = await authHeaders();
  const url = apiBase ? `${apiBase.replace(/\/$/, '')}/api/ingest` : '/api/ingest';
  const res = await fetch(url, { method: 'POST', body: form, headers });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return await res.json();
}

export type IngestionStatus = {
  id: string;
  extraction_status: 'pending' | 'running' | 'done' | 'error';
  raw_extraction: Record<string, unknown> | null;
  error: string | null;
};

export async function getIngestion(id: string): Promise<IngestionStatus> {
  return apiJson<IngestionStatus>(`/api/ingest/${id}`);
}

export async function confirmIngestion(id: string, payload: Record<string, unknown>): Promise<{
  building_id: string;
  contact_ids: string[];
  underwriting_id: string;
}> {
  return apiJson(`/api/ingest/${id}/confirm`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export async function recalcUnderwriting(buildingId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return apiJson(`/api/underwriting/${buildingId}/calc`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}
