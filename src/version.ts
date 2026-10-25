/** Version of this CLI. A test keeps it equal to package.json. */
export const CLI_VERSION = '0.0.0';

/** The dated /v1 API version this release pins, sent as `Ivora-Version`. */
export const DEFAULT_API_VERSION = '2026-10-15';

/** Dated /v1 API versions this release supports, oldest first (`--api-version`). */
export const SUPPORTED_API_VERSIONS: readonly string[] = [DEFAULT_API_VERSION];

export function isSupportedApiVersion(value: string): boolean {
  return SUPPORTED_API_VERSIONS.includes(value);
}
