import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react';
import { useAuth } from './auth';
import { apiJson } from './api';

export type Permissions = {
  view: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
  underwrite: boolean;
  invite_others: boolean;
};

export const ALL_PERMS: Permissions = {
  view: true, create: true, edit: true, delete: true, underwrite: true, invite_others: true,
};

export type Workspace = {
  owner_uid: string;
  owner_email: string;
  role: 'owner' | 'editor';
  label: string;
  permissions?: Permissions;
};

type ListResp = { workspaces: Workspace[]; default_owner_uid: string };

type Ctx = {
  loading: boolean;
  error: string | null;
  workspaces: Workspace[];
  current: Workspace | null;
  currentOwnerUid: string | null;
  isOwner: boolean;
  permissions: Permissions;
  can: (action: keyof Permissions) => boolean;
  select: (ownerUid: string) => void;
  refresh: () => Promise<void>;
};

const WorkspaceCtx = createContext<Ctx | null>(null);

const STORAGE_KEY = 'deal-scout.workspace.selected';

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedUid, setSelectedUid] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await apiJson<ListResp>('/api/workspace/list');
      setWorkspaces(resp.workspaces || []);
      // If we don't have a valid selection, fall back to the API's default.
      setSelectedUid((prev) => {
        const uids = new Set((resp.workspaces || []).map((w) => w.owner_uid));
        if (prev && uids.has(prev)) return prev;
        return resp.default_owner_uid || user.uid;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (!user) {
      setWorkspaces([]);
      setSelectedUid(null);
      return;
    }
    void refresh();
  }, [user, refresh]);

  const select = useCallback((ownerUid: string) => {
    setSelectedUid(ownerUid);
    try {
      window.localStorage.setItem(STORAGE_KEY, ownerUid);
    } catch {
      /* ignore */
    }
  }, []);

  const value = useMemo<Ctx>(() => {
    const current = workspaces.find((w) => w.owner_uid === selectedUid) ?? workspaces[0] ?? null;
    const permissions: Permissions = current?.role === 'owner'
      ? ALL_PERMS
      : (current?.permissions ?? { view: false, create: false, edit: false, delete: false, underwrite: false, invite_others: false });
    return {
      loading,
      error,
      workspaces,
      current,
      currentOwnerUid: current?.owner_uid ?? null,
      isOwner: current?.role === 'owner',
      permissions,
      can: (action) => !!permissions[action],
      select,
      refresh
    };
  }, [workspaces, selectedUid, loading, error, select, refresh]);

  return <WorkspaceCtx.Provider value={value}>{children}</WorkspaceCtx.Provider>;
}

export function useWorkspace(): Ctx {
  const v = useContext(WorkspaceCtx);
  if (!v) throw new Error('useWorkspace must be used inside WorkspaceProvider');
  return v;
}
