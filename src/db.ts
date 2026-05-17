import Dexie, { type Table } from 'dexie';

export type MuscleGroup =
  | 'chest'
  | 'back'
  | 'shoulders'
  | 'biceps'
  | 'triceps'
  | 'legs'
  | 'glutes'
  | 'core'
  | 'cardio';

export interface Exercise {
  id: string;
  name: string;
  muscleGroup: MuscleGroup;
  equipment: string;
  emoji: string;
  description: string;
}

export interface PlanExercise {
  exerciseId: string;
  targetSets: number;
  targetReps: number;
  targetWeight?: number;
  notes?: string;
}

interface SyncedRow {
  id: string;
  userId: string;
  updatedAt: number;
  serverVersion: string | null;
}

export interface Plan extends SyncedRow {
  name: string;
  weekStart: string;
  focus: MuscleGroup[];
  exercises: PlanExercise[];
  createdAt: number;
  assignedBy?: string | null;
}

export interface SetLog {
  reps: number;
  weight: number;
  done: boolean;
}

export interface WorkoutSession extends SyncedRow {
  planId?: string;
  date: string;
  exercises: { exerciseId: string; sets: SetLog[] }[];
  notes?: string;
  startedAt: number;
  endedAt?: number;
}

export interface BodyMetric extends SyncedRow {
  date: string;
  weightKg?: number;
  heightCm?: number;
  bodyFatPct?: number;
  notes?: string;
}

export interface Favorite {
  userId: string;
  exerciseId: string;
  addedAt: number;
  updatedAt: number;
  serverVersion: string | null;
}

export type SyncTableName = 'plans' | 'sessions' | 'metrics' | 'favorites';
export type SyncOp = 'insert' | 'update' | 'delete';

export interface SyncQueueRow {
  seq?: number;
  table: SyncTableName;
  rowId: string;
  op: SyncOp;
  expectedServerVersion: string | null;
  attempts: number;
  lastError?: string;
  lastErrorStatus?: number;
  queuedAt: number;
}

export interface SyncDeadLetterRow extends SyncQueueRow {
  movedAt: number;
}

export interface SyncMetaRow {
  key: string;
  value: unknown;
}

class AhKeungDB extends Dexie {
  plans!: Table<Plan, string>;
  sessions!: Table<WorkoutSession, string>;
  metrics!: Table<BodyMetric, string>;
  favorites!: Table<Favorite, [string, string]>;
  syncQueue!: Table<SyncQueueRow, number>;
  syncDeadLetter!: Table<SyncDeadLetterRow, number>;
  syncMeta!: Table<SyncMetaRow, string>;

  constructor() {
    super('ah-keung');
    this.version(1).stores({
      plans: '++id, weekStart, createdAt',
      sessions: '++id, planId, date, startedAt',
      metrics: '++id, date',
    });
    this.version(2).stores({
      plans: '++id, weekStart, createdAt',
      sessions: '++id, planId, date, startedAt',
      metrics: '++id, date',
    }).upgrade(async (tx) => {
      await tx.table('plans').clear();
      await tx.table('sessions').clear();
    });
    this.version(3).stores({
      plans: '++id, weekStart, createdAt',
      sessions: '++id, planId, date, startedAt',
      metrics: '++id, date',
      favorites: 'exerciseId, addedAt',
    });
    this.version(4).stores({
      plans:          'id, userId, weekStart, updatedAt',
      sessions:       'id, userId, planId, date, updatedAt',
      metrics:        'id, userId, date, updatedAt',
      favorites:      '[userId+exerciseId], userId, addedAt',
      syncQueue:      '++seq, table, rowId',
      syncDeadLetter: '++seq, table, rowId',
      syncMeta:       'key',
    }).upgrade(async (tx) => {
      // Pre-launch: no data to migrate. Wipe v3 contents.
      await tx.table('plans').clear();
      await tx.table('sessions').clear();
      await tx.table('metrics').clear();
      await tx.table('favorites').clear();
    });
  }
}

export const db = new AhKeungDB();

export const muscleGroupColor: Record<MuscleGroup, string> = {
  chest: 'bg-rose-500',
  back: 'bg-blue-500',
  shoulders: 'bg-amber-500',
  biceps: 'bg-purple-500',
  triceps: 'bg-fuchsia-500',
  legs: 'bg-emerald-500',
  glutes: 'bg-teal-500',
  core: 'bg-yellow-500',
  cardio: 'bg-red-500',
};
