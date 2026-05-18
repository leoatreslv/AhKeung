import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { I18nProvider } from '../i18n';
import { AuthProvider } from '../auth/AuthProvider';
import { ExerciseEditor } from '../pages/ExerciseEditor';
import { MyExercises } from '../pages/MyExercises';
import { db } from '../db';
import { stubAuthenticatedUser } from './authStub';

const UID = 'u-trainer';

function renderRoute(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <I18nProvider>
          <Routes>
            <Route path="/exercises/new" element={<ExerciseEditor />} />
            <Route path="/exercises/:id" element={<ExerciseEditor />} />
            <Route path="/exercises" element={<MyExercises />} />
          </Routes>
        </I18nProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  await db.delete();
  await db.open();
  stubAuthenticatedUser({ id: UID, isTrainer: true });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('exercise editor', () => {
  it('creates a new exercise and queues a sync insert', async () => {
    renderRoute('/exercises/new');

    // Wait for the editor to mount (auth bootstrap is async).
    await screen.findByText('New exercise');

    const enInput = screen.getAllByPlaceholderText(/Barbell Bench Press|槓鈴臥推/)[0];
    fireEvent.change(enInput, { target: { value: 'Bench Press' } });
    fireEvent.click(screen.getByRole('button', { name: 'Chest' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(async () => {
      const rows = await db.exercises.toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0].nameEn).toBe('Bench Press');
      expect(rows[0].muscleGroup).toBe('chest');
      expect(rows[0].ownerId).toBe(UID);
    });

    const queue = await db.syncQueue.toArray();
    const inserts = queue.filter((q) => q.table === 'exercises' && q.op === 'insert');
    expect(inserts).toHaveLength(1);
  });

  it('requires at least one language name', async () => {
    renderRoute('/exercises/new');
    await screen.findByText('New exercise');
    fireEvent.click(screen.getByRole('button', { name: 'Chest' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText(/at least one language/i)).toBeInTheDocument();
    expect(await db.exercises.count()).toBe(0);
  });

  it('requires a muscle group', async () => {
    renderRoute('/exercises/new');
    await screen.findByText('New exercise');
    const enInput = screen.getAllByPlaceholderText(/Barbell Bench Press|槓鈴臥推/)[0];
    fireEvent.change(enInput, { target: { value: 'Mystery' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText(/Please pick a muscle group/i)).toBeInTheDocument();
    expect(await db.exercises.count()).toBe(0);
  });
});
