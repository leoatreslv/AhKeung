import { describe, it, expect } from 'vitest';
import type { SyncTableName } from '../db';
import {
  DESCRIPTORS,
  descriptorFor,
  rowIdFromKey,
  keyFromRowId,
  rowIdFromClientRow,
  rowIdFromServerRow,
  applyServerKeyFilter,
} from './descriptors';

describe('sync descriptors', () => {
  it('covers every SyncTableName', () => {
    const tables: SyncTableName[] = ['plans', 'sessions', 'metrics', 'favorites'];
    for (const t of tables) {
      expect(descriptorFor(t).serverTable).toBe(t);
    }
  });

  it('encodes single PK rowIds verbatim', () => {
    const d = descriptorFor('plans');
    expect(rowIdFromKey(d, 'abc')).toBe('abc');
    expect(keyFromRowId(d, 'abc')).toBe('abc');
    expect(rowIdFromClientRow(d, { id: 'abc', userId: 'u' })).toBe('abc');
    expect(rowIdFromServerRow(d, { id: 'abc', user_id: 'u' })).toBe('abc');
  });

  it('encodes composite PK rowIds as "<a>:<b>"', () => {
    const d = descriptorFor('favorites');
    expect(rowIdFromKey(d, ['u-1', 'Pullups'])).toBe('u-1:Pullups');
    expect(keyFromRowId(d, 'u-1:Pullups')).toEqual(['u-1', 'Pullups']);
    expect(rowIdFromClientRow(d, { userId: 'u-1', exerciseId: 'Pullups' })).toBe('u-1:Pullups');
    expect(rowIdFromServerRow(d, { user_id: 'u-1', exercise_id: 'Pullups' })).toBe('u-1:Pullups');
  });

  it('throws on malformed composite rowId', () => {
    const d = descriptorFor('favorites');
    expect(() => keyFromRowId(d, 'no-colon-here')).toThrow();
  });

  it('throws on PK kind mismatch when encoding', () => {
    const single = descriptorFor('plans');
    const composite = descriptorFor('favorites');
    expect(() => rowIdFromKey(single, ['a', 'b'])).toThrow();
    expect(() => rowIdFromKey(composite, 'a')).toThrow();
  });

  it('applyServerKeyFilter uses single eq for single PK', () => {
    const calls: { col: string; val: unknown }[] = [];
    type Q = { eq: (c: string, v: unknown) => Q };
    const q: Q = { eq: (col, val) => { calls.push({ col, val }); return q; } };
    applyServerKeyFilter(descriptorFor('plans'), q, 'p1');
    expect(calls).toEqual([{ col: 'id', val: 'p1' }]);
  });

  it('applyServerKeyFilter uses compound eq for composite PK', () => {
    const calls: { col: string; val: unknown }[] = [];
    type Q = { eq: (c: string, v: unknown) => Q };
    const q: Q = { eq: (col, val) => { calls.push({ col, val }); return q; } };
    applyServerKeyFilter(descriptorFor('favorites'), q, 'u-1:Pullups');
    expect(calls).toEqual([
      { col: 'user_id', val: 'u-1' },
      { col: 'exercise_id', val: 'Pullups' },
    ]);
  });

  it('every descriptor has matching client/server PK field count', () => {
    for (const [name, d] of Object.entries(DESCRIPTORS)) {
      expect(d.pkClientFields.length, `${name} client fields`).toBe(d.pkServerFields.length);
      expect(d.pkClientFields.length).toBe(d.pkKind === 'single' ? 1 : 2);
    }
  });

  it('all PR 0 tables are own-only and owner-keyed', () => {
    for (const [name, d] of Object.entries(DESCRIPTORS)) {
      expect(d.writability, `${name} writability`).toBe('own-only');
      expect(d.pullPredicate.kind, `${name} pull`).toBe('owner');
    }
  });
});
