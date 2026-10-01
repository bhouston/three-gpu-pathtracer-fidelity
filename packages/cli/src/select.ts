import path from 'node:path';

/** Names matching any of the comma-separated glob patterns, in `names` order. Throws when a pattern matches nothing. */
export function selectNames(names: readonly string[], patterns: string, kind: string): string[] {
  const globs = patterns
    .split(',')
    .map((glob) => glob.trim())
    .filter(Boolean);
  for (const glob of globs) {
    if (!names.some((name) => path.matchesGlob(name, glob))) {
      throw new Error(`No ${kind} matches "${glob}". Available: ${names.join(', ')}`);
    }
  }
  return names.filter((name) => globs.some((glob) => path.matchesGlob(name, glob)));
}
