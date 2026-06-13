import { existsSync } from 'fs'
import { join } from 'path'

/** Preload bundle is index.cjs (CJS) — also accept legacy index.js / index.mjs. */
export function resolvePreloadPath(mainDirname: string): string {
  const dir = join(mainDirname, '../preload')
  for (const name of ['index.cjs', 'index.js', 'index.mjs']) {
    const path = join(dir, name)
    if (existsSync(path)) return path
  }
  return join(dir, 'index.cjs')
}
