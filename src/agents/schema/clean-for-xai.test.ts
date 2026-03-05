import { describe, expect, it } from "vitest";
import {
  decodeHtmlEntities,
  decodeHtmlEntitiesInArgs,
  decodeHtmlEntitiesInToolCallMessage,
  isXaiProvider,
  stripXaiUnsupportedKeywords,
} from "./clean-for-xai.js";

describe("isXaiProvider", () => {
  it("matches direct xai provider", () => {
    expect(isXaiProvider("xai")).toBe(true);
  });

  it("matches x-ai provider string", () => {
    expect(isXaiProvider("x-ai")).toBe(true);
  });

  it("matches openrouter with x-ai model id", () => {
    expect(isXaiProvider("openrouter", "x-ai/grok-4.1-fast")).toBe(true);
  });

  it("does not match openrouter with non-xai model id", () => {
    expect(isXaiProvider("openrouter", "openai/gpt-4o")).toBe(false);
  });

  it("does not match openai provider", () => {
    expect(isXaiProvider("openai")).toBe(false);
  });

  it("does not match google provider", () => {
    expect(isXaiProvider("google")).toBe(false);
  });

  it("handles undefined provider", () => {
    expect(isXaiProvider(undefined)).toBe(false);
  });
});

describe("stripXaiUnsupportedKeywords", () => {
  it("strips minLength and maxLength from string properties", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 64, description: "A name" },
      },
    };
    const result = stripXaiUnsupportedKeywords(schema) as {
      properties: { name: Record<string, unknown> };
    };
    expect(result.properties.name.minLength).toBeUndefined();
    expect(result.properties.name.maxLength).toBeUndefined();
    expect(result.properties.name.type).toBe("string");
    expect(result.properties.name.description).toBe("A name");
  });

  it("strips minItems and maxItems from array properties", () => {
    const schema = {
      type: "object",
      properties: {
        items: { type: "array", minItems: 1, maxItems: 50, items: { type: "string" } },
      },
    };
    const result = stripXaiUnsupportedKeywords(schema) as {
      properties: { items: Record<string, unknown> };
    };
    expect(result.properties.items.minItems).toBeUndefined();
    expect(result.properties.items.maxItems).toBeUndefined();
    expect(result.properties.items.type).toBe("array");
  });

  it("strips minContains and maxContains", () => {
    const schema = {
      type: "array",
      minContains: 1,
      maxContains: 5,
      contains: { type: "string" },
    };
    const result = stripXaiUnsupportedKeywords(schema) as Record<string, unknown>;
    expect(result.minContains).toBeUndefined();
    expect(result.maxContains).toBeUndefined();
    expect(result.contains).toBeDefined();
  });

  it("strips keywords recursively inside nested objects", () => {
    const schema = {
      type: "object",
      properties: {
        attachment: {
          type: "object",
          properties: {
            content: { type: "string", maxLength: 6_700_000 },
          },
        },
      },
    };
    const result = stripXaiUnsupportedKeywords(schema) as {
      properties: { attachment: { properties: { content: Record<string, unknown> } } };
    };
    expect(result.properties.attachment.properties.content.maxLength).toBeUndefined();
    expect(result.properties.attachment.properties.content.type).toBe("string");
  });

  it("strips keywords inside anyOf/oneOf/allOf variants", () => {
    const schema = {
      anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
    };
    const result = stripXaiUnsupportedKeywords(schema) as {
      anyOf: Array<Record<string, unknown>>;
    };
    expect(result.anyOf[0].minLength).toBeUndefined();
    expect(result.anyOf[0].type).toBe("string");
  });

  it("strips keywords inside array item schemas", () => {
    const schema = {
      type: "array",
      items: { type: "string", maxLength: 100 },
    };
    const result = stripXaiUnsupportedKeywords(schema) as {
      items: Record<string, unknown>;
    };
    expect(result.items.maxLength).toBeUndefined();
    expect(result.items.type).toBe("string");
  });

  it("preserves all other schema keywords", () => {
    const schema = {
      type: "object",
      description: "A tool schema",
      required: ["name"],
      properties: {
        name: { type: "string", description: "The name", enum: ["foo", "bar"] },
      },
      additionalProperties: false,
    };
    const result = stripXaiUnsupportedKeywords(schema) as Record<string, unknown>;
    expect(result.type).toBe("object");
    expect(result.description).toBe("A tool schema");
    expect(result.required).toEqual(["name"]);
    expect(result.additionalProperties).toBe(false);
  });

  it("passes through primitives and null unchanged", () => {
    expect(stripXaiUnsupportedKeywords(null)).toBeNull();
    expect(stripXaiUnsupportedKeywords("string")).toBe("string");
    expect(stripXaiUnsupportedKeywords(42)).toBe(42);
  });
});

