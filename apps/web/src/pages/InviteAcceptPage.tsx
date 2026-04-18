import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useWorkspace } from '../lib/workspace';
import { apiJson } from '../lib/api';

type AcceptResp = { ok: boolean; workspace_owner_uid: string };

export default function InviteAcceptPage() {
  const { token } = useParams<{ token: string }>();
  const { user, loading: authLoading, signIn, signOut } = useAuth();
  const { refresh, select } = useWorkspace();
  const nav = useNavigate();
  const [status, setStatus] = useState<'idle' | 'accepting' | 'ok' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  async function accept() {
    if (!token) return;
    setStatus('accepting');
    setMessage(null);
    try {
      const resp = await apiJson<AcceptResp>(`/api/workspace/invites/${token}/accept`, { method: 'POST' });
      setStatus('ok');
      // Refresh the workspace list and select the newly-joined workspace.
      await refresh();
      select(resp.workspace_owner_uid);
      setTimeout(() => nav('/'), 750);
    } catch (e) {
      setStatus('error');
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    if (!token) return;
    if (authLoading) return;
    if (!user) return;
    if (status === 'idle') void accept();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, user, authLoading]);

  if (!token) {
    return (
      <div className="max-w-md mx-auto mt-20 card p-6">
        <h1 className="text-lg font-semibold">Invalid invite link</h1>
        <p className="text-sm text-ink-500 mt-1">This URL is missing an invite token.</p>
      </div>
    );
  }

  if (authLoading) {
    return (
      <div className="max-w-md mx-auto mt-20 card p-6">
        <div className="text-ink-500 text-sm">Loading...</div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="max-w-md mx-auto mt-20 card p-6 space-y-3">
        <h1 className="text-lg font-semibold">You've been invited to a Deal Scout workspace</h1>
        <p className="text-sm text-ink-500">
          Sign in to accept this invite. Use the email address the invite was sent to.
        </p>
        <button className="btn-primary" onClick={() => signIn()}>
          Sign in with Google
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto mt-20 card p-6 space-y-3">
      <h1 className="text-lg font-semibold">Accept workspace invite</h1>
      <p className="text-sm text-ink-500">Signed in as {user.email}.</p>
      {status === 'accepting' ? (
        <div className="text-sm text-ink-700">Joining workspace...</div>
      ) : null}
      {status === 'ok' ? (
        <div className="text-sm text-green-700">Joined. Redirecting...</div>
      ) : null}
      {status === 'error' ? (
        <div className="space-y-2">
          <div className="text-sm text-red-600 whitespace-pre-wrap break-words">{message}</div>
          <div className="flex gap-2">
            <button className="btn" onClick={accept}>Try again</button>
            <button className="btn-ghost" onClick={() => signOut()}>
              Sign out and use a different account
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
