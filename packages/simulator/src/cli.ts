import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { parseMoney } from '@trade-the-pool/shared';
import { simulationConfig } from './config.js';
import { jsonReport, markdownReport, tournamentCsv } from './report.js';
import { runSimulationBatch } from './simulation.js';
import type { SimulationConfig } from './types.js';

function argumentsMap(values: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (argument === '--') continue;
    if (!argument.startsWith('--')) continue;
    const [key, inline] = argument.slice(2).split('=', 2);
    const value = inline ?? values[index + 1];
    if (inline === undefined) index += 1;
    if (value === undefined || value.startsWith('--'))
      throw new Error(`Missing value for --${key}`);
    result.set(key, value);
  }
  return result;
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`${label} must be a positive integer`);
  return parsed;
}

async function loadOverrides(path: string): Promise<Partial<SimulationConfig>> {
  const raw = JSON.parse(await readFile(resolve(path), 'utf8')) as Record<string, unknown>;
  const overrides = { ...raw } as Partial<SimulationConfig> & {
    baseBankroll?: SimulationConfig['baseBankroll'] | string;
    initialPrizePool?: SimulationConfig['initialPrizePool'] | string;
  };
  if (typeof overrides.baseBankroll === 'string')
    overrides.baseBankroll = parseMoney(overrides.baseBankroll);
  if (typeof overrides.initialPrizePool === 'string')
    overrides.initialPrizePool = parseMoney(overrides.initialPrizePool);
  if (Array.isArray(raw.feeTiers))
    overrides.feeTiers = raw.feeTiers.map((value, ordinal) => {
      if (!value || typeof value !== 'object') throw new Error('Config fee tiers are invalid');
      const tier = value as Record<string, unknown>;
      const money = (key: string) => {
        if (typeof tier[key] !== 'string')
          throw new Error(`Fee tier ${key} must be a money string`);
        return parseMoney(tier[key]);
      };
      return {
        ordinal: typeof tier.ordinal === 'number' ? tier.ordinal : ordinal,
        minPrizePool: money('minPrizePool'),
        maxPrizePool: tier.maxPrizePool === null ? null : money('maxPrizePool'),
        entryFee: money('entryFee'),
        prizePoolContribution: money('prizePoolContribution'),
        platformFee: money('platformFee'),
        futureRewardAllocation:
          tier.futureRewardAllocation === undefined
            ? parseMoney('0.00')
            : money('futureRewardAllocation'),
      };
    });
  return overrides;
}

const args = argumentsMap(process.argv.slice(2));
const template = (args.get('template') ?? 'daily') as 'daily' | 'weekend';
if (template !== 'daily' && template !== 'weekend')
  throw new Error('Template must be daily or weekend');
const overrides = args.has('config') ? await loadOverrides(args.get('config')!) : {};
if (args.has('players')) overrides.players = positiveInteger(args.get('players')!, 'Players');
const config = simulationConfig(template, overrides);
const runs = positiveInteger(args.get('runs') ?? '1000', 'Runs');
const seed = Number(args.get('seed') ?? '42');
if (!Number.isInteger(seed)) throw new Error('Seed must be an integer');
const report = runSimulationBatch(config, runs, seed);

const requestedOutput = resolve(args.get('output') ?? 'simulation-results');
const outputExtension = extname(requestedOutput);
const outputDirectory = outputExtension ? dirname(requestedOutput) : requestedOutput;
const stem = outputExtension
  ? basename(requestedOutput, outputExtension)
  : `${template}-${runs}-${seed}`;
await mkdir(outputDirectory, { recursive: true });
const jsonPath =
  outputExtension === '.json' ? requestedOutput : join(outputDirectory, `${stem}.json`);
const csvPath = join(outputDirectory, `${stem}.csv`);
const markdownPath = join(outputDirectory, `${stem}.md`);
await Promise.all([
  writeFile(jsonPath, jsonReport(report), 'utf8'),
  writeFile(csvPath, tournamentCsv(report), 'utf8'),
  writeFile(markdownPath, markdownReport(report), 'utf8'),
]);
console.log(markdownReport(report));
console.log(`JSON: ${jsonPath}`);
console.log(`CSV: ${csvPath}`);
console.log(`Markdown: ${markdownPath}`);
