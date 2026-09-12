// A tiny, side-effect-free expression language for shell_bulk step conditions
// and ${...} interpolation. No eval(), no function calls into user code:
// just literals, path lookups, comparisons, boolean logic and a fixed set of
// helper functions.
//
//   prev.exit == 0 && !contains(prev.stdout, "error")
//   step.build.ok || vars.branch == "main"
//   matches(prev.stdout, "^v[0-9]+") && len(steps) > 2

const FUNCS = {
  contains: (h, n) => String(h ?? '').includes(String(n ?? '')),
  icontains: (h, n) => String(h ?? '').toLowerCase().includes(String(n ?? '').toLowerCase()),
  matches: (s, re, flags) => new RegExp(String(re), typeof flags === 'string' ? flags : '').test(String(s ?? '')),
  empty: (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0),
  len: (v) => (v === null || v === undefined ? 0 : Array.isArray(v) || typeof v === 'string' ? v.length : Object.keys(v).length),
  lower: (s) => String(s ?? '').toLowerCase(),
  upper: (s) => String(s ?? '').toUpperCase(),
  trim: (s) => String(s ?? '').trim(),
  int: (v) => {
    const n = parseInt(String(v ?? '').trim(), 10);
    return Number.isNaN(n) ? 0 : n;
  },
  num: (v) => {
    const n = Number(String(v ?? '').trim());
    return Number.isNaN(n) ? 0 : n;
  },
  lines: (s) => String(s ?? '').split('\n').filter((l) => l !== '').length,
  first_line: (s) => String(s ?? '').split('\n')[0] ?? '',
  last_line: (s) => {
    const parts = String(s ?? '').replace(/\n+$/, '').split('\n');
    return parts[parts.length - 1] ?? '';
  },
  exists: (v) => v !== null && v !== undefined,
  not: (v) => !truthy(v),
};

export function truthy(v) {
  if (v === null || v === undefined || v === false) return false;
  if (v === 0 || v === '') return false;
  if (typeof v === 'string') return !/^(false|0|no|off)$/i.test(v.trim());
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

// ---------------------------------------------------------------- tokenizer

const PUNCT = ['&&', '||', '==', '!=', '>=', '<=', '=~', '!~', '(', ')', ',', '.', '[', ']', '!', '>', '<'];

function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }

    if (c === '"' || c === "'") {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += src[j++];
        }
      }
      if (j >= src.length) throw new Error(`Unterminated string in expression: ${src}`);
      toks.push({ t: 'str', v: out });
      i = j + 1;
      continue;
    }

    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      toks.push({ t: 'num', v: Number(src.slice(i, j)) });
      i = j;
      continue;
    }

    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
      const word = src.slice(i, j);
      if (word === 'true') toks.push({ t: 'lit', v: true });
      else if (word === 'false') toks.push({ t: 'lit', v: false });
      else if (word === 'null') toks.push({ t: 'lit', v: null });
      else if (word === 'and') toks.push({ t: 'op', v: '&&' });
      else if (word === 'or') toks.push({ t: 'op', v: '||' });
      else toks.push({ t: 'id', v: word });
      i = j;
      continue;
    }

    const two = src.slice(i, i + 2);
    if (PUNCT.includes(two)) { toks.push({ t: 'op', v: two }); i += 2; continue; }
    if (PUNCT.includes(c)) { toks.push({ t: 'op', v: c }); i += 1; continue; }
    throw new Error(`Unexpected character "${c}" in expression: ${src}`);
  }
  return toks;
}

// ------------------------------------------------------------------- parser

class Parser {
  constructor(toks, src) {
    this.toks = toks;
    this.i = 0;
    this.src = src;
  }
  peek() { return this.toks[this.i]; }
  next() { return this.toks[this.i++]; }
  eat(v) {
    const t = this.peek();
    if (t && t.t === 'op' && t.v === v) { this.i++; return true; }
    return false;
  }
  expect(v) {
    if (!this.eat(v)) throw new Error(`Expected "${v}" in expression: ${this.src}`);
  }

