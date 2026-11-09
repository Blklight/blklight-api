/**
 * Parse TRUST_PROXY into Fastify's trustProxy option.
 * A bare hop count is rejected: Fastify >= 5.12 disables it because it cannot
 * validate the immediate peer, so direct clients could spoof X-Forwarded-*.
 * @param value - Raw env value: unset, "true" or a comma list of proxy IPs/CIDRs
 * @returns false when unset, true, or the address list
 * @throws Error when given a hop count
 */
export function parseTrustProxy(value: string | undefined): boolean | string[] {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === 'false') return false;
  if (trimmed === 'true') return true;
  if (/^\d+$/.test(trimmed)) {
    throw new Error(
      `TRUST_PROXY="${trimmed}": hop counts are not supported; list the proxy IPs/CIDRs (e.g. TRUST_PROXY=10.0.0.0/8) or use true`
    );
  }
  return trimmed
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
