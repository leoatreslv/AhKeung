type Row = Record<string, unknown> & { id?: string; user_id?: string };
type Tables = Record<string, Row[]>;

interface Session {
  access_token: string;
  refresh_token: string;
  user: { id: string; email: string };
}

type AuthEvent = 'SIGNED_IN' | 'SIGNED_OUT' | 'TOKEN_REFRESHED';
type AuthListener = (event: AuthEvent, session: Session | null) => void;

type QueryResult = { data: Row[] | null; error: Error | null };

interface Builder extends PromiseLike<QueryResult> {
  select(cols?: string): Builder;
  eq(col: string, val: unknown): Builder;
  gte(col: string, val: unknown): Builder;
  order(col: string, opts?: { ascending?: boolean }): Builder;
  limit(n: number): Builder;
  insert(row: Row | Row[]): Builder;
  update(row: Row): Builder;
  upsert(row: Row | Row[]): Builder;
  delete(): Builder;
  then<TResult1 = QueryResult, TResult2 = never>(
    onResolve?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onReject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2>;
  catch<TResult = never>(
    onReject?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<QueryResult | TResult>;
}

interface StoredObject { bucket: string; path: string; blob: Blob; contentType: string }

export function createFakeSupabase() {
  const tables: Tables = {
    profiles: [], plans: [], sessions: [], metrics: [], favorites: [],
  };
  const storage: StoredObject[] = [];
  let session: Session | null = null;
  let networkUp = true;
  const listeners: AuthListener[] = [];

  function nowIso() { return new Date().toISOString(); }
  function notify(event: AuthEvent) { for (const l of listeners) l(event, session); }
  function requireNetwork() {
    if (!networkUp) throw new Error('network failure (fake)');
  }

  function builder(tableName: string): Builder {
    const filters: { col: string; val: unknown; op: 'eq' | 'gte' }[] = [];
    let action: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select';
    let payload: Row | Row[] | undefined;
    let selectedAfter = false;
    let cached: Promise<QueryResult> | null = null;

    function execute(): QueryResult {
      requireNetwork();
      const arr = tables[tableName] ?? (tables[tableName] = []);
      const match = (r: Row) =>
        filters.every((f) => {
          const v = (r as Record<string, unknown>)[f.col];
          if (f.op === 'gte') {
            return (v as string | number) >= (f.val as string | number);
          }
          return v === f.val;
        });

      if (action === 'select') {
        const data = arr.filter(match).map((r) => ({ ...r }));
        return { data, error: null };
      }
      if (action === 'insert') {
        const rows = Array.isArray(payload) ? payload : [payload!];
        const stamped = rows.map((r) => ({ ...r, updated_at: nowIso() }));
        arr.push(...stamped);
        return { data: stamped.map((r) => ({ ...r })), error: null };
      }
      if (action === 'update') {
        const updated: Row[] = [];
        for (const r of arr) {
          if (match(r)) {
            Object.assign(r, payload, { updated_at: nowIso() });
            updated.push({ ...r });
          }
        }
        return { data: selectedAfter ? updated : null, error: null };
      }
      if (action === 'delete') {
        const remaining: Row[] = [];
        const deleted: Row[] = [];
        for (const r of arr) { if (match(r)) deleted.push({ ...r }); else remaining.push(r); }
        tables[tableName] = remaining;
        return { data: deleted, error: null };
      }
      if (action === 'upsert') {
        const rows = Array.isArray(payload) ? payload : [payload!];
        const stamped: Row[] = [];
        for (const r of rows) {
          const idx = arr.findIndex((x) => x.id === r.id);
          if (idx >= 0) {
            Object.assign(arr[idx], r, { updated_at: nowIso() });
            stamped.push({ ...arr[idx] });
          } else {
            const row = { ...r, updated_at: nowIso() };
            arr.push(row);
            stamped.push({ ...row });
          }
        }
        return { data: stamped, error: null };
      }
      return { data: null, error: null };
    }

    const api: Builder = {
      select(_cols?: string) {
        void _cols;
        if (action === 'select') { action = 'select'; }
        else { selectedAfter = true; }
        return api;
      },
      eq(col: string, val: unknown) { filters.push({ col, val, op: 'eq' }); return api; },
      gte(col: string, val: unknown) { filters.push({ col, val, op: 'gte' }); return api; },
      order(_col: string, _opts?: { ascending?: boolean }) {
        void _col; void _opts;
        return api;
      },
      limit(_n: number) { void _n; return api; },
      insert(row: Row | Row[]) { action = 'insert'; payload = row; return api; },
      update(row: Row) { action = 'update'; payload = row; return api; },
      upsert(row: Row | Row[]) { action = 'upsert'; payload = row; return api; },
      delete() { action = 'delete'; return api; },
      then(onResolve, onReject) {
        if (!cached) {
          cached = new Promise<QueryResult>((resolve, reject) => {
            try { resolve(execute()); }
            catch (e) { reject(e as Error); }
          });
        }
        return cached.then(onResolve ?? undefined, onReject ?? undefined);
      },
      catch(onReject) {
        return this.then(undefined, onReject ?? undefined);
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
      async signInWithOtp(args: { email: string }) {
        void args;
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
    storage: {
      from(bucket: string) {
        return {
          async upload(path: string, blob: Blob, opts?: { contentType?: string; upsert?: boolean }) {
            if (!networkUp) return { data: null, error: new Error('network failure (fake)') };
            const existing = storage.findIndex((o) => o.bucket === bucket && o.path === path);
            if (existing >= 0) {
              if (!opts?.upsert) return { data: null, error: new Error('already exists') };
              storage.splice(existing, 1);
            }
            storage.push({ bucket, path, blob, contentType: opts?.contentType ?? blob.type });
            return { data: { path }, error: null };
          },
        };
      },
    },
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
    storage,
  };
}

export type FakeSupabase = ReturnType<typeof createFakeSupabase>;
