// Optional policy checks. All of these are no-ops unless the user opts in via
// config (allowedRoots / denyCommands / denyPaths / readOnly), because the
// server's whole point is unrestricted terminal access by default.

import { resolve, isAbsolute, sep } from 'node:path';
import { realpathSync } from 'node:fs';

export class PolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PolicyError';
  }
}

/** Resolve a user-supplied path against the base cwd and enforce allowedRoots. */
export function resolveSafePath(cfg, p, { forWrite = false } = {}) {
  if (typeof p !== 'string' || p === '') throw new PolicyError('path must be a non-empty string');
  const abs = isAbsolute(p) ? resolve(p) : resolve(cfg.cwd, p);

  if (forWrite && cfg.readOnly) {
    throw new PolicyError('Server is in readOnly mode; writes are disabled.');
  }
  if (forWrite) {
    for (const re of cfg.denyPaths) {
      if (re.test(abs)) throw new PolicyError(`Path denied by denyPaths policy: ${abs}`);
    }
  }
  assertInRoots(cfg, abs);
  return abs;
}

export function assertInRoots(cfg, abs) {
  if (!cfg.allowedRoots.length) return;
  // Compare real paths where possible so symlinks cannot escape a root.
  const target = tryReal(abs);
  const ok = cfg.allowedRoots.some((root) => {
    const r = tryReal(root);
    return target === r || target.startsWith(r.endsWith(sep) ? r : r + sep);
  });
  if (!ok) {
    throw new PolicyError(
      `Path is outside allowedRoots: ${abs}\nallowedRoots: ${cfg.allowedRoots.join(', ')}`,
    );
  }
}

function tryReal(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

export function assertCommandAllowed(cfg, command) {
  if (cfg.readOnly) {
    throw new PolicyError('Server is in readOnly mode; command execution is disabled.');
  }
  for (const re of cfg.denyCommands) {
    if (re.test(command)) {
      throw new PolicyError(`Command refused by denyCommands policy (matched ${re}).`);
    }
  }
}
