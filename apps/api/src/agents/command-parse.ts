/**
 * A small, conservative reader for shell command lines, used by the tool policy to see
 * which programs a Bash command would run. It is not a full shell parser: anything it
 * cannot follow is flagged (`dynamic`) so the policy can ask instead of guessing.
 *
 * It understands quoting and escapes, `;` `&&` `||` `|` `&` and newlines, subshells,
 * `$( )`, backticks and `<( )` (whose contents are read as commands too), redirections,
 * environment prefixes (`FOO=1 cmd`), wrappers (`env`, `nohup`, `timeout`, `xargs`, `npx`,
 * `bundle exec`, `python -m`, ...) and `bash -c '...'` / `eval '...'` (read recursively).
 */

export interface ParsedCommand {
  /** argv with argv[0] reduced to a lower-case program name (`/usr/bin/psql` -> `psql`). */
  argv: string[];
  /** The command line set variables in front of the program (`PAGER=x git log`). */
  envPrefix: boolean;
  /** The program name or a wrapper argument is computed at run time (`$x`, `$(...)`). */
  dynamic: boolean;
}

export interface CommandAnalysis {
  commands: ParsedCommand[];
  /** Output redirected to a file (anything except /dev/null or another descriptor). */
  writes: boolean;
  /** Uses `$( )`, backticks or process substitution anywhere. */
  substitution: boolean;
  /** Something could not be followed (eval of a variable, nesting too deep, unbalanced quotes). */
  dynamic: boolean;
  /** Uses a here-document. */
  heredoc: boolean;
}

interface Word {
  text: string;
  /** Contains an unquoted or double-quoted expansion ($VAR, ${..}, $(..), `..`). */
  dynamic: boolean;
}

interface RawSegment {
  words: Word[];
}

interface Scan {
  segments: RawSegment[];
  inner: string[];
  writes: boolean;
  substitution: boolean;
  heredoc: boolean;
  broken: boolean;
}

const MAX_DEPTH = 6;

