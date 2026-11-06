import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { ClientsPage } from './pages/ClientsPage';
import { ClientPage } from './pages/ClientPage';
import { ApplicationPage } from './pages/ApplicationPage';
import { UsersPage } from './pages/UsersPage';
import { AuditPage } from './pages/AuditPage';
import { UsagePage } from './pages/UsagePage';
import { AccountPage } from './pages/AccountPage';
import { SettingsPage } from './pages/SettingsPage';
import { HomePage } from './pages/HomePage';

// The IDE pulls in Monaco (large); load it only when a workspace is opened.
const WorkspacePage = lazy(() => import('./pages/WorkspacePage'));
import './styles.css';
import './ide.css';

function App() {
  const { me, loading } = useAuth();
  if (loading) return <div className="center muted">Loading…</div>;
  if (!me) return <LoginPage />;
  return (
    <Routes>
      <Route path="/workspaces/:id" element={<Suspense fallback={<div className="center muted">Loading editor…</div>}><WorkspacePage /></Suspense>} />
      <Route element={<Layout />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/clients" element={<ClientsPage />} />
        <Route path="/clients/:id" element={<ClientPage />} />
        <Route path="/applications/:id" element={<ApplicationPage />} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="/usage" element={<UsagePage />} />
        <Route path="/account" element={<AccountPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<p className="muted">Page not found.</p>} />
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
