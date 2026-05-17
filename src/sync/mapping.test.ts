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
});
