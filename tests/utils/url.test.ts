import { describe, expect, it } from 'vitest';
import { httpUrlSchema } from '../../src/utils/url';

describe('httpUrlSchema', () => {
  it('accepts http and https URLs', () => {
    expect(httpUrlSchema().safeParse('https://cdn.example.com/a.png').success).toBe(true);
    expect(httpUrlSchema().safeParse('http://localhost:3000/x').success).toBe(true);
  });

  it('rejects scripts and other schemes', () => {
    for (const value of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,<script>', 'ftp://x.com/a']) {
      expect(httpUrlSchema().safeParse(value).success).toBe(false);
    }
  });
});
