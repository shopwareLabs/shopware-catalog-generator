/**
 * Validation utilities
 */

/** Result of subdomain validation */
export interface SubdomainValidationResult {
    /** Whether the name is valid as-is or after sanitization */
    valid: boolean;
    /** Sanitized version of the name */
    sanitized: string;
    /** Error message if invalid */
    error?: string;
    /** Warning message if sanitization changed the name */
    warning?: string;
}

/**
 * Validate and sanitize a name for use as a subdomain.
 *
 * Rules for valid subdomains:
 * - 1-63 characters
 * - Only lowercase letters, digits, and hyphens
 * - Cannot start or end with a hyphen
 * - Cannot have consecutive hyphens
 *
 * @param name - The name to validate
 * @returns Validation result with sanitized name
 */
export function validateSubdomainName(name: string): SubdomainValidationResult {
    if (!name || name.trim().length === 0) {
        return {
            valid: false,
            sanitized: "",
            error: "Name cannot be empty",
        };
    }

    // Sanitize the name
    let sanitized = name
        .toLowerCase()
        .trim()
        // Replace spaces and underscores with hyphens
        .replace(/[\s_]+/g, "-")
        // Remove any character that's not alphanumeric or hyphen
        .replace(/[^a-z0-9-]/g, "")
        // Replace multiple consecutive hyphens with single hyphen
        .replace(/-+/g, "-")
        // Remove leading/trailing hyphens
        .replace(/^-+|-+$/g, "");

    // Check length
    if (sanitized.length === 0) {
        return {
            valid: false,
            sanitized: "",
            error: "Name contains no valid characters for a subdomain",
        };
    }

    if (sanitized.length > 63) {
        sanitized = sanitized.substring(0, 63).replace(/-+$/, "");
        return {
            valid: true,
            sanitized,
            warning: `Name was truncated to 63 characters: "${sanitized}"`,
        };
    }

    // Check if sanitization changed the name
    const originalLower = name.toLowerCase().trim();
    if (sanitized !== originalLower) {
        return {
            valid: true,
            sanitized,
            warning: `Name was sanitized from "${name}" to "${sanitized}"`,
        };
    }

    return {
        valid: true,
        sanitized,
    };
}

/**
 * Check if a name is a valid subdomain without any sanitization.
 *
 * @param name - The name to check
 * @returns true if the name is already a valid subdomain
 */
export function isValidSubdomain(name: string): boolean {
    if (!name || name.length === 0 || name.length > 63) {
        return false;
    }

    // Must be lowercase letters, digits, and hyphens only
    if (!/^[a-z0-9-]+$/.test(name)) {
        return false;
    }

    // Cannot start or end with hyphen
    if (name.startsWith("-") || name.endsWith("-")) {
        return false;
    }

    // Cannot have consecutive hyphens (except for punycode, but we'll skip that)
    if (/--/.test(name)) {
        return false;
    }

    return true;
}

/**
 * Generate a base URL for a SalesChannel subdomain.
 *
 * @param subdomain - The sanitized subdomain name
 * @param baseHost - The base host (default: "localhost:8000")
 * @param protocol - The protocol (default: "http")
 * @returns The full URL (e.g., "http://furniture.localhost:8000")
 */
export function generateSubdomainUrl(
    subdomain: string,
    baseHost: string = "localhost:8000",
    protocol: string = "http"
): string {
    return `${protocol}://${subdomain}.${baseHost}`;
}