// ── HTML entity decoding tests ──────────────────────────────────────────────

describe("decodeHtmlEntities", () => {
  it("decodes &amp; to &", () => {
    expect(decodeHtmlEntities("a &amp;&amp; b")).toBe("a && b");
  });

  it("decodes &quot; to double quote", () => {
    expect(decodeHtmlEntities("&quot;hello&quot;")).toBe('"hello"');
  });

  it("decodes &lt; and &gt; to angle brackets", () => {
    expect(decodeHtmlEntities("&lt;div&gt;")).toBe("<div>");
  });

  it("decodes &apos; to single quote", () => {
    expect(decodeHtmlEntities("it&apos;s")).toBe("it's");
  });

  it("decodes &#NNN; decimal numeric references", () => {
    expect(decodeHtmlEntities("&#38;")).toBe("&");
    expect(decodeHtmlEntities("&#60;")).toBe("<");
  });

  it("decodes &#xHH; hex numeric references", () => {
    expect(decodeHtmlEntities("&#x26;")).toBe("&");
    expect(decodeHtmlEntities("&#x3C;")).toBe("<");
  });

  it("returns the original string when no entities are present", () => {
    const input = "no entities here";
    expect(decodeHtmlEntities(input)).toBe(input);
  });

  it("handles mixed entities and plain text", () => {
    expect(
      decodeHtmlEntities("source .env &amp;&amp; psql &quot;$DB&quot; -c &quot;SELECT 1&quot;"),
    ).toBe('source .env && psql "$DB" -c "SELECT 1"');
  });

  it("preserves unknown named entities", () => {
    expect(decodeHtmlEntities("&unknown;")).toBe("&unknown;");
  });

  it("handles empty string", () => {
    expect(decodeHtmlEntities("")).toBe("");
  });

  it("decodes &nbsp; to space", () => {
    expect(decodeHtmlEntities("hello&nbsp;world")).toBe("hello world");
  });
});

describe("decodeHtmlEntitiesInArgs", () => {
  it("decodes string values in a flat object", () => {
    const args = { command: "source .env &amp;&amp; echo &quot;ok&quot;" };
    const result = decodeHtmlEntitiesInArgs(args) as Record<string, string>;
    expect(result.command).toBe('source .env && echo "ok"');
  });

  it("decodes nested object values", () => {
    const args = { config: { path: "&lt;root&gt;/file" } };
    const result = decodeHtmlEntitiesInArgs(args) as { config: { path: string } };
    expect(result.config.path).toBe("<root>/file");
  });

  it("decodes array values", () => {
    const args = { commands: ["echo &amp;", "cat &lt;file"] };
    const result = decodeHtmlEntitiesInArgs(args) as { commands: string[] };
    expect(result.commands).toEqual(["echo &", "cat <file"]);
  });

  it("returns the same reference when no decoding is needed", () => {
    const args = { command: "echo hello", count: 42 };
    const result = decodeHtmlEntitiesInArgs(args);
    expect(result).toBe(args);
  });

  it("preserves non-string values", () => {
    const args = { count: 42, enabled: true, data: null };
    const result = decodeHtmlEntitiesInArgs(args);
    expect(result).toBe(args);
  });

  it("handles a bare string argument", () => {
    expect(decodeHtmlEntitiesInArgs("&amp;")).toBe("&");
  });

  it("returns non-object primitives unchanged", () => {
    expect(decodeHtmlEntitiesInArgs(42)).toBe(42);
    expect(decodeHtmlEntitiesInArgs(null)).toBeNull();
    expect(decodeHtmlEntitiesInArgs(undefined)).toBeUndefined();
  });
});

