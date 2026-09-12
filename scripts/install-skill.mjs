#!/usr/bin/env node
// Copy the bundled skills into a Claude skills directory.
//   node scripts/install-skill.mjs                  -> ~/.claude/skills/…
//   node scripts/install-skill.mjs --project        -> ./.claude/skills/…
//   node scripts/install-skill.mjs --to <dir>       -> <dir>/…
//   node scripts/install-skill.mjs --only fivem     -> just that one
//
// The main skill is always installed. The plugin skills are only installed
// when the plugin they describe is one you actually use — a skill for an
// integration you do not have is noise in the model's context.

import { cp, mkdir, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = join(ROOT, 'skills');

const args = process.argv.slice(2);
const toIdx = args.indexOf('--to');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx !== -1 ? (args[onlyIdx + 1] ?? '').split(/[,\s]+/).filter(Boolean) : null;

const base =
  toIdx !== -1 && args[toIdx + 1]
    ? resolve(args[toIdx + 1])
    : args.includes('--project')
      ? resolve(process.cwd(), '.claude', 'skills')
      : join(homedir(), '.claude', 'skills');

const available = (await readdir(SKILLS, { withFileTypes: true }))
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

if (!available.length) {
  console.error(`No skills found in ${SKILLS}`);
  process.exit(1);
}

// "fivem" is allowed to mean "terminalmcp-fivem", since that is what a person
// would type.
function wanted(name) {
  if (!only) return name === 'terminalmcp';
  return only.some((o) => name === o || name === `terminalmcp-${o}` || o === 'all');
}

const chosen = available.filter(wanted);
if (!chosen.length) {
  console.error(`Nothing matched --only ${only.join(',')}. Available: ${available.join(', ')}`);
  process.exit(1);
}

await mkdir(base, { recursive: true });
for (const name of chosen) {
  const src = join(SKILLS, name);
  if (!(await stat(src).catch(() => null))) continue;
  await cp(src, join(base, name), { recursive: true });
  console.log(`Installed ${name} -> ${join(base, name)}`);
}

const skipped = available.filter((n) => !chosen.includes(n));
if (skipped.length && !only) {
  console.log(`\nNot installed: ${skipped.join(', ')}`);
  console.log('Those describe optional plugins. Install the ones you enabled, e.g.');
  console.log('  node scripts/install-skill.mjs --only fivem,discord');
}
console.log('\nRestart your MCP client (or run /skills) to pick them up.');
