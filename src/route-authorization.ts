import { resolve } from 'node:path';
import type { Task } from './types.js';

/** Conservative read/access scope projection, never a general prose-policy
 * interpreter. Explicit exclusions forbid; ambiguous restrictions stay unknown. */
export function routeReadAuthorization(task: Task, path: string): 'authorized' | 'forbidden' | 'unknown' {
  const clauses = [task.authorization, task.goal, ...task.acceptance.map((item) => item.text)].join('\n').split(/[。；;\n]|(?<=[.!?])\s+/);
  const forbiddenAccess = /(?:do\s+not|must\s+not|never|forbid(?:den)?|prohibit(?:ed)?)\s+(?:\w+\s+){0,2}(?:read|access|open|inspect|run|execute|use)|\bno\s+access\b|(?:不|禁止|不得|不可|不能)(?:提前)?(?:读取|访问|打开|查看|使用|执行|运行)/i;
  const normalized = path.toLowerCase().replaceAll('\\', '/');
  let unknown = false;
  for (const clause of clauses.filter((item) => forbiddenAccess.test(item))) {
    const normalizedClause = clause.toLowerCase().replaceAll('\\', '/');
    // Preserve complete literal paths, including leading dots and spaces.
    if (normalizedClause.includes(normalized)) return 'forbidden';
    const holdout = /holdout|留出/i.test(clause);
    if (holdout && /holdout|留出/i.test(normalized)) return 'forbidden';
    const paths = clause.match(/(?:[A-Za-z]:[\\/])?[\p{L}\p{N}_.-]+(?:[\\/][\p{L}\p{N}_.-]+)+|[\p{L}\p{N}_.-]+\.(?:csv|json|parquet|jsonl|txt|db|sqlite|bin|md)\b/gu) ?? [];
    for (const excluded of paths) {
      const target = excluded.toLowerCase().replaceAll('\\', '/').replace(/[.,]+$/, '');
      if (normalized === target || normalized.startsWith(`${target}/`) || normalized.endsWith(`/${target}`) || resolve(task.workspace, path).toLowerCase().replaceAll('\\', '/') === target) return 'forbidden';
    }
    if (!holdout && !paths.length) unknown = true;
  }
  return unknown ? 'unknown' : 'authorized';
}
