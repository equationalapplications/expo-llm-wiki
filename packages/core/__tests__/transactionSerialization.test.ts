import { describe, it, expect } from 'vitest';
import { extractSqliteCode, isDriverError } from '../src/db/serializedAdapter';
import { WikiTransactionError } from '../src/types';

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

describe('WikiTransactionError', () => {
  it('carries the cause and lifts the SQLite code to the top level', () => {
    const cause = { code: 'SQLITE_BUSY', message: 'db is busy' };
    const err = new WikiTransactionError('Transaction failed', { cause });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('WikiTransactionError');
    expect(err.cause).toBe(cause);
    expect(err.sqliteErrorCode).toBe('SQLITE_BUSY');
  });

  it('leaves sqliteErrorCode undefined when the code cannot be parsed', () => {
    const err = new WikiTransactionError('Transaction failed', { cause: new Error('opaque') });
    expect(err.sqliteErrorCode).toBeUndefined();
  });
});
