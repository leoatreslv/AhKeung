// src/sync/mapping.ts
// Whitelist of inbound fields we accept per table. Unknown fields are dropped
// silently so server schema additions don't crash the client.
const INBOUND_FIELDS: Record<string, Set<string>> = {
  plans:     new Set(['id', 'user_id', 'assigned_by', 'name', 'week_start', 'focus',
                      'exercises', 'created_at', 'updated_at', 'deleted_at']),
  sessions:  new Set(['id', 'user_id', 'plan_id', 'date', 'exercises', 'notes',
                      'started_at', 'ended_at', 'updated_at', 'deleted_at']),
  metrics:   new Set(['id', 'user_id', 'date', 'weight_kg', 'height_cm',
                      'body_fat_pct', 'notes', 'updated_at', 'deleted_at']),
  favorites: new Set(['user_id', 'exercise_id', 'added_at', 'updated_at', 'deleted_at']),
  profiles:  new Set(['id', 'display_name', 'is_trainer', 'created_at']),
};

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
}

const CLIENT_ONLY_FIELDS = new Set(['serverVersion']);

export function toServerRow(camel: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(camel)) {
    if (CLIENT_ONLY_FIELDS.has(k)) continue;
    out[camelToSnake(k)] = v;
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
    out[snakeToCamel(k)] = v;
  }
  return out;
}