  parse() {
    const node = this.or();
    if (this.i < this.toks.length) {
      throw new Error(`Unexpected trailing input in expression: ${this.src}`);
    }
    return node;
  }

  or() {
    let left = this.and();
    while (this.eat('||')) left = { k: 'or', left, right: this.and() };
    return left;
  }
  and() {
    let left = this.unary();
    while (this.eat('&&')) left = { k: 'and', left, right: this.unary() };
    return left;
  }
  unary() {
    if (this.eat('!')) return { k: 'not', arg: this.unary() };
    return this.compare();
  }
  compare() {
    const left = this.primary();
    const t = this.peek();
    if (t && t.t === 'op' && ['==', '!=', '>', '<', '>=', '<=', '=~', '!~'].includes(t.v)) {
      this.next();
      return { k: 'cmp', op: t.v, left, right: this.primary() };
    }
    return left;
  }
  primary() {
    if (this.eat('(')) {
      const e = this.or();
      this.expect(')');
      return e;
    }
    const t = this.next();
    if (!t) throw new Error(`Unexpected end of expression: ${this.src}`);
    if (t.t === 'str') return { k: 'lit', v: t.v };
    if (t.t === 'num') return { k: 'lit', v: t.v };
    if (t.t === 'lit') return { k: 'lit', v: t.v };
    if (t.t === 'id') {
      if (this.peek() && this.peek().t === 'op' && this.peek().v === '(') {
        this.next();
        const args = [];
        if (!this.eat(')')) {
          do { args.push(this.or()); } while (this.eat(','));
          this.expect(')');
        }
        return { k: 'call', name: t.v, args };
      }
      return this.path({ k: 'var', name: t.v });
    }
    throw new Error(`Unexpected token "${t.v}" in expression: ${this.src}`);
  }
  path(base) {
    let node = base;
    for (;;) {
      if (this.eat('.')) {
        const t = this.next();
        if (!t || (t.t !== 'id' && t.t !== 'num')) {
          throw new Error(`Expected property name after "." in: ${this.src}`);
        }
        node = { k: 'member', obj: node, prop: String(t.v) };
      } else if (this.eat('[')) {
        const idx = this.or();
        this.expect(']');
        node = { k: 'index', obj: node, index: idx };
      } else {
        return node;
      }
    }
  }
}

// ------------------------------------------------------------------ evaluator

function evalNode(n, ctx) {
  switch (n.k) {
    case 'lit': return n.v;
    case 'var': return ctx[n.name];
    case 'member': {
      const o = evalNode(n.obj, ctx);
      return o === null || o === undefined ? undefined : o[n.prop];
    }
    case 'index': {
      const o = evalNode(n.obj, ctx);
      const i = evalNode(n.index, ctx);
      return o === null || o === undefined ? undefined : o[i];
    }
    case 'not': return !truthy(evalNode(n.arg, ctx));
    case 'and': return truthy(evalNode(n.left, ctx)) ? truthy(evalNode(n.right, ctx)) : false;
    case 'or': return truthy(evalNode(n.left, ctx)) ? true : truthy(evalNode(n.right, ctx));
    case 'call': {
      const fn = FUNCS[n.name];
      if (!fn) {
        throw new Error(`Unknown function "${n.name}". Available: ${Object.keys(FUNCS).join(', ')}`);
      }
      return fn(...n.args.map((a) => evalNode(a, ctx)));
    }
    case 'cmp': {
      const a = evalNode(n.left, ctx);
      const b = evalNode(n.right, ctx);
      switch (n.op) {
        case '==': return looseEq(a, b);
        case '!=': return !looseEq(a, b);
        case '>': return numOf(a) > numOf(b);
        case '<': return numOf(a) < numOf(b);
        case '>=': return numOf(a) >= numOf(b);
        case '<=': return numOf(a) <= numOf(b);
        case '=~': return new RegExp(String(b)).test(String(a ?? ''));
        case '!~': return !new RegExp(String(b)).test(String(a ?? ''));
        default: throw new Error(`Unsupported operator ${n.op}`);
      }
    }
    default: throw new Error(`Bad expression node ${n.k}`);
  }
}

