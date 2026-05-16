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

export interface Plan {
  id?: number;
  name: string;
  weekStart: string;
  focus: MuscleGroup[];
  exercises: PlanExercise[];
  createdAt: number;
}

export interface SetLog {
  reps: number;
  weight: number;
  done: boolean;
}

export interface WorkoutSession {
  id?: number;
  planId?: number;
  date: string;
  exercises: { exerciseId: string; sets: SetLog[] }[];
  notes?: string;
  startedAt: number;
  endedAt?: number;
}

export interface BodyMetric {
  id?: number;
  date: string;
  weightKg?: number;
  heightCm?: number;
  bodyFatPct?: number;
  notes?: string;
}

class AhKeungDB extends Dexie {
  plans!: Table<Plan, number>;
  sessions!: Table<WorkoutSession, number>;
  metrics!: Table<BodyMetric, number>;

  constructor() {
    super('ah-keung');
    this.version(1).stores({
      plans: '++id, weekStart, createdAt',
      sessions: '++id, planId, date, startedAt',
      metrics: '++id, date',
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
