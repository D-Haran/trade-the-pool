-- PostgreSQL requires newly added enum values to commit before another statement can use them.
ALTER TYPE "tournament_status" ADD VALUE IF NOT EXISTS 'REGISTRATION_OPEN';
ALTER TYPE "tournament_status" ADD VALUE IF NOT EXISTS 'TRADING_ACTIVE';
