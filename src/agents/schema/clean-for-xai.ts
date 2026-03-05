// xAI rejects these JSON Schema validation keywords in tool definitions instead of
// ignoring them, causing 502 errors for any request that includes them.  Strip them
// before sending to xAI directly, or via OpenRouter when the downstream model is xAI.
export const XAI_UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minContains",
  "maxContains",
]);

export function stripXaiUnsupportedKeywords(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map(stripXaiUnsupportedKeywords);
  }
  const obj = schema as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (XAI_UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) {
      continue;
    }
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      cleaned[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          k,
          stripXaiUnsupportedKeywords(v),
        ]),
      );
    } else if (key === "items" && value && typeof value === "object") {
      cleaned[key] = Array.isArray(value)
        ? value.map(stripXaiUnsupportedKeywords)
        : stripXaiUnsupportedKeywords(value);
    } else if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) {
      cleaned[key] = value.map(stripXaiUnsupportedKeywords);
    } else {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

export function isXaiProvider(modelProvider?: string, modelId?: string): boolean {
  const provider = modelProvider?.toLowerCase() ?? "";
  if (provider.includes("xai") || provider.includes("x-ai")) {
    return true;
  }
  // OpenRouter proxies to xAI when the model id starts with "x-ai/"
  if (provider === "openrouter" && modelId?.toLowerCase().startsWith("x-ai/")) {
    return true;
  }
  return false;
}

// ── HTML entity decoding for xAI tool call arguments ────────────────────────
// xAI/Grok models HTML-entity-encode special characters inside tool_call
// argument values (e.g. `&&` → `&amp;&amp;`, `"` → `&quot;`).  This breaks
// any tool that passes the value through to a shell or file system.
// Decode the five standard XML/HTML entities; numeric character references
// (&#NNN; / &#xHH;) are also handled for completeness.

const HTML_ENTITY_RE = /&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-zA-Z]+));/g;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * Decode HTML entities in a single string value.
 * Only decodes the standard named entities plus numeric references — this is
 * intentionally conservative to avoid false-positive replacements.
 */
export function decodeHtmlEntities(text: string): string {
  if (!text.includes("&")) {
    return text;
  }
  return text.replace(HTML_ENTITY_RE, (match, decimal, hex, named) => {
    if (decimal) {
      const code = Number(decimal);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    if (hex) {
      const code = parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    if (named) {
      return NAMED_ENTITIES[named.toLowerCase()] ?? match;
    }
    return match;
  });
}

/**
 * Recursively decode HTML entities in all string values of a tool call
 * arguments object.  Non-string leaves and structural keys are left untouched.
 */
export function decodeHtmlEntitiesInArgs(args: unknown): unknown {
  if (typeof args === "string") {
    return decodeHtmlEntities(args);
  }
  if (!args || typeof args !== "object") {
    return args;
  }
  if (Array.isArray(args)) {
    let changed = false;
    const decoded = args.map((item) => {
      const result = decodeHtmlEntitiesInArgs(item);
      if (result !== item) {
        changed = true;
      }
      return result;
    });
    return changed ? decoded : args;
  }
  const record = args as Record<string, unknown>;
  let changed = false;
  const decoded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const result = decodeHtmlEntitiesInArgs(value);
    decoded[key] = result;
    if (result !== value) {
      changed = true;
    }
  }
  return changed ? decoded : args;
}

/**
 * Walk an assistant message's content blocks and decode HTML entities in all
 * toolCall argument values.  Mutates the blocks in place for consistency with
 * the existing `trimWhitespaceFromToolCallNamesInMessage` pattern.
 *
 * Returns `true` if any value was changed.
 */
export function decodeHtmlEntitiesInToolCallMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return false;
  }
  let changed = false;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; arguments?: unknown };
    if (
      typedBlock.type !== "toolCall" ||
      !typedBlock.arguments ||
      typeof typedBlock.arguments !== "object"
    ) {
      continue;
    }
    const decoded = decodeHtmlEntitiesInArgs(typedBlock.arguments);
    if (decoded !== typedBlock.arguments) {
      typedBlock.arguments = decoded;
      changed = true;
    }
  }
  return changed;
}
