import { z } from 'zod';

/**
 * URL accepted from users: http(s) only. z.string().url() alone also accepts
 * javascript:, data: and other schemes that become XSS once rendered in a link.
 * @returns Zod schema for an absolute http(s) URL
 */
export function httpUrlSchema() {
  return z
    .string()
    .url('Invalid URL format')
    .refine((value) => /^https?:\/\//i.test(value), 'URL must start with http:// or https://');
}
