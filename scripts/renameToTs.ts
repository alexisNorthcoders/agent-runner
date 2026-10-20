import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

const SPECIFIER_RE = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]+)\2/g;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function renameAll(files: string[]): Map<string, string> {
  const renames = new Map<string, string>();
  for (const file of files) {
    const from = path.relative(root, path.resolve(file));
    if (!from.endsWith('.js')) throw new Error(`not a .js file: ${file}`);
    const to = from.replace(/\.js$/, '.ts');
    if (existsSync(path.join(root, from))) {
      git('mv', from, to);
    } else if (!existsSync(path.join(root, to))) {
      throw new Error(`neither ${from} nor ${to} exists`);
    }
    renames.set(from, to);
  }
  return renames;
}

function rewriteSpecifiers(file: string, text: string, renames: Map<string, string>): string {
  return text.replace(SPECIFIER_RE, (match, lead: string, quote: string, spec: string) => {
    const target = path.relative(root, path.resolve(root, path.dirname(file), spec));
    if (!renames.has(target)) return match;
    return `${lead}${quote}${spec.replace(/\.js$/, '.ts')}${quote}`;
  });
}

function rewriteMentions(text: string, mentions: [RegExp, string][]): string {
  for (const [pattern, replacement] of mentions) text = text.replace(pattern, replacement);
  return text;
}

const renames = renameAll(process.argv.slice(2));

const trackedFiles = git('ls-files').split('\n');
const trackedBasenames = trackedFiles.map((f) => path.basename(f));
const jsFiles = [...trackedFiles, ...renames.keys()];

function uniqueTail(from: string): string | undefined {
  const parts = from.split('/');
  for (let i = parts.length - 2; i > 0; i--) {
    const tail = parts.slice(i).join('/');
    if (jsFiles.filter((f) => f === tail || f.endsWith(`/${tail}`)).length === 1) return tail;
  }
}

const mentions: [RegExp, string][] = [...renames].flatMap(([from, to]): [RegExp, string][] => {
  const name = path.basename(from);
  const unique = !trackedBasenames.includes(name) && [...renames.keys()].filter((f) => path.basename(f) === name).length === 1;
  if (unique) return [[new RegExp(`(?<![\\w.-])${escapeRegExp(name)}\\b`, 'g'), path.basename(to)]];
  const full: [RegExp, string] = [new RegExp(`(?<![\\w.-]|[\\w-]/|\\.\\./)${escapeRegExp(from)}\\b`, 'g'), to];
  const tail = uniqueTail(from);
  if (!tail) return [full];
  return [full, [new RegExp(`(?<![\\w./-])${escapeRegExp(tail)}\\b`, 'g'), tail.replace(/\.js$/, '.ts')]];
});

const basenames = [...renames.keys()].flatMap((f) => ['-e', path.basename(f)]);
const candidates = git('grep', '-lIF', ...basenames)
  .split('\n')
  .filter((f) => f && f !== 'package-lock.json');

for (const file of candidates) {
  const abs = path.join(root, file);
  const before = readFileSync(abs, 'utf8');
  let after = rewriteMentions(before, mentions);
  if (/\.(m?js|ts)$/.test(file)) after = rewriteSpecifiers(file, after, renames);
  if (after !== before) {
    writeFileSync(abs, after);
    console.log(`rewrote ${file}`);
  }
}
