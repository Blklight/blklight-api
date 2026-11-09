import { z } from "zod";
import { config } from "dotenv";
import { expand } from "dotenv-expand";
import { resolve } from "node:path";
import { parseTrustProxy } from "../utils/trust-proxy";

const nodeEnv = process.env.NODE_ENV ?? "development";
expand(config({ path: resolve(process.cwd(), `.env.${nodeEnv}`) }));
expand(config({ path: resolve(process.cwd(), ".env"), override: false }));

const booleanFromEnvDefault = (defaultValue: boolean) => {
  const stringOrBool = z.union([
    z.string().transform((val) => val === 'true' || val === '1'),
    z.boolean(),
  ]);
  return stringOrBool.default(defaultValue);
};

/**
 * Split a comma-separated env value into trimmed, non-empty entries.
 * @param value - Raw env value, e.g. "http://a.com,http://b.com"
 * @returns Array of entries with surrounding whitespace and blanks removed
 */
const splitList = (value: string): string[] =>
  value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

/**
 * Parse one allowlist entry into a URL when possible.
 * @param value - Single allowlist entry
 * @returns Parsed URL, or null when the entry is not a URL at all
 */
const parseOriginUrl = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

/**
 * Suggest the canonical bare origin (scheme://host[:port]) for a rejected entry,
 * so the boot error can show the exact value the operator should use.
 *
 * Covers the common misconfigurations: trailing slash, path, query, fragment,
 * credentials and a missing http(s) scheme.
 * @param value - Offending allowlist entry
 * @returns Suggestion string, or null when nothing sensible can be derived
 */
const suggestCanonicalOrigin = (value: string): string | null => {
  // A "://" that is not http(s) means the operator wrote a real scheme we do
  // not allow; do not "fix" it by prepending another one.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/^https?:\/\//i.test(value)) {
    return null;
  }

  const withScheme = /^https?:\/\//i.test(value) ? value : `http://${value}`;
  const url = parseOriginUrl(withScheme);
  if (url === null) {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }

  if (url.hostname === "") {
    return null;
  }

  return url.origin;
};

