import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/**
 * The MCP SDK lists tool schemas as JSON Schema draft-07, and Claude and other
 * clients that read only 2020-12 turn those tools down. The schemas here are
 * plain enough that only the dialect, `definitions` and their `$ref`s differ,
 * so tools/list is rewritten on its way out.
 */
export const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

const DATA_KEYWORDS = new Set(['enum', 'const', 'default', 'examples', 'required']);
const SCHEMA_MAPS = new Set(['properties', 'patternProperties', 'definitions', '$defs']);

function convert(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(convert);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === '$schema') continue;
    if (DATA_KEYWORDS.has(key)) {
      out[key] = value;
    } else if (SCHEMA_MAPS.has(key) && value && typeof value === 'object') {
      out[key === 'definitions' ? '$defs' : key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([name, schema]) => [name, convert(schema)]),
      );
    } else if (key === '$ref' && typeof value === 'string') {
      out[key] = value.replace(/^#\/definitions\//, '#/$defs/');
    } else {
      out[key] = convert(value);
    }
  }
  return out;
}

export function toDraft2020(schema: unknown): unknown {
  const converted = convert(schema);
  return converted && typeof converted === 'object' ? { $schema: DRAFT_2020_12, ...converted } : converted;
}

function rewrite(message: JSONRPCMessage): JSONRPCMessage {
  const result = (message as { result?: { tools?: unknown } }).result;
  if (!result || !Array.isArray(result.tools)) return message;
  const tools = result.tools.map(tool => {
    const { inputSchema, outputSchema, ...rest } = tool as { inputSchema?: unknown; outputSchema?: unknown };
    return {
      ...rest,
      ...(inputSchema ? { inputSchema: toDraft2020(inputSchema) } : {}),
      ...(outputSchema ? { outputSchema: toDraft2020(outputSchema) } : {}),
    };
  });
  return { ...message, result: { ...result, tools } } as JSONRPCMessage;
}

/** The same transport, with tools/list answered in 2020-12. */
export function withDraft2020(transport: Transport): Transport {
  const send = transport.send.bind(transport);
  transport.send = (message, options) => send(rewrite(message), options);
  return transport;
}
