import { useEffect, useState, type ReactNode } from 'react';
import { HashRouter, NavLink, Route, Routes, Navigate, useParams } from 'react-router-dom';
import { resetApp } from './resetApp';
import { Home } from './pages/Home';
import { Plans } from './pages/Plans';
import { PlanEditor } from './pages/PlanEditor';
import { Workout } from './pages/Workout';
import { Library } from './pages/Library';
import { Metrics } from './pages/Metrics';
import { Settings } from './pages/Settings';
import { MyExercises } from './pages/MyExercises';
import { ExerciseEditor } from './pages/ExerciseEditor';
import { MyBundles } from './pages/MyBundles';
import { BundleEditor } from './pages/BundleEditor';
import { MyTrainees } from './pages/MyTrainees';
import { ModeGate } from './components/ModeGate';
import { TrainerDashboard } from './pages/TrainerDashboard';
import { AdminInvites } from './pages/AdminInvites';
import { AdminUsers } from './pages/AdminUsers';
import { AdminAudit } from './pages/AdminAudit';
import { LanguageSwitcher } from './components/LanguageSwitcher';
import { ModeSwitcher } from './components/ModeSwitcher';
import { useI18n } from './i18n';
import type { Translation } from './i18n/types';
import { useAuth } from './auth/useAuth';
import { Login } from './auth/Login';
import { Onboarding } from './auth/Onboarding';
import { ResetPassword } from './auth/ResetPassword';
import { startSync, stopSync, flushNow } from './sync';
import { RoleModeProvider, useRoleMode, type Mode } from './auth/RoleMode';

function Guarded({ children }: { children: ReactNode }) {
  const { status, profile, profileFetchError, needsPasswordReset, refreshProfile } = useAuth();
  const fullyReady = status === 'authenticated'
    && !needsPasswordReset
    && !!profile?.displayName;
  useEffect(() => {
    if (fullyReady) {
      startSync();
      // Kick an immediate flush so a fresh sign-in (e.g. after sign-out
      // wiped the local Dexie) pulls the user's server-side data right
      // away, instead of waiting up to 60s for the first pull tick.
      void flushNow();
      return () => stopSync();
    }
  }, [fullyReady]);

  if (status === 'loading') return <LoadingScreen />;
  if (status === 'unauthenticated') return <Login />;
  // ResetPassword is for already-onboarded users who forgot their password.
  // If the user arrived via a recovery link but has never set a display name
  // (e.g. an invited user whose first link was burned by an inbox prefetcher
  // and we re-sent them a recovery email), skip ResetPassword and route
  // straight to Onboarding — it sets the password and display name in one
  // step, so they're not asked for a password twice.
  if (needsPasswordReset && profile?.displayName) return <ResetPassword />;
  // Profile fetch failed and we have no cached profile to fall back on —
  // don't auto-route to onboarding (would be wrong for an existing user
  // who's just offline). Show a small retry surface instead.
  if (profileFetchError && !profile) {
    return (
      <div className="p-6 max-w-sm mx-auto text-center text-slate-100">
        <p className="text-rose-400 mb-3">Couldn't load your profile.</p>
        <p className="text-slate-400 text-sm mb-6">{profileFetchError}</p>
        <button
          type="button"
          onClick={() => void refreshProfile()}
          className="px-4 py-2 bg-keung-600 hover:bg-keung-700 rounded-lg text-white"
        >Retry</button>
      </div>
    );
  }
  // First-time user — profile fetched successfully but display_name is null.
  if (profile && !profile.displayName) return <Onboarding />;
  const readyProfile = profile!;
  return <RoleModeProvider profile={readyProfile}>{children}</RoleModeProvider>;
}

/** The page's initial "Loading…" screen. After 12 seconds — past
 *  AuthProvider's 10s bootstrap timeout, so by then we know
 *  something is genuinely wrong — reveals a "Reset this app" link
 *  so the user has a recovery escape hatch even if every other
 *  state transition has failed. */
