import { useEffect, useState } from 'react';
import { apiFetch, apiJson } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useWorkspace, type Permissions } from '../lib/workspace';

type SettingsStatus = {
  email: string;
  has_user_key: boolean;
  has_fallback_key: boolean;
  model: string;
  uid: string;
  workspace_owner_uid: string;
  is_workspace_owner: boolean;
};

type Member = { uid: string; email: string; role: string; permissions: Permissions; invited_at: unknown };
type Invite = { token: string; email: string; permissions: Permissions; created_at: unknown };
type MembersResp = { members: Member[]; invites: Invite[]; presets: Record<string, Permissions> };
type CreateInviteResp = { token: string; accept_url: string; emailed: boolean; auto_provisioned?: boolean };

const PERM_LABELS: { key: keyof Permissions; label: string; hint: string }[] = [
  { key: 'view',          label: 'View',             hint: 'See buildings, contacts, underwriting.' },
  { key: 'create',        label: 'Add records',      hint: 'Create buildings and contacts.' },
  { key: 'edit',          label: 'Edit records',     hint: 'Modify building and contact fields.' },
  { key: 'delete',        label: 'Delete records',   hint: 'Remove buildings and contacts (with cascade).' },
  { key: 'underwrite',    label: 'Run underwriting', hint: 'Create and modify underwriting models.' },
  { key: 'invite_others', label: 'Invite others',    hint: 'Add other users to the workspace.' },
];

const DEFAULT_INVITE_PERMS: Permissions = {
  view: true, create: true, edit: true, delete: false, underwrite: true, invite_others: false,
};

