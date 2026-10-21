import { mkdir, rename, writeFile } from 'fs/promises';
import { dirname } from 'path';

/** Write JSON via a temp file + rename, so readers never see a torn file. */
export async function writeJsonAtomic(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data), 'utf8');
  await rename(tmp, path);
}
