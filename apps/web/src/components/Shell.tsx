import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../lib/auth';

const linkCls = ({ isActive }: { isActive: boolean }) =>
  `px-3 py-1.5 rounded text-sm font-medium ${
    isActive ? 'bg-ink-900 text-white' : 'text-ink-700 hover:bg-ink-100'
  }`;

export default function Shell() {
  const { user, signOut } = useAuth();
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-ink-200 bg-white">
        <div className="mx-auto max-w-[1400px] px-4 flex items-center justify-between h-14">
          <div className="flex items-center gap-3">
            <div className="font-semibold tracking-tight text-ink-900">Deal Scout</div>
            <span className="pill">Real Estate AI Studio</span>
          </div>
          <nav className="flex items-center gap-1">
            <NavLink to="/" end className={linkCls}>Dashboard</NavLink>
            <NavLink to="/buildings" className={linkCls}>Buildings</NavLink>
            <NavLink to="/underwriting" className={linkCls}>Underwriting</NavLink>
            <NavLink to="/contacts" className={linkCls}>Contacts</NavLink>
            <NavLink to="/settings" className={linkCls}>Settings</NavLink>
          </nav>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-ink-500 hidden md:inline">{user?.email}</span>
            <button className="btn-ghost" onClick={() => signOut()}>Sign out</button>
          </div>
        </div>
      </header>
      <main className="flex-1">
        <div className="mx-auto max-w-[1400px] px-4 py-6">
          <Outlet />
        </div>
      </main>
      <footer className="border-t border-ink-200 bg-white">
        <div className="mx-auto max-w-[1400px] px-4 py-3 text-xs text-ink-500">
          Deal Scout CRM. Costa Mesa.
        </div>
      </footer>
    </div>
  );
}
