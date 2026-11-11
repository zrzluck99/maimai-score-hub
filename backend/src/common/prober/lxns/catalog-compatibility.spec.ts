import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseLxnsCatalog } from './catalog';

describe('Python/TypeScript catalog contract', () => {
  it.each(['catalog.json', 'asdfbot-catalog.json'])(
    'hashes %s identically',
    (name) => {
      const root = join(__dirname, '../../../..');
      const file = join(root, 'test/fixtures/lxns', name);
      const payload: unknown = JSON.parse(readFileSync(file, 'utf8'));
      const rootPayload = payload as { data?: unknown };
      const parsed = parseLxnsCatalog(rootPayload.data ?? payload);
      const python = execFileSync(
        'python',
        [join(root, 'test/catalog-compatibility.py'), file],
        { encoding: 'utf8' },
      ).trim();
      expect(python).toBe(parsed.catalogVersion);
    },
  );
});
