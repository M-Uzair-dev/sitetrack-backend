// Writes the OpenAPI document to docs/openapi.json without needing a database.
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { PrismaService } from './prisma/prisma.service';

PrismaService.prototype.onModuleInit = async () => undefined;
process.env.JWT_SECRET ??= 'openapi-export';

import('./main').then(async ({ createApp }) => {
  const { app, document } = await createApp();
  const out = join(process.cwd(), 'docs');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'openapi.json'), JSON.stringify(document, null, 2));
  await app.close();
  console.log('Wrote docs/openapi.json');
  process.exit(0);
});
