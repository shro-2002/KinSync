/**
 * Advertise a zod schema's exact JSON Schema in tools/list, but let the domain layer do the
 * validation. The SDK only reads the public Standard Schema interface (`~standard.jsonSchema`
 * for tools/list, `~standard.validate` before calling the handler), so this changes no SDK
 * internals. Result: one error contract ({ error: { code: "INVALID_INPUT", ... } }) and an
 * audit row for every rejected input, instead of the SDK's plain-text "Input validation error".
 */
import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import type * as z from 'zod/v4';

export function domainValidated<S extends z.ZodType>(schema: S): S {
    const std = (schema as unknown as StandardSchemaWithJSON)['~standard'];
    const wrapper = {
        '~standard': {
            version: 1 as const,
            vendor: 'careloop-domain-validated',
            jsonSchema: std.jsonSchema,
            // Pass-through: CareService re-parses with the same zod schema and returns a typed error.
            validate: (value: unknown) => ({ value })
        }
    };
    // Typed as the original schema so handlers keep their inferred argument types; the
    // service treats arguments as unknown and validates them itself.
    return wrapper as unknown as S;
}
