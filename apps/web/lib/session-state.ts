import type { UserDto } from '@trade-the-pool/shared';

export function shouldRedirectToLogin(success: boolean, user: UserDto | null | undefined): boolean {
  return success && user === null;
}

export function isSessionCheckUnavailable(
  failed: boolean,
  user: UserDto | null | undefined,
): boolean {
  return failed && !user;
}
