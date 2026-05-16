import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '../i18n';
import { Library } from '../pages/Library';
import { __resetExercisesForTest } from '../exercises';

function renderLibrary() {
  return render(
    <MemoryRouter>
      <I18nProvider>
        <Library />
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe('Library page', () => {
  beforeEach(() => {
    __resetExercisesForTest();
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

  it('expands an exercise to show instructions on tap', async () => {
    renderLibrary();
    await waitFor(() => screen.getByText('Barbell Squat'));

    fireEvent.click(screen.getByText('Barbell Squat'));

    expect(screen.getByText(/Step under the bar/)).toBeInTheDocument();
    expect(screen.getByText(/Stand back up/)).toBeInTheDocument();
  });
});
