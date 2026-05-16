type Row = Record<string, unknown> & { id?: string; user_id?: string };
type Tables = Record<string, Row[]>;

interface Session {
  access_token: string;
  refresh_token: string;
  user: { id: string; email: string };
}

type AuthEvent = 'SIGNED_IN' | 'SIGNED_OUT' | 'TOKEN_REFRESHED';
type AuthListener = (event: AuthEvent, session: Session | null) => void;

export function createFakeSupabase() {
  const tables: Tables = {
    profiles: [], plans: [], sessions: [], metrics: [], favorites: [],
  };
  let session: Session | null = null;
  let networkUp = true;
  const listeners: AuthListener[] = [];

  function nowIso() { return new Date().toISOString(); }
  function notify(event: AuthEvent) { for (const l of listeners) l(event, session); }
  function requireNetwork() {
    if (!networkUp) throw new Error('network failure (fake)');
  }

  function builder(tableName: string) {
    const filters: { col: string; val: unknown }[] = [];
    let action: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select';
    let payload: Row | Row[] | undefined;
    let selectedAfter = false;

    const api: any = {
      select(_cols?: string) {
        if (action === 'select') { action = 'select'; }
        else { selectedAfter = true; }
        return api;
      },
      eq(col: string, val: unknown) { filters.push({ col, val }); return api; },
      insert(row: Row | Row[]) { action = 'insert'; payload = row; return api;  },
      update(row: Row) { action = 'update'; payload = row; return api; },
      upsert(row: Row | Row[]) { action = 'upsert'; payload = row; return api; },
      delete() { action = 'delete'; return api; },
      then(onResolve: (r: { data: Row[] | null; error: Error | null }) => unknown,
           onReject?: (e: Error) => unknown) {
        try {
          requireNetwork();
          const arr = tables[tableName] ?? (tables[tableName] = []);
          const match = (r: Row) => filters.every((f) => (r as any)[f.col] === f.val);

          if (action === 'select') {
            const data = arr.filter(match);
            return Promise.resolve({ data, error: null }).then(onResolve, onReject);
          }
          if (action === 'insert') {
            const rows = Array.isArray(payload) ? payload : [payload!];
            const stamped = rows.map((r) => ({ ...r, updated_at: nowIso() }));
            arr.push(...stamped);
            return Promise.resolve({ data: stamped, error: null }).then(onResolve, onReject);
          }
          if (action === 'update') {
            const updated: Row[] = [];
            for (const r of arr) {
              if (match(r)) {
                Object.assign(r, payload, { updated_at: nowIso() });
                updated.push(r);
              }
            }
            return Promise.resolve({ data: selectedAfter ? updated : null, error: null })
              .then(onResolve, onReject);
          }
          if (action === 'delete') {
            const remaining: Row[] = [];
            const deleted: Row[] = [];
            for (const r of arr) { if (match(r)) deleted.push(r); else remaining.push(r); }
            tables[tableName] = remaining;
            return Promise.resolve({ data: deleted, error: null }).then(onResolve, onReject);
          }
          if (action === 'upsert') {
            const rows = Array.isArray(payload) ? payload : [payload!];
            for (const r of rows) {
              const idx = arr.findIndex((x) => x.id === r.id);
              if (idx >= 0) { Object.assign(arr[idx], r, { updated_at: nowIso() }); }
              else { arr.push({ ...r, updated_at: nowIso() }); }
            }
            return Promise.resolve({ data: rows, error: null }).then(onResolve, onReject);
          }
          return Promise.resolve({ data: null, error: null }).then(onResolve, onReject);
        } catch (e) {
          return Promise.reject(e as Error).then(undefined, onReject);
        }
      },
    };
    return api;
  }

  const client = {
    auth: {
      async getSession() { return { data: { session }, error: null }; },
      onAuthStateChange(cb: AuthListener) {
        listeners.push(cb);
        return { data: { subscription: { unsubscribe() {
          const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1);
        } } } };
      },
      async signInWithOtp(_args: { email: string }) {
        requireNetwork();
        return { data: {}, error: null };
      },
      async refreshSession() {
        requireNetwork();
        if (!session) return { data: { session: null }, error: null };
        notify('TOKEN_REFRESHED');
        return { data: { session }, error: null };
      },
      async signOut() { session = null; notify('SIGNED_OUT'); return { error: null }; },
    },
    from(name: string) { return builder(name); },
  };

  return {
    client,
    deliverMagicLink(email: string, userId: string) {
      session = {
        access_token: 'fake-access', refresh_token: 'fake-refresh',
        user: { id: userId, email },
      };
      // Ensure a profile row exists (simulates handle_new_user trigger).
      if (!tables.profiles.find((p) => p.id === userId)) {
        tables.profiles.push({
          id: userId, display_name: null, is_trainer: false, created_at: nowIso(),
        });
      }
      notify('SIGNED_IN');
    },
    setNetworkUp(up: boolean) { networkUp = up; },
    setTrainer(userId: string, isTrainer: boolean) {
      const p = tables.profiles.find((x) => x.id === userId);
      if (p) p.is_trainer = isTrainer;
    },
    rowOf(table: string, id: string) {
      return (tables[table] ?? []).find((r) => r.id === id) as Row;
    },
    tables,
  };
}

export type FakeSupabase = ReturnType<typeof createFakeSupabase>;
