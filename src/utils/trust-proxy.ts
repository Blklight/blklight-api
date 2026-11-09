/**
 * Parse TRUST_PROXY into Fastify's trustProxy option.
 * @param value - Raw env value: unset, "true", a hop count or a comma list of IPs/CIDRs
 * @returns false when unset, true, a hop count, or the address list
 */
export function parseTrustProxy(value: string | undefined): boolean | number | string[] {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === 'false') return false;
  if (trimmed === 'true') return true;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
