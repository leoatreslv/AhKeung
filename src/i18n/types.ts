import type { MuscleGroup } from '../db';

export type Locale = 'en' | 'zh-Hant';

export const LOCALES: { code: Locale; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'zh-Hant', label: '繁體中文' },
];

export interface Translation {
  appName: string;
  tagline: string;

  tabs: { home: string; plans: string; library: string; metrics: string };

  muscleGroup: Record<MuscleGroup, string>;

  common: {
    save: string;
    cancel: string;
    delete: string;
    edit: string;
    add: string;
    done: string;
    search: string;
    loading: string;
    all: string;
    yes: string;
    no: string;
    notes: string;
    date: string;
  };

  home: {
    thisWeek: string;
    noPlanThisWeek: string;
    createPlan: string;
    startWorkout: string;
    quickActions: string;
    freeWorkout: string;
    logWeight: string;
    latestMetric: string;
    weight: string;
    height: string;
    recentSessions: string;
    exercisesPlanned: (n: number) => string;
    sessionSummary: (exCount: number, setsDone: number) => string;
    noWorkouts: string;
  };

  plans: {
    title: string;
    newButton: string;
    weekOf: string;
    exerciseCount: (n: number) => string;
    noPlans: string;
    createFirst: string;
    start: string;
  };

  planEditor: {
    namePlaceholder: string;
    nameLabel: string;
    namePlaceholderExample: string;
    weekStarting: string;
    focusGroups: string;
    exercises: string;
    addExercise: string;
    noExercises: string;
    sets: string;
    reps: string;
    weightKg: string;
    savePlan: string;
    deleteConfirm: string;
    nameRequired: string;
    pickExercise: string;
    noMatch: string;
  };

  workout: {
    elapsed: string;
    progress: string;
    noExercises: string;
    set: string;
    weightUnit: string;
    addSet: string;
    addExercise: string;
    finish: string;
    discardConfirm: string;
    noSetsDoneConfirm: string;
    addExerciseTitle: string;
  };

  library: {
    searchPlaceholder: string;
    noMatch: string;
    instructions: string;
    level: string;
    primaryMuscles: string;
    secondaryMuscles: string;
    viewDetails: string;
    favorites: string;
    others: string;
    addToFavorites: string;
    removeFromFavorites: string;
  };

  metrics: {
    logEntry: string;
    weightKg: string;
    heightCm: string;
    bodyFatPct: string;
    enterValue: string;
    bmi: string;
    weightTrend: string;
    history: string;
    noEntries: string;
    deleteConfirm: string;
  };
}