function LoadingScreen() {
  const { t } = useI18n();
  const [showReset, setShowReset] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShowReset(true), 12_000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="p-6 text-slate-400 text-center">
      <div>Loading…</div>
      {showReset && (
        <div className="mt-8 text-xs">
          <div className="mb-1 text-slate-500">{t.resetApp.loadingHint}</div>
          <button
            type="button"
            onClick={() => {
              if (window.confirm(t.resetApp.confirm)) void resetApp();
            }}
            className="text-slate-300 hover:text-slate-100 underline"
          >{t.resetApp.button}</button>
        </div>
      )}
    </div>
  );
}

function App() {
  return (
    <HashRouter>
      <Guarded><Shell /></Guarded>
    </HashRouter>
  );
}

const NAV_BY_MODE: Record<Mode, { to: string; icon: string; labelKey: string; end?: boolean }[]> = {
  trainee: [
    { to: '/',        icon: '🏠', labelKey: 'tabs.home', end: true },
    { to: '/plans',   icon: '📋', labelKey: 'tabs.plans' },
    { to: '/library', icon: '📚', labelKey: 'tabs.library' },
    { to: '/metrics', icon: '📈', labelKey: 'tabs.metrics' },
  ],
  trainer: [
    { to: '/trainer/trainees',  icon: '👥', labelKey: 'trainerTabs.trainees' },
    { to: '/trainer/exercises', icon: '🏋️', labelKey: 'trainerTabs.exercises' },
    { to: '/trainer/bundles',   icon: '📦', labelKey: 'trainerTabs.bundles' },
    { to: '/trainer',           icon: '🏠', labelKey: 'trainerTabs.dashboard', end: true },
  ],
  admin: [
    { to: '/admin/invites', icon: '✉️', labelKey: 'adminTabs.invites' },
    { to: '/admin/users',   icon: '👤', labelKey: 'adminTabs.users' },
    { to: '/admin/audit',   icon: '📜', labelKey: 'adminTabs.audit' },
  ],
};

function resolveLabel(t: Translation, key: string): string {
  // Two-segment dotted key like "tabs.home" or "trainerTabs.dashboard".
  const [group, leaf] = key.split('.');
  return (t as unknown as Record<string, Record<string, string>>)[group][leaf];
}

