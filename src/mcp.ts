// Minimal MCP server over stdio (JSON-RPC 2.0, one message per line) exposing one tool.

import { createInterface } from 'node:readline';
import { describe, whomade } from './index.ts';
import { load, version } from './node.ts';

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const tool = {
  name: 'who_made',
  title: 'Who made this image?',
  description:
    'Checks who or what made an image. Verifies C2PA Content Credentials against the C2PA trust list, ' +
    "reads AI-generator metadata (IPTC, EXIF, Stable Diffusion/ComfyUI PNG text) and looks for Gemini's " +
    'visible watermark. Finding nothing does not mean a human made it: most sites strip metadata.',
  inputSchema: {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'Absolute file path or http(s) URL of the image' },
      openai: {
        type: 'boolean',
        description:
          "Also ask OpenAI's provenance API for its SynthID watermark, which survives screenshots. " +
          'Uploads the image to OpenAI; only use when the user agrees. Needs OPENAI_API_KEY.',
      },
    },
    required: ['source'],
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
};

class RpcError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export function serve(): void {
  createInterface({ input: process.stdin }).on('line', async (line) => {
    if (!line.trim()) return;
    let msg: { id?: string | number | null; method?: string; params?: any };
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ id: null, error: { code: -32700, message: 'Parse error' } });
    }
    if (msg.id === undefined) return; // notification
    try {
      send({ id: msg.id, result: await handle(msg.method, msg.params) });
    } catch (e) {
      send({ id: msg.id, error: { code: e instanceof RpcError ? e.code : -32603, message: (e as Error).message } });
    }
  });
}

async function handle(method: string | undefined, params: any) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'whomade', version },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: [tool] };
    case 'tools/call':
      if (params?.name !== tool.name) throw new RpcError(-32602, `Unknown tool: ${params?.name}`);
      return call(params.arguments ?? {});
    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

async function call({ source, openai }: { source?: unknown; openai?: unknown }) {
  try {
    if (typeof source !== 'string' || !source) throw new Error('`source` must be a file path or URL');
    if (openai === true && !process.env.OPENAI_API_KEY) throw new Error('`openai` needs OPENAI_API_KEY in the server environment');
    const report = await whomade(await load(source), { openaiApiKey: openai === true ? process.env.OPENAI_API_KEY : undefined });
    return { content: [{ type: 'text', text: `${describe(report)}\n\n${JSON.stringify(report, null, 2)}` }] };
  } catch (e) {
    return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
  }
}

function send(msg: object) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
}
