// src/sync/mapping.ts
// Whitelist of inbound fields we accept per table. Unknown fields are dropped
// silently so server schema additions don't crash the client.
const INBOUND_FIELDS: Record<string, Set<string>> = {
  plans:     new Set(['id', 'user_id', 'assigned_by', 'name', 'week_start', 'focus',
                      'exercises', 'created_at', 'updated_at', 'deleted_at', 'superseded_by']),
  sessions:  new Set(['id', 'user_id', 'plan_id', 'date', 'exercises', 'notes',
                      'started_at', 'ended_at', 'updated_at', 'deleted_at']),
  metrics:   new Set(['id', 'user_id', 'date', 'weight_kg', 'height_cm',
                      'body_fat_pct', 'notes', 'updated_at', 'deleted_at']),
  favorites: new Set(['user_id', 'exercise_id', 'added_at', 'updated_at', 'deleted_at']),
  profiles:  new Set(['id', 'display_name', 'is_trainer', 'created_at']),

  // Keys are the *client* (camelCase Dexie) table names — matches the
  // argument pullWorker passes to fromServerRow().
  exercises: new Set(['id', 'owner_id', 'name_en', 'name_zh', 'muscle_group',
                      'equipment', 'instructions', 'image_path',
                      'created_at', 'updated_at', 'deleted_at']),
  exerciseBundles: new Set(['id', 'owner_id', 'name', 'description',
                            'created_at', 'updated_at', 'deleted_at']),
  exerciseBundleItems: new Set(['bundle_id', 'exercise_id', 'position', 'updated_at']),
  shares: new Set(['id', 'granter_id', 'recipient_id', 'resource_type', 'resource_id',
                   'created_at', 'updated_at', 'deleted_at']),
  trainerTrainees: new Set(['trainer_id', 'trainee_id', 'status',
                            'designated_at', 'responded_at', 'updated_at']),
};

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
}

const CLIENT_ONLY_FIELDS = new Set(['serverVersion', 'pendingImageBlob']);

// Fields whose values are epoch-ms on the client and timestamptz on the server.
// We convert on the way out (ms → ISO) and back on the way in (ISO → ms) so the
// Dexie schema stays uniformly number-typed and PostgREST accepts the payloads.
const TIMESTAMP_FIELDS_CAMEL = new Set([
  'createdAt', 'updatedAt', 'deletedAt', 'startedAt', 'endedAt', 'addedAt',
]);
const TIMESTAMP_FIELDS_SNAKE = new Set([
  'created_at', 'updated_at', 'deleted_at', 'started_at', 'ended_at', 'added_at',
]);

function toIsoIfMs(v: unknown): unknown {
  if (typeof v !== 'number' || !Number.isFinite(v)) return v;
  return new Date(v).toISOString();
}

function toMsIfIso(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : v;
}

export function toServerRow(camel: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(camel)) {
    if (CLIENT_ONLY_FIELDS.has(k)) continue;
    out[camelToSnake(k)] = TIMESTAMP_FIELDS_CAMEL.has(k) ? toIsoIfMs(v) : v;
  }
  return out;
}

export function fromServerRow(
  snake: Record<string, unknown>,
  table?: string,
): Record<string, unknown> {
  const whitelist = table ? INBOUND_FIELDS[table] : undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(snake)) {
    if (whitelist && !whitelist.has(k)) continue;
    out[snakeToCamel(k)] = TIMESTAMP_FIELDS_SNAKE.has(k) ? toMsIfIso(v) : v;
  }
  return out;
}
