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

  it('PR 0 tables remain own-only + owner-keyed pull', () => {
    const pr0: SyncTableName[] = ['plans', 'sessions', 'metrics', 'favorites'];
    for (const t of pr0) {
      const d = descriptorFor(t);
      expect(d.writability, `${t} writability`).toBe('own-only');
      expect(d.pullPredicate.kind, `${t} pull`).toBe('owner');
    }
  });

  it('PR 1 owner-table descriptors pull via rls-only (so shared-in rows arrive too)', () => {
    const sharedIn: SyncTableName[] = ['exercises', 'exerciseBundles'];
    for (const t of sharedIn) {
      const d = descriptorFor(t);
      expect(d.pullPredicate.kind, `${t} pull`).toBe('rls-only');
      // ownerField is independent of user_id naming
      expect(d.ownerServerField).toBe('owner_id');
      expect(d.ownerClientField).toBe('ownerId');
    }
  });

  it('shares descriptor uses granter as owner', () => {
    const d = descriptorFor('shares');
    expect(d.ownerClientField).toBe('granterId');
    expect(d.ownerServerField).toBe('granter_id');
    expect(d.pullPredicate.kind).toBe('rls-only');
  });

  it('trainerTrainees descriptor: composite PK with trainer as owner', () => {
    const d = descriptorFor('trainerTrainees');
    expect(d.pkKind).toBe('composite');
    expect(d.pkClientFields).toEqual(['trainerId', 'traineeId']);
    expect(d.pkServerFields).toEqual(['trainer_id', 'trainee_id']);
    expect(d.ownerClientField).toBe('trainerId');
  });

  it('exerciseBundleItems descriptor: composite PK, rls-only pull', () => {
    const d = descriptorFor('exerciseBundleItems');
    expect(d.pkKind).toBe('composite');
    expect(d.pkServerFields).toEqual(['bundle_id', 'exercise_id']);
    expect(d.pullPredicate.kind).toBe('rls-only');
  });
});
