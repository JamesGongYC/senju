// npm run release: build the Mac installers, then copy them next to the download page.
// The page links to downloads/Senju-<version>-arm64.dmg and -x64.dmg.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.js';

if (process.platform !== 'darwin') { console.error('Mac installers can only be built on a Mac.'); process.exit(1); }
execFileSync('npx', ['electron-builder', '--mac'], { cwd: ROOT, stdio: 'inherit' });

const site = process.argv[2] ?? path.join(ROOT, '..', 'senju-website');
const dmgs = fs.readdirSync(path.join(ROOT, 'dist')).filter((f) => f.endsWith('.dmg'));
if (!fs.existsSync(site)) { console.log(`\nBuilt ${dmgs.join(', ')} in dist/. No website folder at ${site}, so nothing was copied.`); process.exit(0); }
fs.mkdirSync(path.join(site, 'downloads'), { recursive: true });
for (const f of dmgs) fs.copyFileSync(path.join(ROOT, 'dist', f), path.join(site, 'downloads', f));
console.log(`\nCopied ${dmgs.join(', ')} to ${path.join(site, 'downloads')}`);
