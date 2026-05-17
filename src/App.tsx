import { useEffect, type ReactNode } from 'react';
import { HashRouter, NavLink, Route, Routes, Navigate } from 'react-router-dom';
import { Home } from './pages/Home';
import { Plans } from './pages/Plans';
import { PlanEditor } from './pages/PlanEditor';
import { Workout } from './pages/Workout';
import { Library } from './pages/Library';
import { Metrics } from './pages/Metrics';
import { LanguageSwitcher } from './components/LanguageSwitcher';
import { useT } from './i18n';
import { useAuth } from './auth/useAuth';
import { Login } from './auth/Login';
import { startSync, stopSync } from './sync';

function Guarded({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  useEffect(() => {
    if (status === 'authenticated') { startSync(); return () => stopSync(); }
  }, [status]);
  if (status === 'loading') return <div className="p-6 text-slate-400">Loading…</div>;
  if (status === 'unauthenticated') return <Login />;
  return <>{children}</>;
}

function App() {
  return (
    <HashRouter>
      <Guarded><Shell /></Guarded>
    </HashRouter>
  );
}

function Shell() {
  const t = useT();
  return (
    <div className="flex flex-col h-full max-w-md mx-auto bg-slate-900 text-slate-100">
      <header className="px-4 pt-6 pb-3 border-b border-slate-800 flex items-center gap-2 sticky top-0 z-10 bg-slate-900/95 backdrop-blur">
        <img
          src={`${import.meta.env.BASE_URL}logo.png`}
          alt=""
          className="w-9 h-9 rounded-lg object-cover ring-2 ring-keung-600"
        />
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold leading-none">{t.appName}</h1>
          <span className="text-xs text-slate-400">{t.tagline}</span>
        </div>
        <LanguageSwitcher />
      </header>

      <main className="flex-1 overflow-y-auto pb-20">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/plans" element={<Plans />} />
          <Route path="/plans/new" element={<PlanEditor />} />
          <Route path="/plans/:id" element={<PlanEditor />} />
          <Route path="/workout" element={<Workout />} />
          <Route path="/workout/:planId" element={<Workout />} />
          <Route path="/library" element={<Library />} />
          <Route path="/metrics" element={<Metrics />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>

      <nav className="fixed bottom-0 left-0 right-0 max-w-md mx-auto border-t border-slate-800 bg-slate-900/95 backdrop-blur grid grid-cols-4 z-10">
        <TabLink to="/" icon="🏠" label={t.tabs.home} end />
        <TabLink to="/plans" icon="📋" label={t.tabs.plans} />
        <TabLink to="/library" icon="📚" label={t.tabs.library} />
        <TabLink to="/metrics" icon="📈" label={t.tabs.metrics} />
      </nav>
    </div>
  );
}

function TabLink({ to, icon, label, end }: { to: string; icon: string; label: string; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `flex flex-col items-center py-2 text-xs ${isActive ? 'text-keung-500' : 'text-slate-400'}`
      }
    >
      <span className="text-xl leading-none">{icon}</span>
      <span className="mt-1">{label}</span>
    </NavLink>
  );
}

export default App;
