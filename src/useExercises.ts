// Live query over the trainer-authored exercise catalogue. Returns every
// row the current user can read — owner rows plus shared-in rows the
// server's RLS exercises_read policy allows through. The picker filters
// further (favourites, muscle group, search).
//
// PR 1 stubbed this to []. PR 2 wires it to Dexie. PR 3 populates
// db.exercises through the new exercise editor.

import { useLiveQuery } from 'dexie-react-hooks';
import { db, type CustomExercise } from './db';

export function useExercises(): CustomExercise[] | null {
  const list = useLiveQuery(
    () => db.exercises.filter((e) => !e.deletedAt).toArray(),
    [],
  );
  return list ?? null;
}

export function useExercise(id: string | undefined): CustomExercise | undefined {
  const list = useExercises();
  if (!list || !id) return undefined;
  return list.find((e) => e.id === id);
}
