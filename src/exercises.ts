import type { MuscleGroup } from './db';

export interface ExerciseMeta {
  id: string;
  muscleGroup: MuscleGroup;
  equipment: string;
  emoji: string;
}

export const exercises: ExerciseMeta[] = [
  // Chest
  { id: 'bench-press', muscleGroup: 'chest', equipment: 'Barbell', emoji: '🏋️' },
  { id: 'incline-db-press', muscleGroup: 'chest', equipment: 'Dumbbells', emoji: '💪' },
  { id: 'push-up', muscleGroup: 'chest', equipment: 'Bodyweight', emoji: '🤸' },
  { id: 'chest-fly', muscleGroup: 'chest', equipment: 'Cable/Dumbbells', emoji: '🦋' },
  { id: 'dips-chest', muscleGroup: 'chest', equipment: 'Dip Bars', emoji: '🧗' },

  // Back
  { id: 'pull-up', muscleGroup: 'back', equipment: 'Pull-Up Bar', emoji: '🧗‍♂️' },
  { id: 'lat-pulldown', muscleGroup: 'back', equipment: 'Cable Machine', emoji: '🪢' },
  { id: 'bent-over-row', muscleGroup: 'back', equipment: 'Barbell', emoji: '🏋️‍♂️' },
  { id: 'seated-cable-row', muscleGroup: 'back', equipment: 'Cable Machine', emoji: '🚣' },
  { id: 'deadlift', muscleGroup: 'back', equipment: 'Barbell', emoji: '⚡' },
  { id: 'face-pull', muscleGroup: 'back', equipment: 'Cable Machine', emoji: '😤' },

  // Shoulders
  { id: 'overhead-press', muscleGroup: 'shoulders', equipment: 'Barbell', emoji: '🆙' },
  { id: 'db-shoulder-press', muscleGroup: 'shoulders', equipment: 'Dumbbells', emoji: '💪' },
  { id: 'lateral-raise', muscleGroup: 'shoulders', equipment: 'Dumbbells', emoji: '🦅' },
  { id: 'rear-delt-fly', muscleGroup: 'shoulders', equipment: 'Dumbbells', emoji: '🪶' },

  // Biceps
  { id: 'barbell-curl', muscleGroup: 'biceps', equipment: 'Barbell', emoji: '💪' },
  { id: 'hammer-curl', muscleGroup: 'biceps', equipment: 'Dumbbells', emoji: '🔨' },
  { id: 'preacher-curl', muscleGroup: 'biceps', equipment: 'Preacher Bench', emoji: '🛐' },

  // Triceps
  { id: 'tricep-pushdown', muscleGroup: 'triceps', equipment: 'Cable Machine', emoji: '⬇️' },
  { id: 'skull-crusher', muscleGroup: 'triceps', equipment: 'EZ-Bar', emoji: '💀' },
  { id: 'tricep-dip', muscleGroup: 'triceps', equipment: 'Dip Bars', emoji: '⬇️' },

  // Legs
  { id: 'back-squat', muscleGroup: 'legs', equipment: 'Barbell', emoji: '🏋️' },
  { id: 'front-squat', muscleGroup: 'legs', equipment: 'Barbell', emoji: '🏋️‍♀️' },
  { id: 'leg-press', muscleGroup: 'legs', equipment: 'Leg Press Machine', emoji: '🦵' },
  { id: 'lunge', muscleGroup: 'legs', equipment: 'Dumbbells', emoji: '🚶' },
  { id: 'leg-curl', muscleGroup: 'legs', equipment: 'Leg Curl Machine', emoji: '🦵' },
  { id: 'calf-raise', muscleGroup: 'legs', equipment: 'Machine/Bodyweight', emoji: '🦶' },

  // Glutes
  { id: 'hip-thrust', muscleGroup: 'glutes', equipment: 'Barbell + Bench', emoji: '🍑' },
  { id: 'glute-bridge', muscleGroup: 'glutes', equipment: 'Bodyweight', emoji: '🌉' },
  { id: 'romanian-deadlift', muscleGroup: 'glutes', equipment: 'Barbell', emoji: '⚡' },

  // Core
  { id: 'plank', muscleGroup: 'core', equipment: 'Bodyweight', emoji: '🧘' },
  { id: 'hanging-leg-raise', muscleGroup: 'core', equipment: 'Pull-Up Bar', emoji: '🙆' },
  { id: 'cable-crunch', muscleGroup: 'core', equipment: 'Cable Machine', emoji: '🙇' },
  { id: 'russian-twist', muscleGroup: 'core', equipment: 'Plate/Bodyweight', emoji: '🌀' },

  // Cardio
  { id: 'treadmill', muscleGroup: 'cardio', equipment: 'Treadmill', emoji: '🏃' },
  { id: 'rowing', muscleGroup: 'cardio', equipment: 'Rower', emoji: '🚣' },
  { id: 'bike', muscleGroup: 'cardio', equipment: 'Bike', emoji: '🚴' },
];

export const exerciseById = (id: string) => exercises.find((e) => e.id === id);
