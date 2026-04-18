import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth';
import Shell from './components/Shell';
import LoginPage from './pages/LoginPage';
import BuildingsPage from './pages/BuildingsPage';
import BuildingDetailPage from './pages/BuildingDetailPage';
import ContactsPage from './pages/ContactsPage';
import ContactDetailPage from './pages/ContactDetailPage';
import DealsPage from './pages/DealsPage';
import IngestPage from './pages/IngestPage';
import SettingsPage from './pages/SettingsPage';
import NotFoundPage from './pages/NotFoundPage';

function Protected({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center text-ink-500 text-sm">
        Loading...
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          element={
            <Protected>
              <Shell />
            </Protected>
          }
        >
          <Route index element={<Navigate to="/buildings" replace />} />
          <Route path="/buildings" element={<BuildingsPage />} />
          <Route path="/buildings/:id" element={<BuildingDetailPage />} />
          <Route path="/contacts" element={<ContactsPage />} />
          <Route path="/contacts/:id" element={<ContactDetailPage />} />
          <Route path="/deals" element={<DealsPage />} />
          <Route path="/ingest/:ingestionId" element={<IngestPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AuthProvider>
  );
}
