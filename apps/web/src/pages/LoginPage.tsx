import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

export default function LoginPage() {
  const { user, signIn, error, loading } = useAuth();
  const nav = useNavigate();

  useEffect(() => {
    if (user) nav('/buildings', { replace: true });
  }, [user, nav]);

  return (
    <div className="min-h-screen grid place-items-center bg-ink-50 px-4">
      <div className="card w-full max-w-md p-8">
        <div className="text-sm uppercase tracking-wide text-ink-500 mb-1">Real Estate AI Studio</div>
        <h1 className="text-2xl font-semibold text-ink-900">Deal Scout</h1>
        <p className="text-sm text-ink-500 mt-1">Sign in with your Google account to continue.</p>
        <button
          className="btn-primary w-full mt-6 py-2.5"
          onClick={() => signIn()}
          disabled={loading}
        >
          Continue with Google
        </button>
        {error ? <div className="mt-4 text-sm text-red-600">{error}</div> : null}
      </div>
    </div>
  );
}
