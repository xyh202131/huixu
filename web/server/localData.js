import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export function localDatabasePath(root, override, filename) {
  const project = createHash('sha256').update(resolve(root)).digest('hex').slice(0, 12);
  const path = override ? resolve(override) : join(process.env.LOCALAPPDATA || homedir(), 'Huixu', project, filename);
  const inWorkspace = relative(root, path);
  if (!isAbsolute(inWorkspace) && inWorkspace !== '..' && !inWorkspace.startsWith('..' + sep)) {
    throw new Error('本机数据库须放在 Web 根目录之外。');
  }
  return path;
}