const PRESETS: { id: string; label: string; perms: Permissions }[] = [
  { id: 'viewer',   label: 'Viewer',   perms: { view: true, create: false, edit: false, delete: false, underwrite: false, invite_others: false } },
  { id: 'analyst',  label: 'Analyst',  perms: { view: true, create: false, edit: false, delete: false, underwrite: true,  invite_others: false } },
  { id: 'editor',   label: 'Editor',   perms: DEFAULT_INVITE_PERMS },
  { id: 'manager',  label: 'Manager',  perms: { view: true, create: true,  edit: true,  delete: true,  underwrite: true,  invite_others: false } },
  { id: 'admin',    label: 'Admin',    perms: { view: true, create: true,  edit: true,  delete: true,  underwrite: true,  invite_others: true  } },
];

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
  const [invitePerms, setInvitePerms] = useState<Permissions>(DEFAULT_INVITE_PERMS);
  const [invitingLoad, setInvitingLoad] = useState(false);
  const [justCreatedInvite, setJustCreatedInvite] = useState<CreateInviteResp | null>(null);
  const [diagnose, setDiagnose] = useState<unknown>(null);
  const [editingMember, setEditingMember] = useState<string | null>(null);
  const [editPerms, setEditPerms] = useState<Permissions>(DEFAULT_INVITE_PERMS);

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
        body: JSON.stringify({ email, origin, permissions: invitePerms })
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

  async function savePermissions(uid: string) {
    setError(null);
    try {
      await apiJson(`/api/workspace/members/${uid}`, {
        method: 'PATCH',
        body: JSON.stringify({ permissions: editPerms }),
      });
      setMessage('Permissions updated.');
      setEditingMember(null);
      await reloadMembers();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function applyPreset(target: 'invite' | 'edit', preset: Permissions) {
    if (target === 'invite') setInvitePerms(preset);
    else setEditPerms(preset);
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

  async function reprovisionInvite(token: string) {
    setError(null);
    try {
      const resp = await apiJson<{ ok: boolean; reason?: string; email?: string }>(
        `/api/workspace/invites/${token}/reprovision`,
        { method: 'POST' }
      );
      if (!resp.ok) {
        setError(
          resp.reason === 'no_firebase_account'
            ? `${resp.email} hasn't signed up yet. Ask them to sign in once, then click Reprovision again.`
            : `Could not reprovision: ${JSON.stringify(resp)}`
        );
        return;
      }
      setMessage(`Provisioned ${resp.email}. They now have access.`);
      await reloadMembers();
      await refreshWorkspaces();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function runDiagnose() {
    setError(null);
    setDiagnose(null);
    try {
      const resp = await apiJson<unknown>('/api/workspace/diagnose');
      setDiagnose(resp);
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
            Add users by email and control exactly what they can do in your workspace.
          </p>
        </div>

        {/* Member list */}
        <div className="space-y-3">
          {members.map((m) => {
            const isEditing = editingMember === m.uid;
            const enabledList = m.permissions
              ? PERM_LABELS.filter((p) => m.permissions[p.key]).map((p) => p.label)
              : [];
            return (
              <div key={m.uid} className="border border-ink-100 rounded p-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium">{m.email || m.uid}</div>
                    <div className="text-xs text-ink-500 capitalize">{m.role}</div>
                  </div>
                  {m.role === 'owner' ? (
                    <span className="pill">you</span>
                  ) : isEditing ? (
                    <div className="flex gap-2">
                      <button className="btn-primary text-xs" onClick={() => savePermissions(m.uid)}>Save</button>
                      <button className="btn-ghost text-xs" onClick={() => setEditingMember(null)}>Cancel</button>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <button
                        className="btn text-xs"
                        onClick={() => {
                          setEditingMember(m.uid);
                          setEditPerms({ ...DEFAULT_INVITE_PERMS, ...m.permissions });
                        }}
                      >
                        Edit permissions
                      </button>
                      <button className="btn-ghost text-xs text-red-600" onClick={() => removeMember(m.uid)}>
                        Remove
                      </button>
                    </div>
                  )}
                </div>

                {m.role !== 'owner' && !isEditing ? (
                  <div className="mt-2 text-xs text-ink-600">
                    Can: {enabledList.length ? enabledList.join(', ') : <span className="text-ink-400">view only</span>}
                  </div>
                ) : null}

                {isEditing ? (
                  <PermissionsEditor
                    value={editPerms}
                    onChange={setEditPerms}
                    onPreset={(p) => applyPreset('edit', p)}
                  />
                ) : null}
              </div>
            );
          })}
        </div>

        {invites.length > 0 ? (
          <div className="pt-2">
            <div className="label">Pending invites</div>
            <div className="space-y-2">
              {invites.map((iv) => (
                <div key={iv.token} className="border border-ink-100 rounded p-3 space-y-2">
                  <div className="flex items-center justify-between">
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
                      <button
                        className="btn text-xs"
                        onClick={() => reprovisionInvite(iv.token)}
                        title="If they've signed up already, this grants access without needing them to click the link."
                      >
                        Reprovision
                      </button>
                      <button className="btn-ghost text-xs text-red-600" onClick={() => revokeInvite(iv.token)}>
                        Revoke
                      </button>
                    </div>
                  </div>
                  <div className="text-xs text-ink-600">
                    Will be granted: {PERM_LABELS.filter((p) => iv.permissions?.[p.key]).map((p) => p.label).join(', ') || 'view only'}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* New invite form */}
        <div className="border-t border-ink-200 pt-4 space-y-3">
          <div className="label">Add a new user</div>
          <div className="flex items-center gap-2">
            <input
              className="field flex-1"
              placeholder="person@example.com"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              type="email"
            />
            <button className="btn-primary" onClick={sendInvite} disabled={invitingLoad || !inviteEmail}>
              {invitingLoad ? 'Adding...' : 'Add user'}
            </button>
          </div>
          <PermissionsEditor
            value={invitePerms}
            onChange={setInvitePerms}
            onPreset={(p) => applyPreset('invite', p)}
          />
          <p className="text-xs text-ink-500">
            If the email already has a Deal Scout account, access is granted immediately. Otherwise they'll
            get an invite link that grants access when they sign up.
          </p>
        </div>

        {justCreatedInvite ? (
          <div className="rounded border border-green-300 bg-green-50 p-3 text-sm space-y-2">
            <div className="font-medium text-green-800">
              {justCreatedInvite.auto_provisioned
                ? 'User added with access granted.'
                : 'Invite created.'}
            </div>
            {justCreatedInvite.emailed ? (
              <div className="text-green-700">Email sent.</div>
            ) : !justCreatedInvite.auto_provisioned ? (
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
            ) : null}
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

      <div className="card p-5 space-y-3">
        <div>
          <h2 className="font-semibold">Diagnose workspace access</h2>
          <p className="text-sm text-ink-500">
            Dumps what the server sees for your account: memberships, invites, and data counts.
            Useful if sharing isn't working.
          </p>
        </div>
        <div>
          <button className="btn" onClick={runDiagnose}>Run diagnose</button>
        </div>
        {diagnose ? (
          <pre className="text-xs bg-ink-50 border border-ink-200 rounded p-3 overflow-auto max-h-96">
            {JSON.stringify(diagnose, null, 2)}
          </pre>
        ) : null}
      </div>

      {error ? (
        <div className="card p-4 text-sm text-red-600 whitespace-pre-wrap">{error}</div>
      ) : null}
    </div>
  );
}

function PermissionsEditor({
  value,
  onChange,
  onPreset,
}: {
  value: Permissions;
  onChange: (p: Permissions) => void;
  onPreset: (p: Permissions) => void;
}) {
  return (
    <div className="rounded border border-ink-200 bg-ink-50 p-3 space-y-3">
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-xs text-ink-500 mr-2">Quick set:</span>
        {PRESETS.map((p) => (
          <button
            key={p.id}
            className="btn-ghost text-xs px-2 py-1 border border-ink-200 rounded"
            onClick={() => onPreset(p.perms)}
            type="button"
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {PERM_LABELS.map((p) => (
          <label key={p.key} className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={!!value[p.key]}
              onChange={(e) => onChange({ ...value, [p.key]: e.target.checked })}
            />
            <span>
              <span className="font-medium text-ink-800">{p.label}</span>
              <span className="block text-xs text-ink-500">{p.hint}</span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
