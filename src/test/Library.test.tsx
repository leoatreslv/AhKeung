import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '../i18n';
import { Library } from '../pages/Library';
import { db } from '../db';
import { stubAuthenticatedUser } from './authStub';

function renderLibrary() {
  return render(
    <MemoryRouter>
      <I18nProvider>
        <Library />
      </I18nProvider>
    </MemoryRouter>,
  );
}

// PR 1 transitional: useExercises is stubbed to [] until PR 3 wires the
// new trainer-authored catalogue. These tests assert behaviour against the
// free-exercise-db fixture and will be replaced in PR 3 with assertions
// against an in-memory `db.exercises` seed. See W13 in
// docs/trainer-exercises-plan.md.
describe.skip('Library page [PR 1 stub — restored in PR 3]', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    stubAuthenticatedUser({ id: 'u-test' });
  });

  it('shows a loading state then renders the catalog', async () => {
    renderLibrary();
    // Wait for catalog to load
    await waitFor(() => {
      expect(screen.getByText('Barbell Bench Press - Medium Grip')).toBeInTheDocument();
    });
    // All fixtures should be visible initially (filter=all)
    expect(screen.getByText('Pullups')).toBeInTheDocument();
    expect(screen.getByText('Barbell Squat')).toBeInTheDocument();
  });

  it('filters by muscle group', async () => {
    renderLibrary();
    await waitFor(() => screen.getByText('Pullups'));

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    expect(screen.getByText('Pullups')).toBeInTheDocument();
    expect(screen.queryByText('Barbell Squat')).not.toBeInTheDocument();
    expect(screen.queryByText('Plank')).not.toBeInTheDocument();
  });

  it('matches search query against exercise names', async () => {
    renderLibrary();
    await waitFor(() => screen.getByText('Pullups'));

    fireEvent.change(screen.getByPlaceholderText(/Search exercises/i), {
      target: { value: 'squat' },
    });

    expect(screen.getByText('Barbell Squat')).toBeInTheDocument();
    expect(screen.queryByText('Pullups')).not.toBeInTheDocument();
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

    // Tap the now-filled star to remove the favourite.
    const filled = await screen.findByRole('button', { name: /Remove from favourites/i });
    fireEvent.click(filled);

    await waitFor(async () => {
      const favs = await db.favorites.toArray();
      expect(favs.length).toBe(0);
    });
  });

  it('expands an exercise to show instructions on tap', async () => {
    renderLibrary();
    await waitFor(() => screen.getByText('Barbell Squat'));

    fireEvent.click(screen.getByText('Barbell Squat'));

    expect(screen.getByText(/Step under the bar/)).toBeInTheDocument();
    expect(screen.getByText(/Stand back up/)).toBeInTheDocument();
  });
});
