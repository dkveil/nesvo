import { errorDetail } from '@/entities/session';

const UNKNOWN_OUTCOME_PATTERNS = [
  /^Host (stopped|timed out|unavailable)/,
  /^Unexpected host response/,
  /^Unknown error/,
  /^Nesvo is closing/,
  /^Disconnected from this computer/,
  /^Connection lost/,
  /^SSH (disconnected|connection timed out)/,
  /^The SSH connection closed/,
  /^The host (returned an invalid response|sent a malformed frame|response exceeded)/,
  /^The GitHub CLI (request timed out|process did not finish cleanly|returned invalid JSON|returned an unexpected response|response exceeded)/,
];

export const OUTCOME_UNKNOWN_MESSAGE =
  'Outcome unknown. Check the pull request before trying again.';

export function isOutcomeUnknown(failure: unknown) {
  const detail = errorDetail(failure);
  return UNKNOWN_OUTCOME_PATTERNS.some(pattern => pattern.test(detail));
}
