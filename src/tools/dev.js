// Group: dev — package managers, project orientation, code structure.

import { readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { resolveSafePath, assertCommandAllowed } from '../guards.js';
import { runArgv } from '../exec.js';
import { walk, walkAll, looksBinaryPath } from '../walk.js';
import { shapeOutput, truncateMiddle } from '../format.js';

// ------------------------------------------------------- ecosystem table

/**
 * How to drive each package manager. `detect` lists the files that identify
 * it, most specific first — a lockfile beats a manifest.
 */
const MANAGERS = {
  pnpm: {
    detect: ['pnpm-lock.yaml', 'pnpm-workspace.yaml'], manifest: 'package.json', ecosystem: 'node',
    install: ['install'], add: ['add'], addDev: ['add', '-D'], remove: ['remove'],
    run: ['run'], outdated: ['outdated'], list: ['list', '--depth', '0'], exec: ['dlx'],
  },
  yarn: {
    detect: ['yarn.lock'], manifest: 'package.json', ecosystem: 'node',
    install: ['install'], add: ['add'], addDev: ['add', '-D'], remove: ['remove'],
    run: ['run'], outdated: ['outdated'], list: ['list', '--depth', '0'], exec: ['dlx'],
  },
  bun: {
    detect: ['bun.lockb', 'bun.lock'], manifest: 'package.json', ecosystem: 'node',
    install: ['install'], add: ['add'], addDev: ['add', '-d'], remove: ['remove'],
    run: ['run'], outdated: ['outdated'], list: ['pm', 'ls'], exec: ['x'],
  },
  npm: {
    // package.json last: a lockfile from another manager is checked first
    // (see MANAGER_ORDER), so this is the fallback for a repo with no lockfile.
    detect: ['package-lock.json', 'npm-shrinkwrap.json', 'package.json'],
    manifest: 'package.json', ecosystem: 'node',
    install: ['install'], add: ['install'], addDev: ['install', '-D'], remove: ['uninstall'],
    run: ['run'], outdated: ['outdated'], list: ['list', '--depth', '0'], exec: ['exec', '--'],
  },
  deno: {
    detect: ['deno.json', 'deno.jsonc', 'deno.lock'], manifest: 'deno.json', ecosystem: 'deno',
    install: ['install'], add: ['add'], remove: ['remove'], run: ['task'],
    outdated: ['outdated'], list: ['info'],
  },
  uv: {
    detect: ['uv.lock'], manifest: 'pyproject.toml', ecosystem: 'python',
    install: ['sync'], add: ['add'], addDev: ['add', '--dev'], remove: ['remove'],
    run: ['run'], list: ['pip', 'list'], outdated: ['pip', 'list', '--outdated'],
  },
  poetry: {
    detect: ['poetry.lock'], manifest: 'pyproject.toml', ecosystem: 'python',
    install: ['install'], add: ['add'], addDev: ['add', '--group', 'dev'], remove: ['remove'],
    run: ['run'], list: ['show'], outdated: ['show', '--outdated'],
  },
  pipenv: {
    detect: ['Pipfile.lock', 'Pipfile'], manifest: 'Pipfile', ecosystem: 'python',
    install: ['install'], add: ['install'], addDev: ['install', '--dev'], remove: ['uninstall'],
    run: ['run'], list: ['graph'], outdated: ['update', '--outdated'],
  },
  pip: {
    detect: ['requirements.txt', 'setup.py', 'pyproject.toml'], manifest: 'requirements.txt', ecosystem: 'python',
    install: ['install', '-r', 'requirements.txt'], add: ['install'], remove: ['uninstall', '-y'],
    list: ['list'], outdated: ['list', '--outdated'],
  },
  cargo: {
    detect: ['Cargo.lock', 'Cargo.toml'], manifest: 'Cargo.toml', ecosystem: 'rust',
    install: ['fetch'], add: ['add'], addDev: ['add', '--dev'], remove: ['remove'],
    run: ['run', '--bin'], list: ['tree', '--depth', '1'], outdated: ['update', '--dry-run'],
  },
  go: {
    detect: ['go.sum', 'go.mod'], manifest: 'go.mod', ecosystem: 'go',
    install: ['mod', 'download'], add: ['get'], remove: ['mod', 'tidy'],
    run: ['run'], list: ['list', '-m', 'all'], outdated: ['list', '-u', '-m', 'all'],
  },
  composer: {
    detect: ['composer.lock', 'composer.json'], manifest: 'composer.json', ecosystem: 'php',
    install: ['install'], add: ['require'], addDev: ['require', '--dev'], remove: ['remove'],
    run: ['run-script'], list: ['show'], outdated: ['outdated'],
  },
  bundler: {
    bin: 'bundle', detect: ['Gemfile.lock', 'Gemfile'], manifest: 'Gemfile', ecosystem: 'ruby',
    install: ['install'], add: ['add'], remove: ['remove'], run: ['exec'],
    list: ['list'], outdated: ['outdated'],
  },
  maven: {
    bin: 'mvn', detect: ['pom.xml'], manifest: 'pom.xml', ecosystem: 'jvm',
    install: ['install', '-DskipTests'], run: [], list: ['dependency:list'],
    outdated: ['versions:display-dependency-updates'],
  },
  gradle: {
    detect: ['build.gradle', 'build.gradle.kts', 'gradlew'], manifest: 'build.gradle', ecosystem: 'jvm',
    install: ['build', '-x', 'test'], run: [], list: ['dependencies'],
    outdated: ['dependencyUpdates'],
  },
  dotnet: {
    detect: ['*.sln', '*.csproj', '*.fsproj'], manifest: '*.csproj', ecosystem: 'dotnet',
    install: ['restore'], add: ['add', 'package'], remove: ['remove', 'package'],
    run: ['run'], list: ['list', 'package'], outdated: ['list', 'package', '--outdated'],
  },
};

const MANAGER_ORDER = Object.keys(MANAGERS);

// ------------------------------------------------------------- languages

const LANGS = {
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.jsx': 'JavaScript',
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.py': 'Python', '.pyi': 'Python', '.rb': 'Ruby', '.go': 'Go', '.rs': 'Rust',
  '.java': 'Java', '.kt': 'Kotlin', '.kts': 'Kotlin', '.scala': 'Scala', '.groovy': 'Groovy',
  '.c': 'C', '.h': 'C/C++ header', '.cc': 'C++', '.cpp': 'C++', '.cxx': 'C++', '.hpp': 'C++ header',
  '.cs': 'C#', '.fs': 'F#', '.swift': 'Swift', '.m': 'Objective-C', '.mm': 'Objective-C++',
  '.php': 'PHP', '.pl': 'Perl', '.lua': 'Lua', '.r': 'R', '.jl': 'Julia', '.dart': 'Dart',
  '.ex': 'Elixir', '.exs': 'Elixir', '.erl': 'Erlang', '.hs': 'Haskell', '.ml': 'OCaml',
  '.clj': 'Clojure', '.zig': 'Zig', '.nim': 'Nim', '.v': 'V', '.sol': 'Solidity',
  '.sh': 'Shell', '.bash': 'Shell', '.zsh': 'Shell', '.fish': 'Shell',
  '.ps1': 'PowerShell', '.psm1': 'PowerShell', '.bat': 'Batch', '.cmd': 'Batch',
  '.sql': 'SQL', '.html': 'HTML', '.htm': 'HTML', '.css': 'CSS', '.scss': 'SCSS',
  '.sass': 'Sass', '.less': 'Less', '.vue': 'Vue', '.svelte': 'Svelte', '.astro': 'Astro',
  '.json': 'JSON', '.yaml': 'YAML', '.yml': 'YAML', '.toml': 'TOML', '.xml': 'XML',
  '.md': 'Markdown', '.mdx': 'Markdown', '.rst': 'reStructuredText', '.tex': 'LaTeX',
  '.proto': 'Protobuf', '.graphql': 'GraphQL', '.gql': 'GraphQL', '.tf': 'Terraform',
  '.dockerfile': 'Dockerfile', '.gradle': 'Gradle', '.cmake': 'CMake', '.mk': 'Make',
};

/** Frameworks worth naming, detected from dependency names. */
const FRAMEWORK_HINTS = [
  [/^next$/, 'Next.js'], [/^nuxt/, 'Nuxt'], [/^react$/, 'React'], [/^vue$/, 'Vue'],
  [/^svelte$/, 'Svelte'], [/^@angular\/core$/, 'Angular'], [/^solid-js$/, 'Solid'],
  [/^astro$/, 'Astro'], [/^remix/, 'Remix'], [/^@remix-run/, 'Remix'],
  [/^express$/, 'Express'], [/^fastify$/, 'Fastify'], [/^koa$/, 'Koa'], [/^hono$/, 'Hono'],
  [/^@nestjs\/core$/, 'NestJS'], [/^electron$/, 'Electron'], [/^react-native$/, 'React Native'],
  [/^vite$/, 'Vite'], [/^webpack$/, 'webpack'], [/^esbuild$/, 'esbuild'], [/^rollup$/, 'Rollup'],
  [/^jest$/, 'Jest'], [/^vitest$/, 'Vitest'], [/^mocha$/, 'Mocha'], [/^@playwright\/test$/, 'Playwright'],
  [/^cypress$/, 'Cypress'], [/^typescript$/, 'TypeScript'], [/^eslint$/, 'ESLint'],
  [/^prettier$/, 'Prettier'], [/^tailwindcss$/, 'Tailwind'], [/^prisma$/, 'Prisma'],
  [/^drizzle-orm$/, 'Drizzle'], [/^typeorm$/, 'TypeORM'], [/^mongoose$/, 'Mongoose'],
  [/^django$/i, 'Django'], [/^flask$/i, 'Flask'], [/^fastapi$/i, 'FastAPI'],
  [/^pytest$/i, 'pytest'], [/^numpy$/i, 'NumPy'], [/^pandas$/i, 'pandas'],
  [/^torch$/i, 'PyTorch'], [/^tensorflow$/i, 'TensorFlow'],
];

// --------------------------------------------------- symbol outline rules

const OUTLINE_RULES = {
  JavaScript: [
    [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, 'function'],
    [/^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, 'arrow'],
    [/^\s{2,}(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/, 'method'],
  ],
  TypeScript: [
    [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, 'function'],
    [/^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'],
    [/^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, 'interface'],
    [/^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/, 'type'],
    [/^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/, 'enum'],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, 'arrow'],
    [/^\s{2,}(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*[:{]/, 'method'],
  ],
  Python: [
    [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, 'def'],
    [/^\s*class\s+([A-Za-z_]\w*)/, 'class'],
  ],
  Go: [
    [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, 'func'],
    [/^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/, 'type'],
  ],
  Rust: [
    [/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, 'fn'],
    [/^\s*(?:pub\s+)?struct\s+([A-Za-z_]\w*)/, 'struct'],
    [/^\s*(?:pub\s+)?enum\s+([A-Za-z_]\w*)/, 'enum'],
    [/^\s*(?:pub\s+)?trait\s+([A-Za-z_]\w*)/, 'trait'],
    [/^\s*impl(?:<[^>]*>)?\s+([A-Za-z_]\w*)/, 'impl'],
  ],
  Java: [
    [/^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?(?:abstract\s+)?class\s+(\w+)/, 'class'],
    [/^\s*(?:public|private|protected)?\s*interface\s+(\w+)/, 'interface'],
    [/^\s*(?:public|private|protected)\s+(?:static\s+)?[\w<>[\],\s]+\s+(\w+)\s*\(/, 'method'],
  ],
  'C#': [
    [/^\s*(?:public|private|protected|internal)?\s*(?:static\s+)?(?:partial\s+)?(?:class|struct|record)\s+(\w+)/, 'class'],
    [/^\s*(?:public|private|protected|internal)?\s*interface\s+(\w+)/, 'interface'],
    [/^\s*(?:public|private|protected|internal)\s+(?:static\s+|async\s+|override\s+|virtual\s+)*[\w<>[\],?\s]+\s+(\w+)\s*\(/, 'method'],
  ],
  PHP: [
    [/^\s*(?:abstract\s+|final\s+)?class\s+(\w+)/, 'class'],
    [/^\s*interface\s+(\w+)/, 'interface'],
    [/^\s*trait\s+(\w+)/, 'trait'],
    [/^\s*(?:public|private|protected)?\s*(?:static\s+)?function\s+(\w+)/, 'function'],
  ],
  Ruby: [
    [/^\s*class\s+([A-Z]\w*)/, 'class'],
    [/^\s*module\s+([A-Z]\w*)/, 'module'],
    [/^\s*def\s+([\w.?!=]+)/, 'def'],
  ],
  Shell: [[/^\s*(?:function\s+)?([A-Za-z_]\w*)\s*\(\)\s*\{/, 'function']],
  SQL: [
    [/^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|INDEX|FUNCTION|PROCEDURE|TRIGGER)\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w."]+)/i, 'ddl'],
  ],
};

const IMPORT_RULES = [
  /^\s*import\s+.*?from\s+['"]([^'"]+)['"]/,
  /^\s*import\s+['"]([^'"]+)['"]/,
  /^\s*(?:const|let|var)\s+.*?=\s*require\(\s*['"]([^'"]+)['"]\s*\)/,
  /^\s*(?:from\s+(\S+)\s+import|import\s+(\S+))/,
  /^\s*use\s+([\w:]+)/,
  /^\s*#include\s+[<"]([^>"]+)[>"]/,
  /^\s*require\s+['"]([^'"]+)['"]/,
];

export const TOOLS = [
  {
    name: 'pkg',
    description:
      'Drive whichever package manager the project uses, without having to know which: npm, pnpm, ' +
      'yarn, bun, deno, pip, uv, poetry, pipenv, cargo, go, composer, bundler, maven, gradle, ' +
      'dotnet. Actions: detect, install, add, remove, run (a script/task), scripts (list them), ' +
      'list, outdated. Detection reads lockfiles, so it picks the manager the repo actually uses.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['detect', 'install', 'add', 'remove', 'run', 'scripts', 'list', 'outdated'], description: 'What to do. Default detect.' },
        cwd: { type: 'string', description: 'Project directory. Default: server cwd.' },
        packages: { type: 'array', items: { type: 'string' }, description: 'add/remove: package names (versions allowed, e.g. "lodash@4").' },
        script: { type: 'string', description: 'run: the script or task name.' },
        args: { type: 'array', items: { type: 'string' }, description: 'run: arguments passed to the script.' },
        dev: { type: 'boolean', description: 'add: install as a dev dependency.' },
        manager: { type: 'string', description: 'Force a manager instead of detecting one.' },
        timeout_ms: { type: 'integer', description: 'Timeout. Installs default to 600000 (10 min).' },
        max_bytes: { type: 'integer', description: 'Byte cap on returned output.' },
      },
    },
  },

  {
    name: 'project_info',
    description:
      'Orient yourself in an unfamiliar repository in ONE call: languages by file count and lines, ' +
      'package manager and manifests, dependencies and detected frameworks, available scripts, ' +
      'entry points, test/build/lint commands, git branch and dirty state, and config files. ' +
      'Much cheaper than exploring the tree by hand.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Project directory. Default: server cwd.' },
        max_files: { type: 'integer', description: 'Cap on files scanned for language stats. Default 20000.' },
        deps: { type: 'boolean', description: 'Include the dependency list. Default true.' },
        max_bytes: { type: 'integer', description: 'Byte cap on returned output.' },
      },
    },
  },

  {
    name: 'code',
    description:
      'Structural views of source code: outline (functions, classes, types in a file, with line ' +
      'numbers — read this before reading the file), imports (what a file depends on), todos ' +
      '(TODO/FIXME/HACK/XXX across the tree), stats (lines of code by language).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['outline', 'imports', 'todos', 'stats'], description: 'Which view.' },
        path: { type: 'string', description: 'outline/imports: the file. todos/stats: directory to scan. Default: server cwd.' },
        glob: { type: 'array', items: { type: 'string' }, description: 'todos/stats: restrict to these globs.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'todos: which markers to look for. Default TODO, FIXME, HACK, XXX, BUG.' },
        limit: { type: 'integer', description: 'todos: max results. Default 100.' },
        max_depth: { type: 'integer', description: 'todos/stats: recursion depth. Default 24.' },
        max_bytes: { type: 'integer', description: 'Byte cap on returned output.' },
      },
      required: ['action'],
    },
  },
];

function langOf(path) {
  const base = path.split('/').pop().toLowerCase();
  if (base === 'dockerfile' || base.startsWith('dockerfile.')) return 'Dockerfile';
  if (base === 'makefile' || base === 'gnumakefile') return 'Make';
  return LANGS[extname(path).toLowerCase()] ?? null;
}

async function readJsonIfPresent(dir, name) {
  const text = await readFile(join(dir, name), 'utf8').catch(() => null);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function exists(dir, name) {
  return stat(join(dir, name)).then(() => true, () => false);
}

/** Which manager runs this project? Lockfiles win over manifests. */
async function detectManager(dir, forced) {
  if (forced) {
    if (!MANAGERS[forced]) {
      throw new Error(`Unknown manager "${forced}". One of: ${MANAGER_ORDER.join(', ')}`);
    }
    return { name: forced, ...MANAGERS[forced], why: 'forced' };
  }
  for (const name of MANAGER_ORDER) {
    const m = MANAGERS[name];
    for (const marker of m.detect) {
      if (marker.includes('*')) {
        // Glob markers (*.csproj): a shallow scan is enough.
        const { items } = await walkAll(dir, { maxDepth: 2, maxEntries: 400, showHidden: false });
        const re = new RegExp(`${marker.replace('.', '\\.').replace('*', '[^/]*')}$`);
        if (items.some((f) => re.test(f.relPath))) return { name, ...m, why: marker };
        continue;
      }
      if (await exists(dir, marker)) return { name, ...m, why: marker };
    }
  }
  return null;
}

export function createHandlers({ cfg }) {
  return {
    async pkg(p) {
      const action = p.action || 'detect';
      const dir = resolveSafePath(cfg, p.cwd ?? '.', { forWrite: action !== 'detect' && action !== 'scripts' });
      const mgr = await detectManager(dir, p.manager);
      if (!mgr) {
        return (
          `No package manager detected in ${dir}.\n` +
          `Looked for: ${MANAGER_ORDER.map((n) => MANAGERS[n].detect[0]).join(', ')}.\n` +
          `Pass manager:"npm" (or another) to force one.`
        );
      }
      const bin = mgr.bin ?? mgr.name;

      if (action === 'detect') {
        const manifest = await readJsonIfPresent(dir, 'package.json');
        return [
          `manager   ${mgr.name} (${bin}) — detected from ${mgr.why}`,
          `ecosystem ${mgr.ecosystem}`,
          `manifest  ${mgr.manifest}`,
          manifest?.name ? `project   ${manifest.name}${manifest.version ? `@${manifest.version}` : ''}` : null,
          manifest?.scripts ? `scripts   ${Object.keys(manifest.scripts).join(', ')}` : null,
        ]
          .filter(Boolean)
          .join('\n');
      }

      if (action === 'scripts') {
        if (mgr.ecosystem === 'node') {
          const manifest = await readJsonIfPresent(dir, 'package.json');
          const scripts = manifest?.scripts ?? {};
          const names = Object.keys(scripts);
          if (!names.length) return `${mgr.manifest} defines no scripts`;
          const width = Math.max(...names.map((n) => n.length));
          return (
            `${names.length} script(s) — run with pkg {action:"run", script:"<name>"}\n` +
            names.map((n) => `  ${n.padEnd(width)}  ${scripts[n]}`).join('\n')
          );
        }
        if (mgr.name === 'deno') {
          const manifest = await readJsonIfPresent(dir, 'deno.json');
          const tasks = manifest?.tasks ?? {};
          const names = Object.keys(tasks);
          return names.length
            ? `${names.length} task(s)\n${names.map((n) => `  ${n}  ${tasks[n]}`).join('\n')}`
            : 'deno.json defines no tasks';
        }
        return `"scripts" is only meaningful for node/deno projects; this is ${mgr.ecosystem} (${mgr.name}).`;
      }

      // Build the argv for the requested action.
      let args;
      switch (action) {
        case 'install':
          args = mgr.install;
          break;
        case 'add': {
          if (!p.packages?.length) throw new Error('add needs "packages"');
          const verb = p.dev && mgr.addDev ? mgr.addDev : mgr.add;
          if (!verb) throw new Error(`${mgr.name} has no "add" equivalent here — use shell_exec.`);
          args = [...verb, ...p.packages];
          break;
        }
        case 'remove': {
          if (!p.packages?.length) throw new Error('remove needs "packages"');
          if (!mgr.remove) throw new Error(`${mgr.name} has no "remove" equivalent here — use shell_exec.`);
          args = [...mgr.remove, ...p.packages];
          break;
        }
        case 'run': {
          if (!p.script) throw new Error('run needs "script"');
          if (!mgr.run?.length) {
            throw new Error(`${mgr.name} has no script runner — invoke it with shell_exec instead.`);
          }
          args = [...mgr.run, p.script];
          if (p.args?.length) {
            // npm/yarn need `--` before script arguments; pnpm/bun/deno do not.
            if (mgr.name === 'npm' || mgr.name === 'yarn') args.push('--');
            args.push(...p.args);
          }
          break;
        }
        case 'list':
          args = mgr.list;
          break;
        case 'outdated':
          args = mgr.outdated;
          break;
        default:
          throw new Error(`Unknown pkg action "${action}"`);
      }
      if (!args) throw new Error(`${mgr.name} does not support action "${action}"`);

      assertCommandAllowed(cfg, `${bin} ${args.join(' ')}`);
      const slow = ['install', 'add', 'remove', 'run', 'outdated'].includes(action);
      const run = await runArgv(cfg, {
        file: bin,
        args,
        cwd: dir,
        timeoutMs: p.timeout_ms ?? (slow ? 600000 : 120000),
        env: { CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
      });
      if (run.error) {
        throw new Error(`${run.error} — is ${bin} installed and on PATH?`);
      }

      const cap = p.max_bytes ?? cfg.maxOutputBytes;
      const stdout = shapeOutput(run.stdout, { maxBytes: cap }).text;
      const stderr = shapeOutput(run.stderr, { maxBytes: Math.min(cap, 4000) }).text;
      return [
        `${bin} ${args.join(' ')} — exit=${run.exitCode}${run.timedOut ? ' TIMED_OUT' : ''} in ${Math.round(run.durationMs / 1000)}s`,
        stdout || null,
        // Many managers write progress to stderr, so show it whatever the exit code.
        stderr ? `--- stderr ---\n${stderr}` : null,
      ]
        .filter(Boolean)
        .join('\n');
    },

    async project_info(p) {
      const dir = resolveSafePath(cfg, p.cwd ?? '.');
      const st = await stat(dir).catch(() => null);
      if (!st?.isDirectory()) throw new Error(`Not a directory: ${dir}`);

      const maxFiles = p.max_files ?? 20000;
      const byLang = new Map();
      let files = 0;
      let bytes = 0;

      for await (const f of walk(dir, { maxDepth: 24, respectGitignore: true, maxEntries: maxFiles })) {
        files++;
        bytes += f.size;
        const lang = langOf(f.relPath);
        if (!lang) continue;
        const cur = byLang.get(lang) ?? { files: 0, bytes: 0 };
        cur.files++;
        cur.bytes += f.size;
        byLang.set(lang, cur);
      }

      const manifest = await readJsonIfPresent(dir, 'package.json');
      const mgr = await detectManager(dir, null);

      // Dependencies, from whichever manifest exists.
      const deps = [];
      if (manifest) {
        for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
          for (const [name, version] of Object.entries(manifest[key] ?? {})) {
            deps.push({ name, version, dev: key === 'devDependencies' });
          }
        }
      }
      for (const [file, re] of [
        ['requirements.txt', /^\s*([A-Za-z0-9._-]+)\s*([<>=!~].*)?$/],
        ['Cargo.toml', /^\s*([A-Za-z0-9._-]+)\s*=\s*(.+)$/],
        ['go.mod', /^\s+([^\s]+)\s+(v\S+)/],
      ]) {
        if (deps.length) break;
        const text = await readFile(join(dir, file), 'utf8').catch(() => null);
        if (text === null) continue;
        let inDeps = file !== 'Cargo.toml';
        for (const line of text.split('\n')) {
          if (file === 'Cargo.toml') {
            if (/^\[dependencies\]/.test(line)) { inDeps = true; continue; }
            if (/^\[/.test(line) && inDeps) { inDeps = false; continue; }
          }
          if (!inDeps || !line.trim() || line.trim().startsWith('#') || line.trim().startsWith('//')) continue;
          const m = re.exec(line);
          if (m) deps.push({ name: m[1], version: (m[2] ?? '').trim(), dev: false });
        }
      }

      const depNames = deps.map((d) => d.name);
      const frameworks = [...new Set(
        FRAMEWORK_HINTS.filter(([re]) => depNames.some((n) => re.test(n))).map(([, label]) => label),
      )];

      // Config files worth knowing about.
      const configCandidates = [
        'tsconfig.json', 'jsconfig.json', '.eslintrc', '.eslintrc.json', 'eslint.config.js',
        '.prettierrc', 'prettier.config.js', 'vite.config.js', 'vite.config.ts',
        'webpack.config.js', 'rollup.config.js', 'babel.config.js', '.babelrc',
        'jest.config.js', 'vitest.config.ts', 'playwright.config.ts', 'tailwind.config.js',
        'Dockerfile', 'docker-compose.yml', 'compose.yaml', 'Makefile', 'justfile',
        '.env', '.env.example', '.editorconfig', '.nvmrc', '.python-version',
        'pyproject.toml', 'setup.cfg', 'tox.ini', 'ruff.toml', '.github/workflows',
        'CLAUDE.md', 'README.md', 'CONTRIBUTING.md', 'LICENSE',
      ];
      const found = [];
      for (const c of configCandidates) if (await exists(dir, c)) found.push(c);

      // Entry points.
      const entries = [];
      if (manifest?.main) entries.push(`main: ${manifest.main}`);
      if (manifest?.module) entries.push(`module: ${manifest.module}`);
      if (manifest?.bin) {
        entries.push(`bin: ${typeof manifest.bin === 'string' ? manifest.bin : Object.keys(manifest.bin).join(', ')}`);
      }
      for (const guess of ['src/index.ts', 'src/index.js', 'src/main.ts', 'src/main.py', 'main.go', 'src/main.rs', 'app.py', 'manage.py', 'index.js']) {
        if (await exists(dir, guess)) entries.push(guess);
      }

      // Git state.
      let gitLine = null;
      if (await exists(dir, '.git')) {
        const branch = await runArgv(cfg, { file: 'git', args: ['rev-parse', '--abbrev-ref', 'HEAD'], cwd: dir, timeoutMs: 10000 }).catch(() => null);
        const status = await runArgv(cfg, { file: 'git', args: ['status', '--porcelain'], cwd: dir, timeoutMs: 10000 }).catch(() => null);
        const count = status?.stdout.split('\n').filter(Boolean).length ?? 0;
        gitLine = `${branch?.stdout.trim() || '(detached)'} — ${count === 0 ? 'clean' : `${count} uncommitted change(s)`}`;
      }

      const langRows = [...byLang.entries()]
        .sort((a, b) => b[1].files - a[1].files)
        .slice(0, 12)
        .map(([lang, s]) => `  ${lang.padEnd(18)} ${String(s.files).padStart(5)} files  ${(s.bytes / 1024).toFixed(0)}KB`);

      const scripts = manifest?.scripts ?? {};
      const scriptNames = Object.keys(scripts);
      const guessCommand = (patterns) => scriptNames.find((n) => patterns.some((re) => re.test(n)));

      const out = [
        `project   ${manifest?.name ?? dir.split(/[\\/]/).pop()}${manifest?.version ? ` v${manifest.version}` : ''}`,
        `path      ${dir}`,
        `size      ${files} files, ${(bytes / 1024 / 1024).toFixed(1)}MB (gitignored paths excluded)`,
        mgr ? `manager   ${mgr.name} (from ${mgr.why}), ecosystem ${mgr.ecosystem}` : 'manager   none detected',
        gitLine ? `git       ${gitLine}` : null,
        '',
        'languages',
        ...langRows,
      ];

      if (frameworks.length) out.push('', `frameworks ${frameworks.join(', ')}`);
      if (entries.length) out.push('', `entry points`, ...entries.map((e) => `  ${e}`));

      if (scriptNames.length) {
        out.push('', `scripts (${scriptNames.length})`);
        const width = Math.max(...scriptNames.map((n) => n.length));
        out.push(...scriptNames.slice(0, 25).map((n) => `  ${n.padEnd(width)}  ${scripts[n]}`));
        const test = guessCommand([/^test/, /^spec/]);
        const build = guessCommand([/^build/, /^compile/]);
        const lint = guessCommand([/^lint/, /^check/]);
        const dev = guessCommand([/^dev/, /^start/, /^serve/]);
        const hints = [
          test && `test: pkg {action:"run", script:"${test}"}`,
          build && `build: pkg {action:"run", script:"${build}"}`,
          lint && `lint: pkg {action:"run", script:"${lint}"}`,
          dev && `dev: shell_exec_async then shell_job — it will not exit`,
        ].filter(Boolean);
        if (hints.length) out.push('', 'likely commands', ...hints.map((h) => `  ${h}`));
      }

      if (p.deps !== false && deps.length) {
        out.push('', `dependencies (${deps.filter((d) => !d.dev).length} runtime, ${deps.filter((d) => d.dev).length} dev)`);
        out.push(
          `  ${deps.filter((d) => !d.dev).map((d) => `${d.name}${d.version ? `@${d.version}` : ''}`).join(', ') || '(none)'}`,
        );
        if (deps.some((d) => d.dev)) {
          out.push(`  dev: ${deps.filter((d) => d.dev).map((d) => `${d.name}@${d.version}`).join(', ')}`);
        }
      }

      if (found.length) out.push('', `config files`, `  ${found.join(', ')}`);

      return truncateMiddle(out.join('\n'), p.max_bytes ?? cfg.maxOutputBytes).text;
    },

    async code(p) {
      const a = p.action;
      const cap = p.max_bytes ?? cfg.maxOutputBytes;

      if (a === 'outline' || a === 'imports') {
        if (!p.path) throw new Error(`${a} needs "path" (a source file)`);
        const abs = resolveSafePath(cfg, p.path);
        const st = await stat(abs).catch(() => null);
        if (!st) throw new Error(`Not found: ${abs}`);
        if (st.isDirectory()) throw new Error(`${abs} is a directory — outline works on one file.`);
        const text = await readFile(abs, 'utf8');
        const lines = text.split('\n');
        const lang = langOf(abs) ?? 'unknown';

        if (a === 'imports') {
          const hits = [];
          for (let i = 0; i < lines.length; i++) {
            for (const re of IMPORT_RULES) {
              const m = re.exec(lines[i]);
              if (m) {
                const target = m[1] ?? m[2];
                if (target) hits.push({ line: i + 1, target, text: lines[i].trim() });
                break;
              }
            }
          }
          if (!hits.length) return `${abs} (${lang}): no imports found`;
          const external = hits.filter((h) => !/^[./]/.test(h.target));
          const local = hits.filter((h) => /^[./]/.test(h.target));
          return [
            `${abs} (${lang}) — ${hits.length} import(s): ${external.length} external, ${local.length} local`,
            external.length ? `external: ${[...new Set(external.map((h) => h.target))].join(', ')}` : null,
            local.length ? `local:    ${[...new Set(local.map((h) => h.target))].join(', ')}` : null,
          ]
            .filter(Boolean)
            .join('\n');
        }

        const rules = OUTLINE_RULES[lang] ?? OUTLINE_RULES.JavaScript;
        const symbols = [];
        for (let i = 0; i < lines.length; i++) {
          for (const [re, kind] of rules) {
            const m = re.exec(lines[i]);
            if (m && m[1]) {
              const indent = lines[i].length - lines[i].trimStart().length;
              symbols.push({ line: i + 1, kind, name: m[1], indent });
              break;
            }
          }
        }
        if (!symbols.length) {
          return (
            `${abs} (${lang}, ${lines.length} lines): no symbols recognised` +
            `${OUTLINE_RULES[lang] ? '' : ` — no outline rules for ${lang}, tried JavaScript patterns`}`
          );
        }
        const width = String(lines.length).length;
        const body = symbols
          .map((s) => `${String(s.line).padStart(width)}  ${' '.repeat(Math.min(s.indent, 12))}${s.kind} ${s.name}`)
          .join('\n');
        return (
          `${abs} (${lang}, ${lines.length} lines) — ${symbols.length} symbol(s)\n` +
          truncateMiddle(body, cap).text
        );
      }

      if (a === 'todos' || a === 'stats') {
        const root = resolveSafePath(cfg, p.path ?? '.');
        const st = await stat(root).catch(() => null);
        if (!st?.isDirectory()) throw new Error(`Not a directory: ${root}`);
        const globs = Array.isArray(p.glob) && p.glob.length ? p.glob : null;
        const { compileGlobList } = await import('../glob.js');
        const include = compileGlobList(globs);

        if (a === 'stats') {
          const byLang = new Map();
          let total = 0;
          for await (const f of walk(root, { maxDepth: p.max_depth ?? 24, respectGitignore: true, maxEntries: 50000 })) {
            if (!include(f.relPath)) continue;
            const lang = langOf(f.relPath);
            if (!lang || looksBinaryPath(f.absPath) || f.size > 4_000_000) continue;
            const text = await readFile(f.absPath, 'utf8').catch(() => null);
            if (text === null) continue;
            const all = text.split('\n');
            const code = all.filter((l) => l.trim() && !/^\s*(\/\/|#|\*|\/\*|--)/.test(l)).length;
            const cur = byLang.get(lang) ?? { files: 0, lines: 0, code: 0 };
            cur.files++;
            cur.lines += all.length;
            cur.code += code;
            byLang.set(lang, cur);
            total += all.length;
          }
          if (!byLang.size) return `${root}: no recognised source files`;
          const rows = [...byLang.entries()].sort((x, y) => y[1].code - x[1].code);
          const body = rows
            .map(([lang, s]) =>
              `${lang.padEnd(20)} ${String(s.files).padStart(5)} files ${String(s.lines).padStart(8)} lines ` +
              `${String(s.code).padStart(8)} code ${String(Math.round((s.code / s.lines) * 100)).padStart(3)}%`,
            )
            .join('\n');
          const totalCode = rows.reduce((n, [, s]) => n + s.code, 0);
          return (
            `${root} — ${total} lines total, ${totalCode} lines of code across ${rows.length} language(s)\n` +
            truncateMiddle(body, cap).text
          );
        }

        const tags = p.tags?.length ? p.tags : ['TODO', 'FIXME', 'HACK', 'XXX', 'BUG'];
        const re = new RegExp(`\\b(${tags.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b[:\\s]?(.*)`);
        const limit = p.limit ?? 100;
        const hits = [];
        const counts = new Map();

        for await (const f of walk(root, { maxDepth: p.max_depth ?? 24, respectGitignore: true, maxEntries: 50000 })) {
          if (hits.length >= limit) break;
          if (!include(f.relPath)) continue;
          if (looksBinaryPath(f.absPath) || f.size > 2_000_000 || !langOf(f.relPath)) continue;
          const text = await readFile(f.absPath, 'utf8').catch(() => null);
          if (text === null) continue;
          const lines = text.split('\n');
          for (let i = 0; i < lines.length && hits.length < limit; i++) {
            const m = re.exec(lines[i]);
            if (!m) continue;
            counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
            hits.push({ file: f.relPath, line: i + 1, tag: m[1], text: (m[2] || '').trim().slice(0, 140) });
          }
        }

        if (!hits.length) return `${root}: no ${tags.join('/')} markers found`;
        const summary = [...counts.entries()].map(([t, n]) => `${t}=${n}`).join(' ');
        const body = hits.map((h) => `${h.file}:${h.line} [${h.tag}] ${h.text}`).join('\n');
        return (
          `${root} — ${hits.length} marker(s) ${summary}${hits.length >= limit ? ` (capped at ${limit})` : ''}\n` +
          truncateMiddle(body, cap).text
        );
      }

      throw new Error(`Unknown code action "${a}": outline | imports | todos | stats`);
    },
  };
}
