import { eq } from 'drizzle-orm';
import { tournamentEntries, type Database } from '@trade-the-pool/database';
import { ApiError } from './errors.js';

export type AuthorizedEntry = typeof tournamentEntries.$inferSelect;

export class AuthorizationService {
  constructor(private readonly db: Database) {}

  async ownedEntry(userId: string, entryId: string): Promise<AuthorizedEntry> {
    const [entry] = await this.db
      .select()
      .from(tournamentEntries)
      .where(eq(tournamentEntries.id, entryId));
    if (!entry) throw new ApiError(404, 'NOT_FOUND', 'Tournament entry does not exist.');
    if (entry.userId !== userId)
      throw new ApiError(403, 'AUTHORIZATION_DENIED', 'You cannot access this tournament entry.');
    return entry;
  }

  async canReadEntry(userId: string, entryId: string): Promise<AuthorizedEntry> {
    return this.ownedEntry(userId, entryId);
  }

  async canTradeEntry(userId: string, entryId: string): Promise<AuthorizedEntry> {
    return this.ownedEntry(userId, entryId);
  }

  async canReadPrivateHistory(userId: string, entryId: string): Promise<AuthorizedEntry> {
    return this.ownedEntry(userId, entryId);
  }

  async canCreateEntry(userId: string): Promise<string> {
    return userId;
  }
}
