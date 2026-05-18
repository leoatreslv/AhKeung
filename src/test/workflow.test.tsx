import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { I18nProvider } from '../i18n';
import { AuthProvider } from '../auth/AuthProvider';
import { PlanEditor } from '../pages/PlanEditor';
import { Workout } from '../pages/Workout';
import { db } from '../db';
import { __resetExercisesForTest } from '../exercises';
import { stubAuthenticatedUser } from './authStub';

function renderRoute(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <I18nProvider>
          <Routes>
            <Route path="/plans/new" element={<PlanEditor />} />
            <Route path="/plans/:id" element={<PlanEditor />} />
            <Route path="/workout/:planId" element={<Workout />} />
            <Route path="/plans" element={<div>plans-list</div>} />
            <Route path="/" element={<div>home</div>} />
          </Routes>
        </I18nProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  __resetExercisesForTest();
  await db.delete();
  await db.open();
  stubAuthenticatedUser({ id: 'u-test' });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(window, 'alert').mockImplementation(() => {});
});

// PR 1 transitional: this flow picks an exercise from the free-exercise-db
// catalogue, which is now empty (useExercises stubbed to []). PR 3 will
// restore the test by seeding db.exercises with an authored exercise and
// having the picker draw from there. See W13 in the design doc.
describe.skip('plan → workout flow [PR 1 stub — restored in PR 3]', () => {
  // Heavy: AuthProvider bootstrap + two MemoryRouter renders + several waitFor polls.
  // Default 5s vitest timeout is too tight under full-suite parallelism.
  it('creates a plan, persists it, then runs a workout against it', { timeout: 15000 }, async () => {
    renderRoute('/plans/new');
    // Wait for AuthProvider's async bootstrap to flip status → 'authenticated'.
    // The Save Plan button is rendered unconditionally by PlanEditor, but our
    // putWithSync call inside `save` short-circuits while userId is null,
    // so wait until useCurrentUserId resolves before interacting.
    await waitFor(() => screen.getByRole('button', { name: /Chest/ }));

    fireEvent.change(screen.getByPlaceholderText(/Push\/Pull/), { target: { value: 'Chest Day' } });
    fireEvent.click(screen.getByRole('button', { name: 'Chest' }));
    fireEvent.click(screen.getByRole('button', { name: '+ Add' }));
    await waitFor(() => screen.getByText('Pick an exercise'));
    fireEvent.click(screen.getByText('Barbell Bench Press - Medium Grip'));

    // Save can race with auth bootstrap: poll until the navigation happens.
    fireEvent.click(screen.getByRole('button', { name: /Save Plan/ }));
    await waitFor(async () => {
      const plans = await db.plans.toArray();
      expect(plans.length).toBeGreaterThan(0);
    }, { timeout: 2000 });
    await waitFor(() => screen.getByText('plans-list'));

    const plans = await db.plans.toArray();
    expect(plans).toHaveLength(1);
    expect(plans[0].name).toBe('Chest Day');
    expect(typeof plans[0].id).toBe('string');
    expect(plans[0].userId).toBe('u-test');
    expect(plans[0].exercises[0].exerciseId).toBe('Barbell_Bench_Press_-_Medium_Grip');

    const queued = await db.syncQueue.toArray();
    expect(queued.some((q) => q.table === 'plans' && q.rowId === plans[0].id)).toBe(true);

    const planId = plans[0].id;
    renderRoute(`/workout/${planId}`);
    await waitFor(() => screen.getByText('Barbell Bench Press - Medium Grip'));

    const doneButtons = screen.getAllByRole('button').filter((b) => b.textContent === '○');
    expect(doneButtons.length).toBeGreaterThanOrEqual(3);
    fireEvent.click(doneButtons[0]);

    fireEvent.click(screen.getByRole('button', { name: /Finish Workout/ }));

    await waitFor(async () => {
      const sessions = await db.sessions.toArray();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].planId).toBe(planId);
    });
  });
});

describe('metrics persistence', () => {
  it('saves a body metric entry that survives a reload', async () => {
    const id = 'metric-1';
    await db.metrics.put({
      id, userId: 'u-test', updatedAt: Date.now(), serverVersion: null,
      date: '2025-03-15', weightKg: 78.5, heightCm: 178,
    });
    const got = await db.metrics.get(id);
    expect(got?.weightKg).toBe(78.5);
    expect(got?.heightCm).toBe(178);
  });
});
