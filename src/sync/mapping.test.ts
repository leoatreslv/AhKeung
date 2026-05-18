import { describe, it, expect } from 'vitest';
import { toServerRow, fromServerRow } from './mapping';

describe('mapping', () => {
  it('camelCase → snake_case for outbound rows; epoch ms → ISO for *_at timestamps', () => {
    expect(toServerRow({ id: 'a', userId: 'u', updatedAt: 1, weekStart: '2025-01-01' }))
      .toEqual({
        id: 'a', user_id: 'u',
        updated_at: '1970-01-01T00:00:00.001Z',
        week_start: '2025-01-01',
      });
  });

  it('snake_case → camelCase for inbound rows; ISO → epoch ms for *_at timestamps', () => {
    expect(fromServerRow({
      id: 'a', user_id: 'u', updated_at: '2025-01-01T00:00:00.000Z',
      week_start: '2025-01-01', deleted_at: null, body_fat_pct: 18.5,
    })).toEqual({
      id: 'a', userId: 'u',
      updatedAt: Date.parse('2025-01-01T00:00:00.000Z'),
      weekStart: '2025-01-01', deletedAt: null, bodyFatPct: 18.5,
    });
  });

  it('ignores unknown inbound fields silently (forward-compatible)', () => {
    const out = fromServerRow({ id: 'a', user_id: 'u', updated_at: '2025-01-01T00:00:00.000Z', new_field_from_future: 'x' }, 'plans');
    expect(out).not.toHaveProperty('newFieldFromFuture');
    expect(out).not.toHaveProperty('new_field_from_future');
  });

  it('strips serverVersion from outbound (client-only field)', () => {
    expect(toServerRow({ id: 'a', userId: 'u', updatedAt: 1, serverVersion: 'iso' }))
      .toEqual({ id: 'a', user_id: 'u', updated_at: '1970-01-01T00:00:00.001Z' });
  });

  it('leaves non-numeric outbound timestamps alone (e.g. ISO already)', () => {
    expect(toServerRow({ id: 'a', updatedAt: '2025-01-01T00:00:00.000Z' }))
      .toEqual({ id: 'a', updated_at: '2025-01-01T00:00:00.000Z' });
  });

  // Regression: trainer_trainees was added in PR 1 with two new
  // timestamp columns (designated_at, responded_at) but they weren't
  // in the timestamp-field whitelist. PostgREST then rejected pushes
  // with "date/time field value out of range" because the epoch-ms
  // numbers were being sent unconverted. This test guards every
  // *_at column we have today.
  it('converts every *_at field used by current tables', () => {
    const out = toServerRow({
      id: 'a',
      createdAt: 1, updatedAt: 2, deletedAt: 3,
      startedAt: 4, endedAt: 5, addedAt: 6,
      designatedAt: 7, respondedAt: 8,
    });
    for (const [k, v] of Object.entries(out)) {
      if (k.endsWith('_at')) {
        expect(typeof v, `${k} should be ISO string`).toBe('string');
        expect(v as string).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      }
    }
  });

  it('inbound *_at conversion covers designated_at + responded_at too', () => {
    const out = fromServerRow({
      id: 'a',
      designated_at: '2025-01-01T00:00:00.000Z',
      responded_at:  '2025-01-02T00:00:00.000Z',
    });
    expect(typeof out.designatedAt).toBe('number');
    expect(typeof out.respondedAt).toBe('number');
  });
});
