import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Tiny per-plugin JSON storage under <config>/plugins/<id>.json.
 * A plugin's data survives unload/reload and is removed only by the user.
 */
export class PluginStorage {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  for(id: string): { get<T>(key: string): T | undefined; set(key: string, value: unknown): void } {
    const file = join(this.dir, `${id}.json`);
    return {
      get: <T,>(key: string): T | undefined => {
        try {
          const data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
          return data[key] as T | undefined;
        } catch {
          return undefined;
        }
      },
      set: (key: string, value: unknown): void => {
        let data: Record<string, unknown> = {};
        try {
          data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
        } catch {
          /* first write */
        }
        data[key] = value;
        writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
      },
    };
  }
}
