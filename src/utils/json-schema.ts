import { z } from 'zod';

// Formats Fastify's ajv understands (ajv-formats). zod also emits its own
// (cuid2, nanoid, ulid, emoji...), which ajv refuses at boot; those are dropped
// from the JSON Schema and still enforced by the handler's schema.parse().
const AJV_FORMATS = new Set([
  'date', 'time', 'date-time', 'iso-time', 'iso-date-time', 'duration', 'uri', 'uri-reference',
  'uri-template', 'url', 'email', 'hostname', 'ipv4', 'ipv6', 'regex', 'uuid', 'json-pointer',
  'json-pointer-uri-fragment', 'relative-json-pointer', 'byte', 'int32', 'int64', 'float',
  'double', 'password', 'binary',
]);

/**
 * JSON Schema for a route's body/querystring/params, derived from its zod
 * schema so zod stays the single source: Fastify pre-validates with it and
 * @fastify/swagger documents it, while the handler's `schema.parse()` still
 * applies refinements and transforms that JSON Schema cannot express.
 * @param schema - The zod schema the handler parses
 * @returns Draft-07 JSON Schema of the input shape
 */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _draft, ...json } = z.toJSONSchema(schema, {
    target: 'draft-07',
    io: 'input',
    unrepresentable: 'any',
    override: (ctx) => {
      // trim()/toLowerCase() rewrite the value before the other checks run, so
      // a pattern or length emitted here would judge the raw input (e.g.
      // reject "Julian" before it becomes "julian"). Leave those to zod.
      const checks = (ctx.zodSchema._zod.def as { checks?: Array<{ _zod: { def: { check: string } } }> }).checks;
      if (checks?.some((check) => check._zod.def.check === 'overwrite')) {
        for (const key of ['pattern', 'minLength', 'maxLength', 'format']) delete ctx.jsonSchema[key];
      }
      const format = ctx.jsonSchema.format;
      if (typeof format === 'string' && !AJV_FORMATS.has(format)) {
        delete ctx.jsonSchema.format;
      }
    },
  }) as Record<string, unknown>;
  return json;
}