function looseEq(a, b) {
  if (typeof a === 'boolean' || typeof b === 'boolean') return truthy(a) === truthy(b);
  if (typeof a === 'number' || typeof b === 'number') return numOf(a) === numOf(b);
  return String(a ?? '') === String(b ?? '');
}

function numOf(v) {
  if (typeof v === 'number') return v;
  if (v === true) return 1;
  if (v === false || v === null || v === undefined) return 0;
  const n = Number(String(v).trim());
  return Number.isNaN(n) ? NaN : n;
}

const cache = new Map();

export function compile(src) {
  if (cache.has(src)) return cache.get(src);
  const ast = new Parser(tokenize(src), src).parse();
  const fn = (ctx) => evalNode(ast, ctx);
  if (cache.size < 500) cache.set(src, fn);
  return fn;
}

/** Evaluate `src` against `ctx` and coerce the result to a boolean. */
export function evaluate(src, ctx) {
  return truthy(compile(src)(ctx));
}

/** Evaluate `src` and return the raw value (used by ${...} interpolation). */
export function evaluateValue(src, ctx) {
  return compile(src)(ctx);
}

/**
 * Replace every ${expr} in `template` with its evaluated value.
 *
 * `${...}` is ALSO shell syntax (`${HOME}`, `${PATH%%:*}`, `${#arr}`) and
 * GitHub Actions syntax (`${{ matrix.node }}`), so anything that does not
 * resolve to a defined value is left exactly as written and passed through to
 * whatever consumes it. Only names this context actually knows get replaced.
 * That way `echo ${HOME}` still reaches bash intact while `${vars.sha}` is
 * substituted here.
 *
 * `$${...}` is an explicit escape that yields a literal `${...}`.
 *
 * Names that looked like a lookup but resolved to nothing are pushed onto
 * `unresolved`, so a caller can point out a likely typo instead of leaving it
 * silently wrong.
 */
/** Roots this context owns — used to tell a typo from shell syntax. */
const OURS_RE = /^(vars|prev|step|steps|env|platform|failed_count|ok_count|skipped_count|index)\b/;

export function interpolate(template, ctx, { unresolved = null } = {}) {
  if (typeof template !== 'string' || !template.includes('${')) return template;
  let out = '';
  let i = 0;

  while (i < template.length) {
    const at = template.indexOf('${', i);
    if (at === -1) { out += template.slice(i); break; }

    if (at > 0 && template[at - 1] === '$') {
      // `$${x}` -> literal `${x}`
      out += template.slice(i, at - 1) + '${';
      i = at + 2;
      const close = findClose(template, i);
      if (close === -1) { out += template.slice(i); break; }
      out += template.slice(i, close) + '}';
      i = close + 1;
      continue;
    }

    out += template.slice(i, at);
    const close = findClose(template, at + 2);
    if (close === -1) {
      // Unclosed: it is not ours to interpret.
      out += template.slice(at);
      break;
    }

    const raw = template.slice(at + 2, close);
    const expr = raw.trim();
    const literal = `\${${raw}}`;

    if (expr === '') {
      out += literal;
      i = close + 1;
      continue;
    }

    let value;
    try {
      value = evaluateValue(expr, ctx);
    } catch {
      // Not an expression we can parse (shell or Actions syntax): pass it on.
      out += literal;
      i = close + 1;
      continue;
    }

    if (value === undefined) {
      // Parsed, but nothing by that name here. Only flag it when it names one
      // of OUR roots: a bare `${SOMETHING}` is almost certainly shell syntax,
      // and calling that a typo would be noise on every second command.
      if (unresolved && OURS_RE.test(expr) && !unresolved.includes(expr)) unresolved.push(expr);
      out += literal;
      i = close + 1;
      continue;
    }

    out += value === null ? '' : String(value);
    i = close + 1;
  }

  return out;
}

/** Index of the matching `}`, or -1 when there is none. */
function findClose(s, from) {
  let depth = 1;
  for (let i = from; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

export const FUNCTION_NAMES = Object.keys(FUNCS);
