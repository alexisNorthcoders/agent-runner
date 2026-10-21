/** True if a process with this pid exists (EPERM means it does, but belongs to someone else). */
export function pidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e instanceof Error && 'code' in e && e.code === 'EPERM';
  }
}
