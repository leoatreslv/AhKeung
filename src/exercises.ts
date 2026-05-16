import type { MuscleGroup } from './db';

export interface RawExercise {
  id: string;
  name: string;
  force: string | null;
  level: string | null;
  mechanic: string | null;
  equipment: string | null;
  primaryMuscles: string[];
  secondaryMuscles: string[];
  instructions: string[];
  category: string;
  images: string[];
}

export interface ExerciseMeta {
  id: string;
  name: string;
  muscleGroup: MuscleGroup;
  equipment: string;
  images: string[];
  instructions: string[];
  primaryMuscles: string[];
  secondaryMuscles: string[];
  level: string | null;
  category: string;
}

const MUSCLE_TO_GROUP: Record<string, MuscleGroup> = {
  chest: 'chest',
  lats: 'back',
  'middle back': 'back',
  'lower back': 'back',
  traps: 'back',
  shoulders: 'shoulders',
  neck: 'shoulders',
  biceps: 'biceps',
  forearms: 'biceps',
  triceps: 'triceps',
  quadriceps: 'legs',
  hamstrings: 'legs',
  calves: 'legs',
  adductors: 'legs',
  abductors: 'legs',
  glutes: 'glutes',
  abdominals: 'core',
};

const classify = (raw: RawExercise): MuscleGroup => {
  if (raw.category === 'cardio') return 'cardio';
  for (const m of raw.primaryMuscles) {
    const g = MUSCLE_TO_GROUP[m];
    if (g) return g;
  }
  return 'core';
};

const normalize = (raw: RawExercise): ExerciseMeta => ({
  id: raw.id,
  name: raw.name,
  muscleGroup: classify(raw),
  equipment: raw.equipment ?? 'bodyweight',
  images: raw.images ?? [],
  instructions: raw.instructions ?? [],
  primaryMuscles: raw.primaryMuscles ?? [],
  secondaryMuscles: raw.secondaryMuscles ?? [],
  level: raw.level,
  category: raw.category,
});

let cache: ExerciseMeta[] | null = null;
let inflight: Promise<ExerciseMeta[]> | null = null;

export async function loadExercises(): Promise<ExerciseMeta[]> {
  if (cache) return cache;
  if (inflight) return inflight;
  inflight = fetch(`${import.meta.env.BASE_URL}exercises.json`)
    .then((r) => r.json())
    .then((arr: RawExercise[]) => {
      cache = arr.map(normalize).sort((a, b) => a.name.localeCompare(b.name));
      inflight = null;
      return cache;
    });
  return inflight;
}

export const exerciseById = (id: string) => cache?.find((e) => e.id === id);

export const imageUrl = (path: string) =>
  `https://cdn.jsdelivr.net/gh/yuhonas/free-exercise-db@main/exercises/${path}`;