/** Finds the end of a `$(`-style group starting after the opening paren; returns the index of `)`. */
function matchParen(s: string, start: number): number {
  let depth = 1;
  let quote: '"' | "'" | null = null;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (c === '\\') {
      i++;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}

function scan(input: string, ps: boolean): Scan {
  // PowerShell escapes with a backtick and treats backslashes as path separators.
  const esc = ps ? '`' : '\\';
  const out: Scan = { segments: [], inner: [], writes: false, substitution: false, heredoc: false, broken: false };
  let words: Word[] = [];
  let cur = '';
  let curDynamic = false;
  let inWord = false;
  let pendingRedirect: 'out' | 'in' | 'herestring' | null = null;

  const endWord = () => {
    if (!inWord) return;
    const w = { text: cur, dynamic: curDynamic };
    if (pendingRedirect) {
      if (pendingRedirect === 'out' && !/^(\/dev\/null|&\d*-?|\d)$/.test(w.text)) out.writes = true;
      pendingRedirect = null;
    } else {
      words.push(w);
    }
    cur = '';
    curDynamic = false;
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length) out.segments.push({ words });
    words = [];
  };
  const substitution = (body: string) => {
    out.substitution = true;
    out.inner.push(body);
    curDynamic = true;
    inWord = true;
    cur += '$(…)';
  };

  const s = input;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const next = s[i + 1];

    // Comments: # at the start of a word runs to the end of the line.
    if (c === '#' && !inWord) {
      while (i < s.length && s[i] !== '\n') i++;
      endSegment();
      continue;
    }
    if (c === esc) {
      if (next === '\n') {
        i++;
        continue;
      }
      if (next !== undefined) {
        cur += next;
        inWord = true;
        i++;
      }
      continue;
    }
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) {
        out.broken = true;
        cur += s.slice(i + 1);
        inWord = true;
        break;
      }
      cur += s.slice(i + 1, end);
      inWord = true;
      i = end;
      continue;
    }
    if (c === '"') {
      inWord = true;
      let j = i + 1;
      for (; j < s.length && s[j] !== '"'; j++) {
        const d = s[j]!;
        if (d === esc && j + 1 < s.length) {
          const e = s[j + 1]!;
          // Inside double quotes a backslash only escapes $ ` " \ and newline.
          if (ps || '$`"\\\n'.includes(e)) {
            if (e !== '\n') cur += e;
            j++;
            continue;
          }
          cur += d;
          continue;
        }
        if (d === '$' && s[j + 1] === '(') {
          const end = matchParen(s, j + 2);
          if (end < 0) {
            out.broken = true;
            j = s.length;
            break;
          }
          substitution(s.slice(j + 2, end));
          j = end;
          continue;
        }
        if (!ps && d === '`') {
          const end = s.indexOf('`', j + 1);
          if (end < 0) {
            out.broken = true;
            j = s.length;
            break;
          }
          substitution(s.slice(j + 1, end));
          j = end;
          continue;
        }
        if (d === '$' && /[A-Za-z_{@*#?$!0-9-]/.test(s[j + 1] ?? '')) curDynamic = true;
        cur += d;
      }
      if (j >= s.length) out.broken = true;
      i = j;
      continue;
    }
    if (c === '$' && next === '(') {
      const end = matchParen(s, i + 2);
      if (end < 0) {
        out.broken = true;
        break;
      }
      // $(( arithmetic )) is not a command, but treat it the same way: conservative.
      substitution(s.slice(i + 2, end));
      i = end;
      continue;
    }
    if (!ps && c === '`') {
      const end = s.indexOf('`', i + 1);
      if (end < 0) {
        out.broken = true;
        break;
      }
      substitution(s.slice(i + 1, end));
      i = end;
      continue;
    }
    if ((c === '<' || c === '>') && next === '(') {
      const end = matchParen(s, i + 2);
      if (end < 0) {
        out.broken = true;
        break;
      }
      endWord();
      out.substitution = true;
      out.inner.push(s.slice(i + 2, end));
      words.push({ text: '<(…)', dynamic: true });
      i = end;
      continue;
    }
    if (c === '$') {
      if (/[A-Za-z_{@*#?$!0-9'"-]/.test(next ?? '')) curDynamic = true; // $'..' and $".." are expansions too
      cur += c;
      inWord = true;
      continue;
    }
    if (c === '>' || c === '<') {
      // "2>" / "1>>": the digits are a descriptor, not a word.
      if (inWord && /^\d+$/.test(cur) && !curDynamic) {
        cur = '';
        inWord = false;
      } else {
        endWord();
      }
      if (c === '<' && next === '<') {
        if (s[i + 2] === '<') {
          pendingRedirect = 'herestring';
          i += 2;
        } else {
          out.heredoc = true;
          pendingRedirect = 'in';
          i += 1;
          if (s[i + 1] === '-') i++;
        }
        continue;
      }
      if (c === '>') {
        if (next === '>' || next === '|') i++;
        if (s[i + 1] === '&') {
          // >&2, >&- : descriptor duplication; ">& file" also writes, caught by the word check.
          i++;
          cur = '&';
          inWord = true;
        }
        pendingRedirect = 'out';
      } else {
        if (next === '&' || next === '>') i++;
        pendingRedirect = 'in';
      }
      continue;
    }
    if (c === '&' && next === '>') {
      // &> file, &>> file: stdout and stderr to a file.
      endWord();
      i++;
      if (s[i + 1] === '>') i++;
      pendingRedirect = 'out';
      continue;
    }
    if (c === ';' || c === '&' || c === '|' || c === '\n' || c === '(' || c === ')') {
      endSegment();
      // Skip the second character of && || |& ;; so it does not start an empty segment.
      if ((c === '&' && next === '&') || (c === '|' && (next === '|' || next === '&')) || (c === ';' && next === ';')) i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      continue;
    }
    cur += c;
    inWord = true;
  }
  endSegment();
  return out;
}

/** `/usr/bin/psql`, `C:\\tools\\psql.exe`, `./node_modules/.bin/prisma` -> `psql` / `prisma`. */
export function programName(word: string): string {
  const base = word.split(/[\\/]/).pop() ?? word;
  return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
/** Shell keywords and grouping words that may precede a command. */
const PREFIX_WORDS = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'time', 'esac', 'in']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'busybox']);

/** Options of wrapper programs that take a separate value (`timeout -s KILL 5 cmd`). */
const WRAPPER_VALUE_OPTS: Record<string, Set<string>> = {
  env: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']),
  exec: new Set(['-a']),
  nice: new Set(['-n', '--adjustment']),
  timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
  stdbuf: new Set(['-i', '-o', '-e']),
  ionice: new Set(['-c', '-n', '-p']),
  xargs: new Set(['-I', '-n', '-P', '-d', '-L', '-s', '-E', '-a', '--max-args', '--max-procs', '--delimiter', '--arg-file', '-i']),
  watch: new Set(['-n', '--interval', '-d']),
  npx: new Set(['-p', '--package', '-c', '--call']),
  bunx: new Set(['-p', '--package']),
  pnpx: new Set(['-p', '--package']),
  flock: new Set(['-w', '--timeout', '-E']),
  setsid: new Set([]),
  doppler: new Set([]),
};

/** Programs that run the program named after their own options. */
const WRAPPERS = new Set(['env', 'command', 'builtin', 'exec', 'nohup', 'nice', 'timeout', 'stdbuf', 'ionice', 'xargs', 'watch', 'npx', 'bunx', 'pnpx', 'time', 'setsid', 'chronic', 'unbuffer', 'flock', 'caffeinate', 'strace', 'ltrace']);

/** `npm exec x`, `pnpm dlx x`, `bundle exec x`, `poetry run x`, `dotnet tool run x`... */
const SUB_WRAPPERS: Record<string, Set<string>> = {
  npm: new Set(['exec', 'x']),
  pnpm: new Set(['exec', 'dlx']),
  yarn: new Set(['exec', 'dlx']),
  bun: new Set(['x', 'exec']),
  bundle: new Set(['exec']),
  poetry: new Set(['run']),
  pipenv: new Set(['run']),
  uv: new Set(['run']),
  pdm: new Set(['run']),
  hatch: new Set(['run']),
  rye: new Set(['run']),
  conda: new Set(['run']),
  mise: new Set(['exec', 'x']),
  asdf: new Set(['exec']),
  direnv: new Set(['exec']),
  dotenv: new Set(['--']),
};

interface Resolved {
  argv: string[];
  envPrefix: boolean;
  dynamic: boolean;
  /** A shell string to read recursively (bash -c '...', eval '...'). */
  inner?: string;
}

function resolve(input: Word[]): Resolved | null {
  let words = input;
  let i = 0;
  let envPrefix = false;
  let dynamic = false;
  while (i < words.length && PREFIX_WORDS.has(words[i]!.text)) i++;
  while (i < words.length && ASSIGNMENT.test(words[i]!.text)) {
    envPrefix = true;
    i++;
  }
  for (let guard = 0; guard < 16 && i < words.length; guard++) {
    const w = words[i]!;
    // A program name computed at run time ($cmd, $(which psql)) or matched by a glob
    // (/usr/bin/ps?l) cannot be checked.
    if (w.dynamic || /[*?[\]{]/.test(w.text)) dynamic = true;
    const name = programName(w.text);

    if (name === 'eval') {
      const rest = words.slice(i + 1);
      return { argv: ['eval'], envPrefix, dynamic: dynamic || rest.some((x) => x.dynamic), inner: rest.map((x) => x.text).join(' ') };
    }
    if (SHELLS.has(name)) {
      // sh -c 'cmd', bash -lc 'cmd', bash -e -c 'cmd'
      let j = i + 1;
      while (j < words.length && words[j]!.text.startsWith('-')) {
        const opt = words[j]!.text;
        if (/^-[a-z]*c[a-z]*$/i.test(opt) && !opt.startsWith('--')) {
          const body = words[j + 1];
          if (!body) return { argv: [name], envPrefix, dynamic };
          return { argv: [name, '-c'], envPrefix, dynamic: dynamic || body.dynamic, inner: body.text };
        }
        if (opt === '-o' || opt === '+o' || opt === '--rcfile' || opt === '--init-file') j++;
        j++;
      }
      return { argv: [name, ...words.slice(i + 1).map((x) => x.text)], envPrefix, dynamic };
    }
    if (WRAPPERS.has(name)) {
      const valueOpts = WRAPPER_VALUE_OPTS[name] ?? new Set<string>();
      // timeout DURATION cmd, flock FILE cmd: one positional argument before the program.
      let positional = name === 'timeout' || name === 'flock' ? 1 : 0;
      let j = i + 1;
      while (j < words.length) {
        const t = words[j]!.text;
        if (t === '--') {
          j++;
          break;
        }
        if (name === 'env' && ASSIGNMENT.test(t)) {
          envPrefix = true;
          j++;
          continue;
        }
        if (t.startsWith('-') && t.length > 1) {
          j += valueOpts.has(t) ? 2 : 1;
          continue;
        }
        if (positional > 0) {
          positional--;
          j++;
          continue;
        }
        break;
      }
      // npx -y pkg@1.2 -> program "pkg"
      if (j >= words.length) return { argv: [name], envPrefix, dynamic };
      i = j;
      if (name === 'npx' || name === 'bunx' || name === 'pnpx') words = stripVersion(words, i);
      continue;
    }
    const subs = SUB_WRAPPERS[name];
    if (subs && words[i + 1] && subs.has(words[i + 1]!.text)) {
      let j = i + 2;
      while (j < words.length && words[j]!.text.startsWith('-')) j++;
      if (j >= words.length) return { argv: [name, words[i + 1]!.text], envPrefix, dynamic };
      i = j;
      words = stripVersion(words, i);
      continue;
    }
    // python -m alembic upgrade -> alembic upgrade
    if (/^python(\d+(\.\d+)?)?$/.test(name) || name === 'py') {
      const m = words.findIndex((x, k) => k > i && x.text === '-m');
      if (m > 0 && words[m + 1] && words.slice(i + 1, m).every((x) => x.text.startsWith('-'))) {
        i = m + 1;
        continue;
      }
    }
    return { argv: [name, ...words.slice(i + 1).map((x) => x.text)], envPrefix, dynamic };
  }
  return words.length > i ? { argv: [programName(words[i]!.text)], envPrefix, dynamic: true } : null;
}

function stripVersion(words: Word[], i: number): Word[] {
  const w = words[i];
  if (!w) return words;
  // @scope/pkg@1.2.3 -> @scope/pkg ; prisma@5 -> prisma ; then the program is the package's last segment
  const m = /^(@?[^@]+)(@.*)?$/.exec(w.text);
  if (!m || !m[2]) return words;
  const copy = words.slice();
  copy[i] = { ...w, text: m[1]! };
  return copy;
}

export interface AnalyzeOptions {
  /** PowerShell: backtick is the escape character and backslashes are literal. */
  dialect?: 'bash' | 'powershell';
}

export function analyzeCommand(command: string, opts: AnalyzeOptions = {}, depth = 0): CommandAnalysis {
  const result: CommandAnalysis = { commands: [], writes: false, substitution: false, dynamic: false, heredoc: false };
  if (depth > MAX_DEPTH) {
    result.dynamic = true;
    return result;
  }
  const s = scan(command, opts.dialect === 'powershell');
  result.writes = s.writes;
  result.substitution = s.substitution;
  result.heredoc = s.heredoc;
  result.dynamic = s.broken;

  const merge = (inner: CommandAnalysis) => {
    result.commands.push(...inner.commands);
    result.writes ||= inner.writes;
    result.substitution ||= inner.substitution;
    result.dynamic ||= inner.dynamic;
    result.heredoc ||= inner.heredoc;
  };

  for (const body of s.inner) merge(analyzeCommand(body, opts, depth + 1));
  for (const seg of s.segments) {
    const r = resolve(seg.words);
    if (!r) continue;
    result.commands.push({ argv: r.argv, envPrefix: r.envPrefix, dynamic: r.dynamic });
    if (r.dynamic) result.dynamic = true;
    if (r.inner !== undefined) merge(analyzeCommand(r.inner, opts, depth + 1));
    // find -exec CMD {} ; runs CMD for each file.
    if (r.argv[0] === 'find') {
      r.argv.forEach((a, k) => {
        if (!/^-(exec|execdir|ok|okdir)$/.test(a)) return;
        const end = r.argv.findIndex((b, n) => n > k && (b === ';' || b === '+'));
        const sub = resolve(r.argv.slice(k + 1, end < 0 ? undefined : end).map((text) => ({ text, dynamic: false })));
        if (sub) result.commands.push({ argv: sub.argv, envPrefix: sub.envPrefix, dynamic: sub.dynamic });
      });
    }
  }
  return result;
}

/** The command text with quotes and backslashes removed, for coarse keyword checks. */
export function flatten(command: string): string {
  return command.replace(/\\\n/g, '').replace(/["'\\]/g, '');
}