describe("decodeHtmlEntitiesInToolCallMessage", () => {
  it("decodes arguments in toolCall blocks", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_1",
          name: "exec",
          arguments: { command: "cd ~/dev &amp;&amp; source .env &amp;&amp; psql &quot;$DB&quot;" },
        },
      ],
    };
    const changed = decodeHtmlEntitiesInToolCallMessage(message);
    expect(changed).toBe(true);
    const args = (message.content[0] as { arguments: Record<string, string> }).arguments;
    expect(args.command).toBe('cd ~/dev && source .env && psql "$DB"');
  });

  it("does not modify non-toolCall blocks", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "hello &amp; world" }],
    };
    const changed = decodeHtmlEntitiesInToolCallMessage(message);
    expect(changed).toBe(false);
    expect((message.content[0] as { text: string }).text).toBe("hello &amp; world");
  });

  it("returns false when no decoding is needed", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call_1", name: "exec", arguments: { command: "echo hello" } },
      ],
    };
    const changed = decodeHtmlEntitiesInToolCallMessage(message);
    expect(changed).toBe(false);
  });

  it("handles messages without content array", () => {
    expect(decodeHtmlEntitiesInToolCallMessage({ role: "user", content: "hi" })).toBe(false);
  });

  it("handles null and undefined", () => {
    expect(decodeHtmlEntitiesInToolCallMessage(null)).toBe(false);
    expect(decodeHtmlEntitiesInToolCallMessage(undefined)).toBe(false);
  });

  it("handles multiple toolCall blocks with mixed encoding", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_1",
          name: "exec",
          arguments: { command: "echo &amp;&amp; done" },
        },
        {
          type: "toolCall",
          id: "call_2",
          name: "read",
          arguments: { path: "/home/user/file.txt" },
        },
        {
          type: "toolCall",
          id: "call_3",
          name: "exec",
          arguments: { command: "cat &lt;input.txt &gt;output.txt" },
        },
      ],
    };
    const changed = decodeHtmlEntitiesInToolCallMessage(message);
    expect(changed).toBe(true);
    const blocks = message.content as unknown as Array<{ arguments: Record<string, string> }>;
    expect(blocks[0].arguments.command).toBe("echo && done");
    expect(blocks[1].arguments.path).toBe("/home/user/file.txt");
    expect(blocks[2].arguments.command).toBe("cat <input.txt >output.txt");
  });

  it("reproduces the exact scenario from issue #35173", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_abc",
          name: "exec",
          arguments: {
            command:
              "cd ~/dev/vibe/caracle &amp;&amp; source .env &amp;&amp; psql &quot;$DATABASE_URL_SESSION&quot; -c &quot;SELECT 1&quot;",
          },
        },
      ],
    };
    const changed = decodeHtmlEntitiesInToolCallMessage(message);
    expect(changed).toBe(true);
    const args = (message.content[0] as { arguments: Record<string, string> }).arguments;
    expect(args.command).toBe(
      'cd ~/dev/vibe/caracle && source .env && psql "$DATABASE_URL_SESSION" -c "SELECT 1"',
    );
  });

  it("demonstrates that double-decode corrupts values (motivates the stream wrapper flag)", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_1",
          name: "exec",
          arguments: { command: "echo &amp;amp; done" },
        },
      ],
    };
    // First decode: `&amp;amp;` → `&amp;`
    const changed1 = decodeHtmlEntitiesInToolCallMessage(message);
    expect(changed1).toBe(true);
    const block = message.content[0] as { arguments: Record<string, string> };
    expect(block.arguments.command).toBe("echo &amp; done");

    // Second decode would incorrectly turn `&amp;` → `&` — this test documents
    // that decoding is NOT idempotent, which is why the stream wrapper uses a
    // `resultDecoded` flag to prevent double-decode.
    const changed2 = decodeHtmlEntitiesInToolCallMessage(message);
    expect(changed2).toBe(true);
    // After the second pass the value is now corrupted:
    expect(block.arguments.command).toBe("echo & done");
  });
});
