// npm run doctor: checks that each configured MCP server starts, and records its tools.
// Writes traces/doctor.json so problems can be diagnosed from the file.
import fs from 'node:fs';
import path from 'node:path';
import { dataDir, loadConfig, ensureWorkspace } from '../src/config.js';
const ROOT = dataDir();
import { connectServer } from '../src/mcp.js';
import { listWindows } from '../src/windows.js';
import { placeWindow } from '../src/place.js';

const config = loadConfig();
const workspace = ensureWorkspace();
const report = { when: new Date().toISOString(), platform: process.platform, node: process.version, servers: {}, windows: null, placement: null };

for (const [name, spec] of Object.entries(config.servers)) {
  const args = (spec.args ?? []).map((a) => String(a).replaceAll('${WORKSPACE}', workspace));
  process.stdout.write(`${name}: starting (${spec.command} ${args.join(' ')}) ... `);
  try {
    const conn = await Promise.race([
      connectServer(name, { ...spec, args }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out after 90s')), 90000)),
    ]);
    report.servers[name] = { ok: true, tools: conn.tools.map((t) => ({ name: t.name, description: (t.description ?? '').slice(0, 600), input: t.inputSchema })) };
    console.log(`ok, ${conn.tools.length} tools: ${conn.tools.map((t) => t.name).join(', ')}`);
    await conn.close();
  } catch (err) {
    report.servers[name] = { ok: false, error: String(err?.message ?? err) };
    console.log(`FAILED: ${err?.message ?? err}`);
    if (spec.setup) console.log(`  -> ${spec.setup}`);
  }
}

const windows = await listWindows();
report.windows = { count: windows.length, apps: [...new Set(windows.map((w) => w.app))] };
console.log(`windows: ${windows.length ? `can see ${windows.length} windows (${report.windows.apps.slice(0, 8).join(', ')})` : 'none visible (window list failed)'}`);

// Placement check: "move" the front window to where it already is. Proves permission without changing anything.
const front = windows[0];
if (front) {
  const res = await placeWindow(front.pid, front);
  report.placement = res;
  console.log(`window tiling: ${res.ok ? 'allowed' : res.denied ? 'NOT ALLOWED. In System Settings > Privacy & Security, allow your terminal under Accessibility and under Automation > System Events.' : `failed (${res.error ?? 'no window'})`}`);
}

fs.mkdirSync(path.join(ROOT, 'traces'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'traces', 'doctor.json'), JSON.stringify(report, null, 2));
console.log('\nWrote traces/doctor.json');
process.exit(0);
