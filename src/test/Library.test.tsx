import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '../i18n';
import { Library } from '../pages/Library';
import { db } from '../db';
import { stubAuthenticatedUser } from './authStub';

const UID = 'u-test';

function renderLibrary() {
  return render(
    <MemoryRouter>
      <I18nProvider>
        <Library />
      </I18nProvider>
    </MemoryRouter>,
  );
}

async function seedExercises() {
  await db.exercises.bulkPut([
    {
      id: 'ex-bench', ownerId: UID,
      nameEn: 'Bench Press', nameZh: '臥推',
      muscleGroup: 'chest', equipment: 'barbell', instructions: 'Lie on bench.',
      imagePath: null, createdAt: 1, updatedAt: 1, serverVersion: null,
    },
    {
      id: 'ex-pull', ownerId: UID,
      nameEn: 'Pullups', nameZh: '引體向上',
      muscleGroup: 'back', equipment: 'bodyweight', instructions: 'Hang and pull.',
      imagePath: null, createdAt: 2, updatedAt: 1, serverVersion: null,
    },
    {
      id: 'ex-squat', ownerId: UID,
      nameEn: 'Squat', nameZh: '深蹲',
      muscleGroup: 'legs', equipment: 'barbell', instructions: 'Hips back.',
      imagePath: null, createdAt: 3, updatedAt: 1, serverVersion: null,
    },
  ]);
}

describe('Library page', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    stubAuthenticatedUser({ id: UID });
    await seedExercises();
  });

  it('renders the catalogue from db.exercises', async () => {
    renderLibrary();
    await waitFor(() => {
      expect(screen.getByText('Bench Press')).toBeInTheDocument();
    });
    expect(screen.getByText('Pullups')).toBeInTheDocument();
    expect(screen.getByText('Squat')).toBeInTheDocument();
  });

  it('filters by muscle group', async () => {
    renderLibrary();
    await waitFor(() => screen.getByText('Pullups'));

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    expect(screen.getByText('Pullups')).toBeInTheDocument();
    expect(screen.queryByText('Squat')).not.toBeInTheDocument();
    expect(screen.queryByText('Bench Press')).not.toBeInTheDocument();
  });

  it('search matches both English and Chinese names', async () => {
    renderLibrary();
    await waitFor(() => screen.getByText('Pullups'));

    fireEvent.change(screen.getByPlaceholderText(/Search exercises/i), {
      target: { value: 'squat' },
    });

    expect(screen.getByText('Squat')).toBeInTheDocument();
    expect(screen.queryByText('Pullups')).not.toBeInTheDocument();

    // Chinese substring hits the Chinese name.
    fireEvent.change(screen.getByPlaceholderText(/Search exercises/i), {
      target: { value: '引體' },
    });
    expect(screen.getByText('Pullups')).toBeInTheDocument();
    expect(screen.queryByText('Squat')).not.toBeInTheDocument();
  });

  it('toggles a favorite when the star is tapped', async () => {
    renderLibrary();
    await waitFor(() => screen.getByText('Pullups'));

    const starBtns = screen.getAllByRole('button', { name: /Add to favourites/i });
    expect(starBtns.length).toBeGreaterThan(0);
    fireEvent.click(starBtns[0]);

    await waitFor(async () => {
      const favs = await db.favorites.toArray();
      expect(favs.length).toBe(1);
    });

    const filled = await screen.findByRole('button', { name: /Remove from favourites/i });
    fireEvent.click(filled);

    await waitFor(async () => {
      const favs = await db.favorites.toArray();
      expect(favs.length).toBe(0);
    });
  });

  it('expands an exercise to show instructions on tap', async () => {
    renderLibrary();
    await waitFor(() => screen.getByText('Squat'));

    fireEvent.click(screen.getByText('Squat'));

    expect(screen.getByText(/Hips back/)).toBeInTheDocument();
  });
});
