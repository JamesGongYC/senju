// MCP plumbing: connect to stdio servers, expose their tools to Claude, run calls.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

const MAX_TEXT = 30000;

export async function connectServer(name, spec) {
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args ?? [],
    env: { ...getDefaultEnvironment(), ...(spec.env ?? {}) },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'senju', version: '0.1.0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  return {
    name,
    spec,
    client,
    tools,
    pid: transport.pid ?? null,
    close: () => client.close().catch(() => {}),
  };
}

// Claude tool names must match [a-zA-Z0-9_-]{1,64}. We namespace as server__tool.
export function toolName(server, tool) {
  return `${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

// Build the Claude tool list plus a lookup from Claude tool name to (connection, MCP tool).
export function buildToolset(connections) {
  const tools = [];
  const lookup = new Map();
  for (const conn of connections) {
    for (const t of conn.tools) {
      const name = toolName(conn.name, t.name);
      if (lookup.has(name)) continue;
      lookup.set(name, { conn, tool: t.name });
      const schema = t.inputSchema && t.inputSchema.type === 'object'
        ? t.inputSchema
        : { type: 'object', properties: {} };
      tools.push({
        name,
        description: `[${conn.name}] ${t.description ?? t.name}`.slice(0, 2000),
        input_schema: schema,
      });
    }
  }
  return { tools, lookup };
}

// Run one MCP call and convert the result into Claude tool_result content.
export async function callTool(conn, tool, args, signal) {
  try {
    const res = await conn.client.callTool({ name: tool, arguments: args ?? {} }, undefined, { signal, timeout: 120000 });
    const content = [];
    for (const item of res.content ?? []) {
      if (item.type === 'text') {
        const text = item.text.length > MAX_TEXT
          ? item.text.slice(0, MAX_TEXT) + `\n[truncated ${item.text.length - MAX_TEXT} characters]`
          : item.text;
        content.push({ type: 'text', text });
      } else if (item.type === 'image' && item.data) {
        content.push({ type: 'image', source: { type: 'base64', media_type: item.mimeType ?? 'image/png', data: item.data } });
      } else if (item.type === 'resource' && item.resource?.text) {
        content.push({ type: 'text', text: item.resource.text.slice(0, MAX_TEXT) });
      }
    }
    if (content.length === 0) content.push({ type: 'text', text: 'OK' });
    return { content, isError: Boolean(res.isError) };
  } catch (err) {
    return { content: [{ type: 'text', text: `Tool call failed: ${err?.message ?? err}` }], isError: true };
  }
}

// Turn a server's config entry into what to launch for one agent: expand ${WORKSPACE}, and
// for a tiled browser server, start its window in the agent's slot on screen.
export function resolveSpec(spec, workspace, agent = null) {
  const args = (spec.args ?? []).map((a) => String(a).replaceAll('${WORKSPACE}', workspace));
  let { command, env } = spec;
  if (command === 'bundled') {
    // A server that ships inside the app: run its script with the app's own Node runtime,
    // so nothing needs to be installed on the computer first.
    command = process.execPath;
    args[0] = path.join(APP_ROOT, args[0]);
    env = { ...env, ELECTRON_RUN_AS_NODE: '1' };
  }
  if (spec.tile === 'playwright' && agent?.slot) {
    const { x, y, w, h } = agent.slot;
    const file = path.join(os.tmpdir(), `senju-${process.pid}-${agent.id}.json`);
    fs.writeFileSync(file, JSON.stringify({
      browser: {
        launchOptions: { args: [`--window-position=${x},${y}`, `--window-size=${w},${h}`] },
        contextOptions: { viewport: null },   // page follows the window size
      },
    }));
    args.push('--config', file);
  }
  return { ...spec, command, env, args };
}
