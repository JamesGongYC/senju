// A fake desktop driver for the smoke test: one window (pid 7, window 70) with a display that shows the keys
// pressed. Each get_window_state reply is numbered, so a test can count the reads.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'fake-desktop', version: '0.0.1' });
let display = '';
let reads = 0;
const ok = (text) => ({ content: [{ type: 'text', text }] });
server.tool('list_windows', 'List windows', { pid: z.number().optional() }, async () => ({ ...ok('1 window'), structuredContent: { windows: [{ pid: 7, window_id: 70, on_current_space: true, is_on_screen: true }] } }));
server.tool('get_window_state', 'Read a window', { pid: z.number(), window_id: z.number(), tree_format: z.string().optional() }, async () => ok(`STATE #${++reads} display=${display}`));
server.tool('press_key', 'Press a key', { pid: z.number().optional(), window_id: z.number().optional(), key: z.string() }, async ({ key }) => { display += key; return ok(`Pressed ${key}`); });
server.tool('click', 'Click', { pid: z.number().optional(), element_token: z.string().optional() }, async ({ element_token }) => { display += `[${element_token}]`; return ok(`Clicked ${element_token}`); });
await server.connect(new StdioServerTransport());
