/**
 * Error Classifier — pure functions, no state.
 *
 * Classifies Anthropic API errors into categories and strategies
 * for the token health manager to act on.
 */

/**
 * Classify an Anthropic API error by HTTP status code.
 * @param {number} statusCode - HTTP status (e.g. 401, 429, 500)
 * @param {string} [errorType] - Anthropic error type string (optional)
 * @returns {Readonly<{ category: string, strategy: string, healable: boolean, retryable: boolean }>}
 */
export function classifyApiError(statusCode, errorType) {
  switch (statusCode) {
    case 401:
    case 403:
      return Object.freeze({
        category: "auth_error",
        strategy: "refresh_retry",
        healable: true,
        retryable: true,
      });
    case 429:
      return Object.freeze({
        category: "rate_limited",
        strategy: "cooldown_reroute",
        healable: false,
        retryable: false,
      });
    case 500:
    case 529:
      return Object.freeze({
        category: "server_error",
        strategy: "backoff_retry",
        healable: true,
        retryable: true,
      });
    default:
      return Object.freeze({
        category: "pass_through",
        strategy: "pass_through",
        healable: false,
        retryable: false,
      });
  }
}