const envSchema = z
  .object({
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    JWT_ACCESS_SECRET: z
      .string()
      .min(32, "JWT_ACCESS_SECRET must be at least 32 characters"),
    JWT_ACCESS_EXPIRES_IN: z.string().default("15m"),
    JWT_REFRESH_EXPIRES_IN: z.string().default("7d"),
    JWT_REFRESH_REMEMBER_TTL: z.string().default("30d"),
    /**
     * Grace window in which a already-rotated refresh token still returns a new
     * access token instead of being treated as theft. Covers parallel browser
     * requests racing on the same cookie.
     */
    REFRESH_REUSE_GRACE_SECONDS: z.coerce.number().int().positive().default(30),
    /**
     * Per-user (falling back to per-IP) rate limits for document writes. The
     * create/publish routes use these instead of the global 100/min limit; the
     * autosave PATCH route keeps the global limit.
     */
    RATE_LIMIT_DOCS_CREATE_MAX: z.coerce.number().int().positive().default(20),
    RATE_LIMIT_DOCS_PUBLISH_MAX: z.coerce.number().int().positive().default(10),
    PORT: z.coerce.number().int().positive().default(4000),
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace"])
      .default("info"),
    CORS_ORIGIN: z.string().default("http://localhost:3000"),
    /**
     * Fastify trustProxy. Unset = do not trust X-Forwarded-*. Behind a proxy set
     * the proxy IPs/CIDRs ("10.0.0.0/8,127.0.0.1"), or request.ip is the
     * proxy's and every per-IP rate limit becomes global. Hop counts are rejected.
     */
    TRUST_PROXY: z.string().optional(),
    COOKIE_SAMESITE: z.enum(["strict", "lax", "none"]).default("strict"),
    MAX_SESSIONS_PER_USER: z.coerce.number().int().positive().default(5),
    SIGNATURE_ENCRYPTION_KEY: z.string().min(64).optional(),
    GITHUB_CLIENT_ID: z.string().min(1).optional(),
    GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    OAUTH_REDIRECT_BASE_URL: z.string().url().optional(),
    FRONTEND_URL: z.string().url().optional(),
    RESEND_API_KEY: z.string().min(1).optional(),
    EMAIL_FROM: z.string().default("onboarding@resend.dev"),
    EMAIL_DAILY_LIMIT: z.coerce.number().default(50),
    EMAIL_VERIFY_EXPIRES_IN_HOURS: z.coerce.number().default(24),
    PASSWORD_RESET_EXPIRES_IN_MINUTES: z.coerce.number().default(30),
    FEATURE_EMAIL: booleanFromEnvDefault(false),
    FEATURE_OAUTH: booleanFromEnvDefault(false),
    FEATURE_EMAIL_QUEUE: booleanFromEnvDefault(false),
    // Submitted code runs in QuickJS (WASM) inside a worker thread; see utils/sandbox.ts.
    FEATURE_CODE_SANDBOX: booleanFromEnvDefault(true),
    FEATURE_MEMORY: booleanFromEnvDefault(true),
    GEMINI_API_KEY: z.string().optional(),
    ADMIN_EMAIL: z.string().email().optional(),
    ADMIN_PASSWORD: z.string().min(8).optional(),
  })
  .superRefine((data, ctx) => {
    const corsEntries = splitList(data.CORS_ORIGIN);

    if (corsEntries.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["CORS_ORIGIN"],
        message: "CORS_ORIGIN must list at least one origin",
      });
    }

    for (const entry of corsEntries) {
      if (entry === "*") {
        ctx.addIssue({
          code: "custom",
          path: ["CORS_ORIGIN"],
          message:
            'CORS_ORIGIN cannot be "*": wildcard origins are invalid with cookie credentials. List explicit origins instead, e.g. CORS_ORIGIN=http://localhost:3000',
        });
        continue;
      }

      const url = parseOriginUrl(entry);
      const isBareOrigin =
        url !== null &&
        (url.protocol === "http:" || url.protocol === "https:") &&
        url.username === "" &&
        url.password === "" &&
        entry === url.origin;

      if (isBareOrigin) {
        continue;
      }

      const suggestion = suggestCanonicalOrigin(entry);
      ctx.addIssue({
        code: "custom",
        path: ["CORS_ORIGIN"],
        message: suggestion
          ? `Invalid origin "${entry}": CORS_ORIGIN entries must be bare origins (item === new URL(item).origin) with no trailing slash, path, query, fragment or credentials. Use "${suggestion}"`
          : `Invalid origin "${entry}": CORS_ORIGIN entries must be bare origins (item === new URL(item).origin) with scheme and optional port, no trailing slash, path, query, fragment or credentials (e.g. http://localhost:3000)`,
      });
    }

    if (data.FEATURE_OAUTH) {
      const oauthFields = [
        "GITHUB_CLIENT_ID",
        "GITHUB_CLIENT_SECRET",
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET",
        "OAUTH_REDIRECT_BASE_URL",
        "FRONTEND_URL",
      ];
      for (const field of oauthFields) {
        if (!data[field as keyof typeof data]) {
          ctx.addIssue({
            code: "custom",
            path: [field],
            message: `Required when FEATURE_OAUTH=true`,
          });
        }
      }
    }

    if (data.FEATURE_EMAIL) {
      const emailFields = ["RESEND_API_KEY", "FRONTEND_URL"];
      for (const field of emailFields) {
        if (!data[field as keyof typeof data]) {
          ctx.addIssue({
            code: "custom",
            path: [field],
            message: `Required when FEATURE_EMAIL=true`,
          });
        }
      }
    }
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const errors = parsed.error.issues
    .map((e) => `${e.path.join(".")}: ${e.message}`)
    .join(", ");
  console.error("❌ Invalid environment variables:", errors);
  process.exit(1);
}

/**
 * Parsed environment plus derived values.
 * CORS_ORIGINS is the validated allowlist; CORS_ORIGIN stays available as the
 * raw string so boot can report the offending value.
 */
type Env = z.infer<typeof envSchema> & {
  /** Bare origins allowed by @fastify/cors. Never contains "*". */
  CORS_ORIGINS: string[];
  /** Value for Fastify's trustProxy option, derived from TRUST_PROXY. */
  TRUST_PROXY_VALUE: boolean | string[];
};

export const env: Env = {
  ...parsed.data,
  // superRefine above guarantees every entry satisfies entry === new URL(entry).origin,
  // so these can be forwarded to @fastify/cors without rewriting the browser origin.
  CORS_ORIGINS: splitList(parsed.data.CORS_ORIGIN),
  TRUST_PROXY_VALUE: parseTrustProxy(parsed.data.TRUST_PROXY),
};
