import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/version';

describe('VERSION', () => {
  it('is a semver string or the dev sentinel', () => {
    expect(VERSION).toMatch(/^(\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?|0\.0\.0-dev)$/);
  });
});
