import type { Tool } from "@earendil-works/pi-ai";

// Mirror Pi 1.2's constrained-sampling projection because the extension loader
// cannot resolve its public API subpath. This is provider formatting, not an
// independent schema-repair policy; ordinary (non-strict) schemas stay intact.
class UnsupportedStrictSchema extends Error {}

const UNSUPPORTED_STRICT_KEYS = [
  "$ref", "$defs", "definitions", "allOf", "oneOf", "patternProperties",
  "dependentSchemas", "dependencies", "unevaluatedProperties", "propertyNames",
  "contains", "prefixItems", "not", "if", "then", "else",
];

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function allowsNull(schema: unknown): boolean {
  if (!isObject(schema)) return false;
  return schema.type === "null" || (Array.isArray(schema.type) && schema.type.includes("null")) ||
    schema.const === null || (Array.isArray(schema.enum) && schema.enum.includes(null)) ||
    (Array.isArray(schema.anyOf) && schema.anyOf.some(allowsNull));
}

function makeNodeStrict(schema: unknown): void {
  if (!isObject(schema)) throw new UnsupportedStrictSchema("boolean schemas are unsupported");
  for (const key of UNSUPPORTED_STRICT_KEYS) {
    if (schema[key] !== undefined) throw new UnsupportedStrictSchema(`${key} schemas are unsupported`);
  }
  if (schema.anyOf !== undefined) {
    if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) {
      throw new UnsupportedStrictSchema("anyOf must contain at least one schema");
    }
    for (const variant of schema.anyOf) {
      if (isObject(variant)) {
        const types = typeof variant.type === "string" ? [variant.type] : Array.isArray(variant.type) ? variant.type : [];
        if (types.includes("object") || types.includes("array") || variant.properties !== undefined || variant.items !== undefined) {
          throw new UnsupportedStrictSchema("object and array unions are unsupported");
        }
      }
      makeNodeStrict(variant);
    }
  }
  if (schema.items !== undefined) {
    if (Array.isArray(schema.items)) throw new UnsupportedStrictSchema("tuple schemas are unsupported");
    makeNodeStrict(schema.items);
  }
  if (schema.properties !== undefined && schema.type !== "object") {
    throw new UnsupportedStrictSchema("properties require type object");
  }
  if (schema.type !== "object") return;
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
    throw new UnsupportedStrictSchema("schema-valued or true additionalProperties is unsupported");
  }
  if (schema.properties !== undefined && !isObject(schema.properties)) {
    throw new UnsupportedStrictSchema("object properties must be a schema map");
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((key: unknown) => typeof key !== "string"))) {
    throw new UnsupportedStrictSchema("object required must be a string array");
  }
  const properties = schema.properties ?? {};
  const names = Object.keys(properties);
  const required = new Set<string>(schema.required ?? []);
  if ([...required].some(key => !names.includes(key))) throw new UnsupportedStrictSchema("required contains an unknown property");
  for (const [name, property] of Object.entries(properties)) {
    makeNodeStrict(property);
    if (!required.has(name) && !allowsNull(property)) properties[name] = { anyOf: [property, { type: "null" }] };
  }
  schema.required = names;
  schema.additionalProperties = false;
}

export function projectJsonSchemaTool(tool: Tool, supportsStrict: boolean, defaultStrict: false | null) {
  let parameters = tool.parameters;
  let strict: boolean | null = defaultStrict;
  const config = tool.constrainedSampling;
  if (config && config.type === "json_schema") {
    if (!supportsStrict) {
      if (config.strict === "require") {
        throw new Error(`Tool "${tool.name}" requires JSON-schema constrained sampling, but strict tools are unsupported.`);
      }
    } else {
      try {
        const converted = structuredClone(parameters);
        if (!isObject(converted)) throw new UnsupportedStrictSchema("root schema must have type object");
        makeNodeStrict(converted);
        if (converted.type !== "object") throw new UnsupportedStrictSchema("root schema must have type object");
        parameters = converted;
        strict = true;
      } catch (error) {
        if (!(error instanceof UnsupportedStrictSchema)) throw error;
        if (config.strict === "require") {
          throw new Error(`Tool "${tool.name}" requires JSON-schema constrained sampling, but ${error.message}.`);
        }
      }
    }
  }
  return { type: "function", name: tool.name, description: tool.description, parameters,
    ...(supportsStrict ? { strict } : {}) };
}
