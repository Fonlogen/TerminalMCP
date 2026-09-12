#!/usr/bin/env node
// Copy the bundled skill into a Claude skills directory.
//   node scripts/install-skill.mjs              -> ~/.claude/skills/terminalmcp
//   node scripts/install-skill.mjs --project    -> ./.claude/skills/terminalmcp
//   node scripts/install-skill.mjs --to <dir>   -> <dir>/terminalmcp

import { cp, mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'skills', 'terminalmcp');

const args = process.argv.slice(2);
const toIdx = args.indexOf('--to');
const base =
  toIdx !== -1 && args[toIdx + 1]
    ? resolve(args[toIdx + 1])
    : args.includes('--project')
      ? resolve(process.cwd(), '.claude', 'skills')
      : join(homedir(), '.claude', 'skills');

const dest = join(base, 'terminalmcp');

if (!(await stat(SRC).catch(() => null))) {
  console.error(`Skill source missing: ${SRC}`);
  process.exit(1);
}

await mkdir(base, { recursive: true });
await cp(SRC, dest, { recursive: true });
console.log(`Installed skill -> ${dest}`);
console.log('Restart your MCP client (or run /skills) to pick it up.');
