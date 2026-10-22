// Type-checks the remaining JS with jsconfig.json. The .ts files it imports are checked by the
// strict pass (tsconfig.json), so their diagnostics are dropped here: under these loose settings
// they report errors that strict mode does not. TypeScript 7 has no JS compiler API, so this
// filters tsc's plain output, where each diagnostic starts on an unindented line.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tsc = fileURLToPath(new URL('bin/tsc', import.meta.resolve('typescript/package.json')));
const res = spawnSync(process.execPath, [tsc, '-p', 'jsconfig.json', '--pretty', 'false'], { encoding: 'utf8' });

const diagnostics: string[][] = [];
for (const line of res.stdout.split('\n')) {
  if (!line) continue;
  if (/^\s/.test(line) && diagnostics.length) diagnostics[diagnostics.length - 1].push(line);
  else diagnostics.push([line]);
}
const kept = diagnostics.filter(([first]) => !/^[^(]+\.ts\(\d+,\d+\): /.test(first));

// tsc exits 1 or 2 with diagnostics; anything else, or a failure that printed none, is a crash
const crashed = res.error || res.signal || ![0, 1, 2].includes(res.status ?? -1) || (res.status !== 0 && !diagnostics.length);
if (kept.length || crashed) {
  console.error([...kept.flat(), res.stderr, res.error?.message ?? ''].filter(Boolean).join('\n'));
  process.exit(1);
}
