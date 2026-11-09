import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { toJsonSchema } from '../../src/utils/json-schema';
import { usernameSchema } from '../../src/utils/username';
import { createDocumentSchema } from '../../src/features/documents/documents.zod';
import { createExerciseSchema } from '../../src/features/tutorial-exercises/tutorial-exercises.zod';

const ajv = addFormats(new Ajv({ strict: true, coerceTypes: 'array', useDefaults: true }));

describe('toJsonSchema', () => {
  it('produces schemas a strict ajv compiles (no zod-only formats such as cuid2)', () => {
    for (const schema of [createDocumentSchema, createExerciseSchema]) {
      expect(() => ajv.compile(toJsonSchema(schema))).not.toThrow();
    }
  });

  it('keeps defaults, enums and limits that the input must satisfy', () => {
    const json = toJsonSchema(
      z.object({ color: z.enum(['red', 'blue']).default('red'), limit: z.number().int().max(50) })
    ) as { properties: Record<string, Record<string, unknown>>; required?: string[] };
    expect(json.properties.color).toMatchObject({ default: 'red', enum: ['red', 'blue'] });
    expect(json.properties.limit).toMatchObject({ type: 'integer', maximum: 50 });
    expect(json).not.toHaveProperty('$schema');
  });

  it('does not judge raw input against rules that zod applies after trim()/toLowerCase()', () => {
    const validate = ajv.compile(toJsonSchema(z.object({ username: usernameSchema })));
    expect(validate({ username: '  Julian ' })).toBe(true);
    expect(usernameSchema.parse('  Julian ')).toBe('julian');
  });
});