function Shell() {
  const { t, locale } = useI18n();
  const { profile, user } = useAuth();
  const { mode } = useRoleMode();
  // Prefer the saved display name; fall back to the local-part of email so
  // the user always sees *something* about themselves in the header rather
  // than just the app name. Locale-aware greeting so it doesn't say "Hi,"
  // in a Chinese UI.
  const name = profile?.displayName?.trim() || user?.email?.split('@')[0] || '';
  const greeting = locale === 'zh-Hant' ? `${name} 你好` : `Hi, ${name}`;
  return (
    <div className="flex flex-col h-full max-w-md mx-auto bg-slate-900 text-slate-100">
      <header
        className={
          'px-4 pt-6 pb-3 border-b flex items-center gap-2 sticky top-0 z-10 bg-slate-900/95 backdrop-blur ' +
          (mode === 'trainer' ? 'border-keung-600/60' : mode === 'admin' ? 'border-amber-600/60' : 'border-slate-800')
        }
      >
        <img
          src={`${import.meta.env.BASE_URL}logo.png`}
          alt=""
          className="w-9 h-9 rounded-lg object-cover ring-2 ring-keung-600"
        />
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold leading-none">{t.appName}</h1>
          <span className="text-xs text-slate-400 truncate block">
            {name ? greeting : t.tagline}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <LanguageSwitcher />
          <ModeSwitcher />
          <NavLink to="/settings" aria-label="settings" className="text-slate-300 text-xl">⚙️</NavLink>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto pb-20">
        <Routes>
          {/* Trainee mode */}
          <Route path="/" element={<ModeGate allowedIn={['trainee']}><Home /></ModeGate>} />
          <Route path="/plans" element={<ModeGate allowedIn={['trainee']}><Plans /></ModeGate>} />
          <Route path="/plans/new" element={<ModeGate allowedIn={['trainee']}><PlanEditor /></ModeGate>} />
          <Route path="/plans/:id" element={<ModeGate allowedIn={['trainee']}><PlanEditor /></ModeGate>} />
          <Route path="/workout" element={<ModeGate allowedIn={['trainee']}><Workout /></ModeGate>} />
          <Route path="/workout/:planId" element={<ModeGate allowedIn={['trainee']}><Workout /></ModeGate>} />
          <Route path="/library" element={<ModeGate allowedIn={['trainee']}><Library /></ModeGate>} />
          <Route path="/metrics" element={<ModeGate allowedIn={['trainee']}><Metrics /></ModeGate>} />

          {/* Trainer mode */}
          <Route path="/trainer" element={<ModeGate allowedIn={['trainer']}><TrainerDashboard /></ModeGate>} />
          <Route path="/trainer/trainees" element={<ModeGate allowedIn={['trainer']}><MyTrainees /></ModeGate>} />
          <Route path="/trainer/exercises" element={<ModeGate allowedIn={['trainer']}><MyExercises /></ModeGate>} />
          <Route path="/trainer/exercises/new" element={<ModeGate allowedIn={['trainer']}><ExerciseEditor /></ModeGate>} />
          <Route path="/trainer/exercises/:id" element={<ModeGate allowedIn={['trainer']}><ExerciseEditor /></ModeGate>} />
          <Route path="/trainer/bundles" element={<ModeGate allowedIn={['trainer']}><MyBundles /></ModeGate>} />
          <Route path="/trainer/bundles/new" element={<ModeGate allowedIn={['trainer']}><BundleEditor /></ModeGate>} />
          <Route path="/trainer/bundles/:id" element={<ModeGate allowedIn={['trainer']}><BundleEditor /></ModeGate>} />

          {/* Admin mode */}
          <Route path="/admin/invites" element={<ModeGate allowedIn={['admin']}><AdminInvites /></ModeGate>} />
          <Route path="/admin/users" element={<ModeGate allowedIn={['admin']}><AdminUsers /></ModeGate>} />
          <Route path="/admin/audit" element={<ModeGate allowedIn={['admin']}><AdminAudit /></ModeGate>} />

          {/* Cross-mode */}
          <Route path="/settings" element={<Settings />} />

          {/* Legacy URL redirects for external bookmarks */}
          <Route path="/exercises" element={<Navigate to="/trainer/exercises" replace />} />
          <Route path="/exercises/new" element={<Navigate to="/trainer/exercises/new" replace />} />
          <Route path="/exercises/:id" element={<ParamRedirect to={(p) => `/trainer/exercises/${p.id}`} />} />
          <Route path="/bundles" element={<Navigate to="/trainer/bundles" replace />} />
          <Route path="/bundles/new" element={<Navigate to="/trainer/bundles/new" replace />} />
          <Route path="/bundles/:id" element={<ParamRedirect to={(p) => `/trainer/bundles/${p.id}`} />} />
          <Route path="/trainees" element={<Navigate to="/trainer/trainees" replace />} />

          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>

      <nav
        className="fixed bottom-0 left-0 right-0 max-w-md mx-auto border-t border-slate-800 bg-slate-900/95 backdrop-blur grid z-10"
        style={{ gridTemplateColumns: `repeat(${NAV_BY_MODE[mode].length}, minmax(0, 1fr))` }}
      >
        {NAV_BY_MODE[mode].map((tab) => (
          <TabLink key={tab.to} to={tab.to} icon={tab.icon} label={resolveLabel(t, tab.labelKey)} end={tab.end} />
        ))}
      </nav>
    </div>
  );
}

function ParamRedirect({ to }: { to: (p: Readonly<Record<string, string | undefined>>) => string }) {
  const params = useParams();
  return <Navigate to={to(params)} replace />;
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
