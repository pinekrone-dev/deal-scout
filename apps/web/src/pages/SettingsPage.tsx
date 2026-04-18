import { useEffect, useState } from 'react';
import { apiFetch, apiJson } from '../lib/api';
import { useAuth } from '../lib/auth';

type SettingsStatus = {
  email: string;
  has_user_key: boolean;
  has_fallback_key: boolean;
  model: string;
};

export default function SettingsPage() {
  const { user } = useAuth();
  const [status, setStatus] = useState<SettingsStatus | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [migrating, setMigrating] = useState(false);
  const [migrateResult, setMigrateResult] = useState<string | null>(null);

  async function reload() {
    try {
      const s = await apiJson<SettingsStatus>('/api/settings');
      setStatus(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    if (!user) return;
    reload();
  }, [user]);

  async function save() {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const res = await apiFetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gemini_api_key: apiKey })
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      setApiKey('');
      setMessage('Saved.');
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function clearKey() {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const res = await apiFetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gemini_api_key: '' })
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      setMessage('Key cleared.');
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function claimLegacy() {
    setMigrating(true);
    setMigrateResult(null);
    setError(null);
    try {
      const res = await apiFetch('/api/admin/migrate', { method: 'POST' });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      const data = await res.json();
      setMigrateResult(JSON.stringify(data));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMigrating(false);
    }
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-sm text-ink-500">Signed in as {status?.email ?? user?.email}</p>
      </div>

      <div className="card p-5 space-y-4">
        <div>
          <h2 className="font-semibold">Gemini API key</h2>
          <p className="text-sm text-ink-500">
            Used to extract data from Offering Memoranda. Get a key at{' '}
            <a
              className="text-accent-600 hover:underline"
              href="https://aistudio.google.com/apikey"
              target="_blank"
              rel="noreferrer"
            >
              aistudio.google.com/apikey
            </a>.
          </p>
        </div>
        <div className="text-sm">
          Status:{' '}
          {status?.has_user_key ? (
            <span className="text-green-700 font-medium">Your key is saved.</span>
          ) : status?.has_fallback_key ? (
            <span className="text-ink-700">Using a shared fallback key.</span>
          ) : (
            <span className="text-red-600 font-medium">No key set. OM upload will fail.</span>
          )}
          {status?.model ? <span className="text-ink-500"> &nbsp;/&nbsp; Model: {status.model}</span> : null}
        </div>
        <div>
          <label className="label">Paste your Gemini API key</label>
          <input
            type="password"
            className="field"
            placeholder="AI..."
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-primary" onClick={save} disabled={saving || !apiKey}>
            {saving ? 'Saving...' : 'Save key'}
          </button>
          {status?.has_user_key ? (
            <button className="btn" onClick={clearKey} disabled={saving}>
              Clear my key
            </button>
          ) : null}
        </div>
        {message ? <div className="text-sm text-green-700">{message}</div> : null}
      </div>

      <div className="card p-5 space-y-3">
        <div>
          <h2 className="font-semibold">Claim legacy data</h2>
          <p className="text-sm text-ink-500">
            If you had buildings, contacts, or deals created before multi-tenant mode, press this once to
            stamp them with your account so you can see them.
          </p>
        </div>
        <div>
          <button className="btn" onClick={claimLegacy} disabled={migrating}>
            {migrating ? 'Migrating...' : 'Claim my legacy data'}
          </button>
        </div>
        {migrateResult ? (
          <div className="text-xs text-ink-600 whitespace-pre-wrap break-all">
            Result: {migrateResult}
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="card p-4 text-sm text-red-600 whitespace-pre-wrap">{error}</div>
      ) : null}
    </div>
  );
}
