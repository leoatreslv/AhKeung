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
  updatedAt: number;
  serverVersion: string | null;
}

/** Tables owned by a single user, with the owner column named `user_id`
 *  server-side (plans, sessions, metrics, favorites). */
interface OwnedRow extends SyncedRow {
  userId: string;
}

export interface Plan extends OwnedRow {
  name: string;
  weekStart: string;
  focus: MuscleGroup[];
  exercises: PlanExercise[];
  createdAt: number;
  assignedBy?: string | null;
  /** Set on the older plan when a trainer re-shares an updated version
   *  to the same trainee. UI filters to `superseded_by == null` for the
   *  "current" assigned plan; older copies still exist for history. */
  supersededBy?: string | null;
  deletedAt?: number;
}

export interface SetLog {
  reps: number;
  weight: number;
  done: boolean;
}

export interface WorkoutSession extends OwnedRow {
  planId?: string;
  date: string;
  exercises: { exerciseId: string; sets: SetLog[] }[];
  notes?: string;
  startedAt: number;
  endedAt?: number;
}

export interface BodyMetric extends OwnedRow {
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

export interface CustomExercise extends SyncedRow {
  ownerId: string;
  nameEn: string | null;
  nameZh: string | null;
  muscleGroup: MuscleGroup;
  equipment: string | null;
  instructions: string | null;
  imagePath: string | null;
  createdAt: number;
  deletedAt?: number;
  /** Client-only: a freshly-picked image waiting to be uploaded to
   *  Supabase Storage. Stripped from server payloads by the mapping layer
   *  and skipped by the push worker until cleared. Once the upload sweep
   *  succeeds, `imagePath` is set and this field is removed. */
  pendingImageBlob?: Blob;
}

export interface ExerciseBundle extends SyncedRow {
  ownerId: string;
  name: string;
  description: string | null;
  createdAt: number;
  deletedAt?: number;
}

export interface ExerciseBundleItem {
  bundleId: string;
  exerciseId: string;
  position: number;
  updatedAt: number;
  serverVersion: string | null;
}

export type ShareResourceType = 'exercise' | 'bundle' | 'plan';

export interface Share extends SyncedRow {
  granterId: string;
  recipientId: string;
  resourceType: ShareResourceType;
  resourceId: string;
  createdAt: number;
  deletedAt?: number;
}

export type DesignationStatus = 'pending' | 'accepted' | 'declined';

export interface TrainerTrainee {
  trainerId: string;
  traineeId: string;
  status: DesignationStatus;
  designatedAt: number;
  respondedAt?: number;
  updatedAt: number;
  serverVersion: string | null;
}

// plan_exercises exists server-side (a trigger-maintained projection of
// plans.exercises used by RLS for indexable joins) but is never synced to
// Dexie — the client already has plans.exercises in the canonical shape.

export type SyncTableName =
  | 'plans' | 'sessions' | 'metrics' | 'favorites'
  | 'exercises' | 'exerciseBundles' | 'exerciseBundleItems'
  | 'shares' | 'trainerTrainees';
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
  exercises!: Table<CustomExercise, string>;
  exerciseBundles!: Table<ExerciseBundle, string>;
  exerciseBundleItems!: Table<ExerciseBundleItem, [string, string]>;
  shares!: Table<Share, string>;
  trainerTrainees!: Table<TrainerTrainee, [string, string]>;
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
    this.version(5).stores({
      plans:               'id, userId, weekStart, updatedAt, supersededBy',
      sessions:            'id, userId, planId, date, updatedAt',
      metrics:             'id, userId, date, updatedAt',
      favorites:           '[userId+exerciseId], userId, addedAt',
      exercises:           'id, ownerId, muscleGroup, updatedAt',
      exerciseBundles:     'id, ownerId, updatedAt',
      exerciseBundleItems: '[bundleId+exerciseId], bundleId, exerciseId, updatedAt',
      shares:              'id, recipientId, granterId, [resourceType+resourceId], updatedAt',
      trainerTrainees:     '[trainerId+traineeId], trainerId, traineeId, status, updatedAt',
      syncQueue:           '++seq, table, rowId',
      syncDeadLetter:      '++seq, table, rowId',
      syncMeta:            'key',
    }).upgrade(async (tx) => {
      // Pre-launch wipe — free-exercise-db slugs become exercise UUIDs;
      // every reference in plans/sessions/favorites is invalidated.
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
