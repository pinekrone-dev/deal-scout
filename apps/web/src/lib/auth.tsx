import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut as fbSignOut,
  type User
} from 'firebase/auth';
import { allowedDomain, allowedEmail, auth, googleProvider } from './firebase';

type AuthCtx = {
  user: User | null;
  loading: boolean;
  error: string | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
};

const Ctx = createContext<AuthCtx | null>(null);

function isAllowed(user: User): boolean {
  const email = user.email?.toLowerCase() ?? '';
  if (!email) return false;
  if (allowedEmail && email === allowedEmail.toLowerCase()) return true;
  if (allowedDomain && email.endsWith('@' + allowedDomain.toLowerCase())) return true;
  return false;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (u && !isAllowed(u)) {
        setError('This Google account is not authorized for this workspace.');
        await fbSignOut(auth);
        setUser(null);
      } else {
        setUser(u);
        setError(null);
      }
      setLoading(false);
    });
    return () => unsub();
  }, []);

  const value = useMemo<AuthCtx>(
    () => ({
      user,
      loading,
      error,
      async signIn() {
        setError(null);
        try {
          const result = await signInWithPopup(auth, googleProvider);
          if (!isAllowed(result.user)) {
            await fbSignOut(auth);
            setError('This Google account is not authorized for this workspace.');
          }
        } catch (e: unknown) {
          setError(e instanceof Error ? e.message : 'Sign in failed');
        }
      },
      async signOut() {
        await fbSignOut(auth);
      }
    }),
    [user, loading, error]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside AuthProvider');
  return v;
}
