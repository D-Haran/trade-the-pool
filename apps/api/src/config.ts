import { parseEnvironment } from '@trade-the-pool/shared';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryEnvironment = resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env');
if (existsSync(repositoryEnvironment)) loadEnvFile(repositoryEnvironment);

export const config = parseEnvironment(process.env);
