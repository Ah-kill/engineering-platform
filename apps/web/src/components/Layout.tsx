import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth';

export function Layout() {
  const { me, logout } = useAuth();
  if (!me) return null;
  const link = ({ isActive }: { isActive: boolean }) => `nav-link${isActive ? ' active' : ''}`;
  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        <div className="brand">
          Engineering Platform
          <small>{me.org.name}</small>
        </div>
        <NavLink to="/" end className={link}>Home</NavLink>
        <NavLink to="/clients" className={link}>Clients</NavLink>
        {me.user.isOrgAdmin && <NavLink to="/users" className={link}>Developers</NavLink>}
        {me.user.isOrgAdmin && <NavLink to="/audit" className={link}>Audit log</NavLink>}
        {me.user.isOrgAdmin && <NavLink to="/organisation" className={link}>Organisation</NavLink>}
        <NavLink to="/usage" className={link}>Usage</NavLink>
        <NavLink to="/settings" className={link}>Claude &amp; GitHub</NavLink>
        <NavLink to="/account" className={link}>Account</NavLink>
        <div className="sidebar-foot">
          <div>{me.user.displayName}</div>
          <div>{me.user.email}</div>
          <button className="small" style={{ marginTop: 8 }} onClick={() => void logout()}>Sign out</button>
        </div>
      </nav>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
