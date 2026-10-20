import { realpath, lstat, readdir, readFile, writeFile, copyFile, rename, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, dirname, relative, isAbsolute, join } from 'node:path';
import { BridgeError, type Params } from '../types.js';
import { nativeCall } from '../native.js';
export async function scopedPath(value: unknown, roots: string[], create = false): Promise<string> {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw new BridgeError('INVALID_PATH', 'An absolute path is required.');
  const path = resolve(value);
  let actual: string;
  try { actual = await realpath(path); } catch (e) { if (!create || (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; actual = join(await realpath(dirname(path)), path.slice(dirname(path).length + 1)); }
  for (const root of roots) { let canonical: string; try { canonical = await realpath(root); } catch { continue; } const rel = relative(canonical, actual); if (rel === '' || (!rel.startsWith('..' + '/') && rel !== '..' && !isAbsolute(rel))) return actual; }
  throw new BridgeError('PATH_OUTSIDE_ROOTS', 'Path is outside configured file roots, including resolved symlinks.');
}
async function absent(path: string) { try { await lstat(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; } throw new BridgeError('DESTINATION_EXISTS', 'Refusing to overwrite an existing path.'); }
export async function fileAction(name: string, args: Params, roots: string[]) {
  const path = args.path ? await scopedPath(args.path, roots, ['finder_write_file', 'finder_create_directory'].includes(name)) : '';
  switch (name) {
    case 'finder_list_files': { const entries = await readdir(path, { withFileTypes: true }); return { path, entries: entries.slice(0, Number(args.limit || 200)).map(x => ({ name: x.name, directory: x.isDirectory(), symlink: x.isSymbolicLink() })), truncated: entries.length > Number(args.limit || 200) }; }
    case 'finder_search_files': { const matches: string[] = []; const queue = [path]; let visited = 0; const limit = Number(args.limit || 100); while (queue.length && visited < 10000 && matches.length < limit) { const dir = queue.pop()!; let entries; try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; } for (const entry of entries) { if (++visited > 10000 || matches.length >= limit) break; const item = join(dir, entry.name); if (entry.name.toLocaleLowerCase().includes(String(args.query).toLocaleLowerCase())) matches.push(item); if (entry.isDirectory() && !entry.isSymbolicLink()) queue.push(item); } } return { matches, visited, truncated: visited >= 10000 || matches.length >= limit }; }
    case 'finder_read_file': { const info = await lstat(path); if (!info.isFile() || info.size > 1048576) throw new BridgeError('FILE_LIMIT', 'Only regular text files of at most 1 MiB can be read.'); const contents = await readFile(path); if (contents.includes(0)) throw new BridgeError('BINARY_FILE', 'Binary files are not supported.'); return { path, content: new TextDecoder('utf-8', { fatal: true }).decode(contents), bytes: contents.length }; }
    case 'finder_write_file': await writeFile(path, String(args.content), { flag: 'wx', mode: 0o600 }); return { path, bytes: Buffer.byteLength(String(args.content)) };
    case 'finder_create_directory': await mkdir(path, { mode: 0o700 }); return { path };
    case 'finder_copy_file': case 'finder_move_file': case 'finder_rename_file': { const source = await scopedPath(args.source, roots); const destination = await scopedPath(args.destination, roots, true); await absent(destination); if (!(await lstat(source)).isFile()) throw new BridgeError('REGULAR_FILE_REQUIRED', 'Copy/move/rename currently supports regular files only.'); await copyFile(source, destination, constants.COPYFILE_EXCL); if (name !== 'finder_copy_file') { const { unlink } = await import('node:fs/promises'); await unlink(source); } return { source, destination }; }
    case 'finder_trash_file': { const actualRoots = await Promise.all(roots.map(r => realpath(r).catch(() => r))); if (actualRoots.includes(path)) throw new BridgeError('ROOT_PROTECTED', 'Cannot trash an authorized root.'); return nativeCall(name, { path }); }
    case 'finder_open_file': return nativeCall(name, { path });
    default: throw new BridgeError('UNKNOWN_TOOL', name);
  }
}
