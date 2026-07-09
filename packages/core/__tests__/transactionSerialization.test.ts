import { describe, it, expect } from 'vitest';
import { extractSqliteCode, isDriverError } from '../src/db/serializedAdapter';

describe('extractSqliteCode', () => {
  it('reads the string SQLITE_ code from better-sqlite3 / node:sqlite errors', () => {
    expect(extractSqliteCode({ code: 'SQLITE_BUSY' })).toBe('SQLITE_BUSY');
  });

  it('parses the numeric code from an expo-sqlite message', () => {
    expect(extractSqliteCode({ message: 'Error code 1: cannot start a transaction within a transaction' }))
      .toBe('SQLITE_1');
  });

  it('returns undefined for a non-driver error', () => {
    expect(extractSqliteCode(new Error('validation failed'))).toBeUndefined();
    expect(extractSqliteCode(null)).toBeUndefined();
    expect(extractSqliteCode('nope')).toBeUndefined();
  });
});

describe('isDriverError', () => {
  it('is true only when a SQLite code can be extracted', () => {
    expect(isDriverError({ code: 'SQLITE_BUSY' })).toBe(true);
    expect(isDriverError({ message: 'Error code 5: database is locked' })).toBe(true);
    expect(isDriverError(new Error('validation failed'))).toBe(false);
  });
});
