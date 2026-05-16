import { useEffect, useState } from 'react';
import { loadExercises, type ExerciseMeta } from './exercises';

let shared: ExerciseMeta[] | null = null;
const listeners = new Set<(list: ExerciseMeta[]) => void>();

loadExercises().then((list) => {
  shared = list;
  listeners.forEach((l) => l(list));
});

export function useExercises(): ExerciseMeta[] | null {
  const [list, setList] = useState<ExerciseMeta[] | null>(shared);
  useEffect(() => {
    if (shared) return;
    const l = (next: ExerciseMeta[]) => setList(next);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return list;
}

export function useExercise(id: string | undefined): ExerciseMeta | undefined {
  const all = useExercises();
  if (!all || !id) return undefined;
  return all.find((e) => e.id === id);
}
