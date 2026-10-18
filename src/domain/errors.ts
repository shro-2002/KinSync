export const ERROR_CODES = [
    'UNAUTHENTICATED_SESSION', // no synthetic actor bound to the MCP session
    'UNKNOWN_ACTOR',
    'FORBIDDEN', // wrong household or role
    'NOT_FOUND', // also used for other households' records, so existence never leaks
    'INVALID_INPUT',
    'IDEMPOTENCY_CONFLICT', // same key reused with a different request
    'ALREADY_DECIDED',
    'NO_DUTY_CONTACT',
    'INVALID_TRANSITION' // state machine refused the move (wrong state, duplicate decision, concurrent update)
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export class DomainError extends Error {
    constructor(
        readonly code: ErrorCode,
        message: string,
        readonly details?: Record<string, unknown>
    ) {
        super(message);
        this.name = 'DomainError';
    }
}
