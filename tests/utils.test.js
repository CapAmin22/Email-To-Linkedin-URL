// tests/utils.test.js — Unit tests for lib/utils.js
import { describe, it, expect } from 'vitest';
import {
  normalizeLinkedInUrl,
  isRoleBasedEmail,
  isNumericLocalPart,
  preQaChecks,
  md5,
  randomJitter,
  sleep,
} from '../lib/utils.js';

// --- normalizeLinkedInUrl ---
describe('normalizeLinkedInUrl', () => {
  it('normalizes a standard URL', () => {
    expect(normalizeLinkedInUrl('https://www.linkedin.com/in/johndoe'))
      .toBe('https://www.linkedin.com/in/johndoe/');
  });

  it('keeps existing trailing slash', () => {
    expect(normalizeLinkedInUrl('https://www.linkedin.com/in/johndoe/'))
      .toBe('https://www.linkedin.com/in/johndoe/');
  });

  it('strips query string', () => {
    expect(normalizeLinkedInUrl('https://www.linkedin.com/in/johndoe?trk=abc'))
      .toBe('https://www.linkedin.com/in/johndoe/');
  });

  it('strips hash', () => {
    expect(normalizeLinkedInUrl('https://www.linkedin.com/in/johndoe#section'))
      .toBe('https://www.linkedin.com/in/johndoe/');
  });

  it('handles linkedin.com without www', () => {
    expect(normalizeLinkedInUrl('https://linkedin.com/in/johndoe'))
      .toBe('https://www.linkedin.com/in/johndoe/');
  });

  it('returns null for non-LinkedIn URL', () => {
    expect(normalizeLinkedInUrl('https://twitter.com/johndoe')).toBeNull();
  });

  it('returns null for LinkedIn company page', () => {
    expect(normalizeLinkedInUrl('https://www.linkedin.com/company/google')).toBeNull();
  });

  it('returns null for invalid URL', () => {
    expect(normalizeLinkedInUrl('not-a-url')).toBeNull();
  });

  it('returns null for LinkedIn feed/home', () => {
    expect(normalizeLinkedInUrl('https://www.linkedin.com/feed/')).toBeNull();
  });
});

// --- isRoleBasedEmail ---
describe('isRoleBasedEmail', () => {
  const rolePrefixes = [
    'info', 'sales', 'support', 'admin', 'contact',
    'hello', 'help', 'team', 'office', 'marketing',
    'billing', 'accounts', 'hr', 'careers', 'press',
    'media', 'legal', 'compliance', 'noreply', 'no-reply',
  ];

  for (const prefix of rolePrefixes) {
    it(`detects role-based: ${prefix}@company.com`, () => {
      expect(isRoleBasedEmail(`${prefix}@company.com`)).toBe(true);
    });
  }

  it('returns false for a person email', () => {
    expect(isRoleBasedEmail('john.doe@company.com')).toBe(false);
  });

  it('returns false for firstname.lastname@domain', () => {
    expect(isRoleBasedEmail('elon.musk@tesla.com')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isRoleBasedEmail('INFO@COMPANY.COM')).toBe(true);
  });
});

// --- isNumericLocalPart ---
describe('isNumericLocalPart', () => {
  it('detects numeric local part', () => {
    expect(isNumericLocalPart('12345@company.com')).toBe(true);
  });

  it('returns false for regular email', () => {
    expect(isNumericLocalPart('john@company.com')).toBe(false);
  });

  it('returns false for alphanumeric', () => {
    expect(isNumericLocalPart('john123@company.com')).toBe(false);
  });
});

// --- preQaChecks ---
describe('preQaChecks', () => {
  it('fails on "LinkedIn Member"', () => {
    const result = preQaChecks('LinkedIn Member');
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/private profile/i);
  });

  it('fails on "LinkedIn Member" with extra spaces', () => {
    const result = preQaChecks('  LinkedIn Member  ');
    expect(result.pass).toBe(false);
  });

  it('fails on "LinkedIn" alone', () => {
    const result = preQaChecks('LinkedIn');
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/generic/i);
  });

  it('fails on empty title', () => {
    const result = preQaChecks('');
    expect(result.pass).toBe(false);
  });

  it('passes a valid title', () => {
    const result = preQaChecks('John Doe - Senior Engineer at Tesla');
    expect(result.pass).toBe(true);
  });

  it('passes title with real name and dash', () => {
    const result = preQaChecks('Elon Musk - CEO at Tesla');
    expect(result.pass).toBe(true);
  });
});

// --- md5 ---
describe('md5', () => {
  it('returns 32-char hex string', () => {
    const hash = md5('test@example.com');
    expect(hash).toHaveLength(32);
    expect(hash).toMatch(/^[a-f0-9]+$/);
  });

  it('is deterministic', () => {
    expect(md5('test@example.com')).toBe(md5('test@example.com'));
  });

  it('differs for different inputs', () => {
    expect(md5('a@b.com')).not.toBe(md5('c@d.com'));
  });
});

// --- randomJitter ---
describe('randomJitter', () => {
  it('returns value within default range [3000, 8000]', () => {
    for (let i = 0; i < 20; i++) {
      const j = randomJitter();
      expect(j).toBeGreaterThanOrEqual(3000);
      expect(j).toBeLessThanOrEqual(8000);
    }
  });

  it('respects custom range', () => {
    for (let i = 0; i < 20; i++) {
      const j = randomJitter(100, 200);
      expect(j).toBeGreaterThanOrEqual(100);
      expect(j).toBeLessThanOrEqual(200);
    }
  });
});
