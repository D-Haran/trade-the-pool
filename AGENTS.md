# Trade the Pool Engineering Instructions

This repository is a production-oriented competitive paper-trading platform.

## Core principles

- Correctness and financial integrity take priority over speed.
- Never trust client-provided prices, timestamps, balances, P&L, ranks, or tournament state.
- All trading decisions are server-authoritative.
- PostgreSQL is the durable source of truth.
- Redis is never the source of truth for financial/accounting state.
- All money and asset quantities use fixed-precision decimal or integer arithmetic. Never use binary floating-point for financial accounting.
- Every state-changing trading operation must be atomic and idempotent.
- Do not introduce blockchain or real-money functionality until explicitly requested.
- Do not introduce leverage, derivatives, shorting, or memecoin support unless explicitly requested.
- Avoid unnecessary dependencies and premature microservices.
- Keep domain logic independent from transport/UI layers.

## Architecture

Monorepo:

- apps/web
- apps/api
- packages/database
- packages/trading-engine
- packages/market-data
- packages/shared
- packages/ui

## Frontend

Use:

- Next.js
- React
- TypeScript
- Tailwind
- shadcn/ui
- TanStack Query
- Zustand
- TradingView Lightweight Charts

Design language:

- dark
- restrained
- premium
- professional financial terminal
- high information density where appropriate
- generous spacing elsewhere
- no casino aesthetics
- no excessive gradients
- no childish gamification
- no fake 3D effects
- typography and numbers should be exceptional
- responsive desktop-first design

## Backend

Use:

- Node.js
- TypeScript
- Fastify
- Zod
- PostgreSQL
- Drizzle
- Redis

Keep trading-engine domain logic in a dedicated package independent from HTTP.

## Security

- Validate every external input.
- Authentication and authorization must be explicit.
- Never expose secrets client-side.
- Rate-limit sensitive endpoints.
- Prevent replay and duplicate order execution.
- Use idempotency keys for relevant write operations.
- Use secure cookies where browser sessions are used.
- Follow least privilege.
- Avoid logging secrets/tokens.
- Use structured audit logging for sensitive actions.
- Never silently weaken security to make tests pass.

## Testing

Every meaningful domain rule requires tests.

At minimum:

- unit tests
- integration tests
- edge-case tests

Trading/accounting changes require invariant tests.

Never declare work complete with failing tests, type errors, or lint errors.

## Workflow

Before making a major architectural change:

1. inspect the existing repository;
2. explain the relevant architecture internally;
3. preserve established patterns;
4. implement the smallest coherent change;
5. run relevant tests;
6. fix regressions;
7. summarize changes.

Do not redesign unrelated functionality.
