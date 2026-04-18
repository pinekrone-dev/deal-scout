import { useEffect, useState } from 'react';
import { apiFetch, apiJson } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useWorkspace } from '../lib/workspace';

type SettingsStatus = {
  email: string;
  has_user_key: boolean;
  has_fallback_key: boolean;
  model: string;
  uid: string;
  workspace_owner_uid: string;
  is_workspace_owner: boolean;
};

type Member = { uid: string; email: string; role: string; invited_at: unknown };
type Invite = { token: string; email: string; created_at: unknown };
type MembersResp = { members: Member[]; invites: Invite[] };
type CreateInviteResp = { token: string; accept_url: string; emailed: boolean };

export default function SettingsPage() {
  const { user } = useAuth();
  const { refresh: refreshWorkspaces } = useWorkspace();
  const [status, setStatus] = useState<SettingsStatus | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [migrating, setMigrating] = useState(false);
  const [migrateResult, setMigrateResult] = useState<string | null>(null);

  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [invitingLoad, setInvitingLoad] = useState(false);
  const [justCreatedInvite, setJustCreatedInvite] = useState<CreateInviteResp | null>(null);

  async function reload() {
    try {
      const s = await apiJson<SettingsStatus>('/api/settings');
      setStatus(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function reloadMembers() {
    try {
      const m = await apiJson<MembersResp>('/api/workspace/members');
      setMembers(m.members || []);
      setInvites(m.invites || []);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('members load failed', e);
    }
  }

  useEffect(() => {
    if (!user) return;
    reload();
    reloadMembers();
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

  async function sendInvite() {
    const email = inviteEmail.trim().toLowerCase();
    if (!email || !email.includes('@')) {
      setError('Enter a valid email address.');
      return;
    }
    setInvitingLoad(true);
    setJustCreatedInvite(null);
    setError(null);
    try {
      const origin = window.location.origin;
      const resp = await apiJson<CreateInviteResp>('/api/workspace/invites', {
        method: 'POST',
        body: JSON.stringify({ email, origin })
      });
      setJustCreatedInvite(resp);
      setInviteEmail('');
      await reloadMembers();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setInvitingLoad(false);
    }
  }

  async function removeMember(uid: string) {
    if (!window.confirm('Remove this member from your workspace?')) return;
    try {
      const res = await apiFetch(`/api/workspace/members/${uid}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      await reloadMembers();
      await refreshWorkspaces();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function revokeInvite(token: string) {
    try {
      const res = await apiFetch(`/api/workspace/invites/${token}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      await reloadMembers();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function leaveWorkspace() {
    if (!window.confirm('Leave this shared workspace? You will still have your own.')) return;
    try {
      const res = await apiFetch('/api/workspace/leave', { method: 'POST' });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      await refreshWorkspaces();
      setMessage('Left workspace.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function copy(text: string) {
    try {
      navigator.clipboard.writeText(text);
      setMessage('Copied to clipboard.');
    } catch {
      setMessage(null);
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

      <div className="card p-5 space-y-4">
        <div>
          <h2 className="font-semibold">Workspace members</h2>
          <p className="text-sm text-ink-500">
            Invite an editor by email. They'll be able to view and edit everything in your workspace.
          </p>
        </div>

        <div className="space-y-2">
          {members.map((m) => (
            <div key={m.uid} className="flex items-center justify-between py-2 border-b border-ink-100 last:border-0">
              <div>
                <div className="text-sm font-medium">{m.email || m.uid}</div>
                <div className="text-xs text-ink-500 capitalize">{m.role}</div>
              </div>
              {m.role !== 'owner' ? (
                <button className="btn-ghost text-xs text-red-600" onClick={() => removeMember(m.uid)}>
                  Remove
                </button>
              ) : (
                <span className="pill">you</span>
              )}
            </div>
          ))}
        </div>

        {invites.length > 0 ? (
          <div>
            <div className="label">Pending invites</div>
            <div className="space-y-2">
              {invites.map((iv) => (
                <div key={iv.token} className="flex items-center justify-between py-2 border-b border-ink-100 last:border-0">
                  <div>
                    <div className="text-sm">{iv.email}</div>
                    <div className="text-xs text-ink-500 break-all">
                      {window.location.origin}/invite/{iv.token}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      className="btn text-xs"
                      onClick={() => copy(`${window.location.origin}/invite/${iv.token}`)}
                    >
                      Copy link
                    </button>
                    <button className="btn-ghost text-xs text-red-600" onClick={() => revokeInvite(iv.token)}>
                      Revoke
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="flex items-center gap-2 pt-2">
          <input
            className="field flex-1"
            placeholder="person@example.com"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            type="email"
          />
          <button className="btn-primary" onClick={sendInvite} disabled={invitingLoad || !inviteEmail}>
            {invitingLoad ? 'Creating...' : 'Invite'}
          </button>
        </div>

        {justCreatedInvite ? (
          <div className="rounded border border-green-300 bg-green-50 p-3 text-sm space-y-2">
            <div className="font-medium text-green-800">Invite created</div>
            {justCreatedInvite.emailed ? (
              <div className="text-green-700">Email sent.</div>
            ) : (
              <div className="text-green-800">
                Share this link with them:
                <div className="mt-1 break-all text-ink-700 bg-white border border-ink-200 rounded px-2 py-1">
                  {justCreatedInvite.accept_url}
                </div>
                <button
                  className="btn text-xs mt-2"
                  onClick={() => copy(justCreatedInvite.accept_url)}
                >
                  Copy link
                </button>
              </div>
            )}
          </div>
        ) : null}

        {status && !status.is_workspace_owner ? (
          <div className="pt-4 border-t border-ink-200">
            <div className="text-sm text-ink-700 mb-2">
              You're a member of another user's workspace.
            </div>
            <button className="btn text-xs text-red-600" onClick={leaveWorkspace}>
              Leave this workspace
            </button>
          </div>
        ) : null}
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
