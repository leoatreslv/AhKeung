import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { I18nProvider } from '../i18n';
import { PlanEditor } from '../pages/PlanEditor';
import { Workout } from '../pages/Workout';
import { db } from '../db';
import { __resetExercisesForTest } from '../exercises';

function renderRoute(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <I18nProvider>
        <Routes>
          <Route path="/plans/new" element={<PlanEditor />} />
          <Route path="/plans/:id" element={<PlanEditor />} />
          <Route path="/workout/:planId" element={<Workout />} />
          <Route path="/plans" element={<div>plans-list</div>} />
          <Route path="/" element={<div>home</div>} />
        </Routes>
      </I18nProvider>
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  __resetExercisesForTest();
  await db.delete();
  await db.open();
  // Suppress jsdom confirm() — auto-accept everything
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(window, 'alert').mockImplementation(() => {});
});

describe('plan → workout flow', () => {
  it('creates a plan, persists it, then runs a workout against it', async () => {
    // 1) Create a plan
    renderRoute('/plans/new');
    await waitFor(() => screen.getByRole('button', { name: /Chest/ }));

    fireEvent.change(screen.getByPlaceholderText(/Push\/Pull/), {
      target: { value: 'Chest Day' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Chest' }));
    fireEvent.click(screen.getByRole('button', { name: '+ Add' }));
    await waitFor(() => screen.getByText('Pick an exercise'));
    fireEvent.click(screen.getByText('Barbell Bench Press - Medium Grip'));

    fireEvent.click(screen.getByRole('button', { name: /Save Plan/ }));

    await waitFor(() => screen.getByText('plans-list'));

    // 2) Confirm the plan persisted
    const plans = await db.plans.toArray();
    expect(plans).toHaveLength(1);
    expect(plans[0].name).toBe('Chest Day');
    expect(plans[0].focus).toContain('chest');
    expect(plans[0].exercises[0].exerciseId).toBe('Barbell_Bench_Press_-_Medium_Grip');

    // 3) Start a workout against that plan
    const planId = plans[0].id!;
    renderRoute(`/workout/${planId}`);
    await waitFor(() => screen.getByText('Barbell Bench Press - Medium Grip'));

    // The plan had 3 default sets — mark the first one done
    const doneButtons = screen.getAllByRole('button').filter((b) => b.textContent === '○');
    expect(doneButtons.length).toBeGreaterThanOrEqual(3);
    fireEvent.click(doneButtons[0]);

    fireEvent.click(screen.getByRole('button', { name: /Finish Workout/ }));

    // 4) Confirm the session was saved
    await waitFor(async () => {
      const sessions = await db.sessions.toArray();
      expect(sessions).toHaveLength(1);
      const completed = sessions[0].exercises[0].sets.filter((s) => s.done).length;
      expect(completed).toBe(1);
      expect(sessions[0].planId).toBe(planId);
    });
  });
});

describe('metrics persistence', () => {
  it('saves a body metric entry that survives a reload', async () => {
    const id = await db.metrics.add({
      date: '2025-03-15',
      weightKg: 78.5,
      heightCm: 178,
    });
    const got = await db.metrics.get(id);
    expect(got?.weightKg).toBe(78.5);
    expect(got?.heightCm).toBe(178);
  });
});
