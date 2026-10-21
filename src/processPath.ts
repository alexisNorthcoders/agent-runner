import { homedir } from 'os';
import { join } from 'path';

/** PATH with the dirs often missing when started by PM2/systemd rather than an interactive shell. */
export function augmentedPathEnv(base = process.env.PATH || '') {
  const home = homedir();
  const extra = [join(home, '.local', 'bin'), join(home, '.claude', 'local'), '/usr/local/bin'].join(':');
  return base ? `${extra}:${base}` : extra;
}
