import { z } from 'zod';

export type Money = bigint & { readonly __brand: 'MoneyInCents' };

const MONEY_PATTERN = /^\d+(?:\.\d{1,2})?$/;

export function parseMoney(value: string): Money {
  if (!MONEY_PATTERN.test(value)) throw new Error('Invalid monetary amount');
  const [whole, fraction = ''] = value.split('.');
  return (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))) as Money;
}

export function moneyToString(value: Money): string {
  if (value < 0n) throw new Error('Money cannot be negative');
  return `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
}

export function addMoney(left: Money, right: Money): Money {
  return (left + right) as Money;
}

export function subtractMoney(left: Money, right: Money): Money {
  const result = left - right;
  if (result < 0n) throw new Error('Money result cannot be negative');
  return result as Money;
}

export function compareMoney(left: Money, right: Money): -1 | 0 | 1 {
  return left < right ? -1 : left > right ? 1 : 0;
}

export const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
});

export type Environment = z.infer<typeof environmentSchema>;

export function parseEnvironment(values: NodeJS.ProcessEnv): Environment {
  return environmentSchema.parse(values);
}
