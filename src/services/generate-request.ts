/**
 * Generate request - the one mapping from user input to generate() options.
 *
 * CLI flags, MCP tool arguments and the HTTP server body are first translated into a
 * GenerateInput (field names only), then buildGenerateRequest() validates and resolves it
 * the same way for every surface. Defaults (TRANSLATION_LANGUAGES, products) live here,
 * so a new option is added once and every consumer gets the same behaviour.
 * tests/unit/services/generate-request-parity.test.ts checks that the three agree.
 */

import { z } from "zod";

import type { VariantSettingOverrides } from "../blueprint/index.js";
import type { GenerateOptions } from "./generate-service.js";
import type { VariantSettingArgs } from "./variant-params.js";

import { validateSubdomainName } from "../utils/index.js";
import { tryParseLanguageSelection } from "./translation-service.js";
import { variantOverridesFromParams, variantSettingParams } from "./variant-params.js";

/** Surface-neutral generate input (raw values, validated by buildGenerateRequest) */
export interface GenerateInput {
    name?: string;
    description?: string;
    products?: number;
    dryRun?: boolean;
    noTemplate?: boolean;
    /** "all", "none" or comma-separated locales */
    languages?: string;
    variants?: VariantSettingOverrides;
}

/** Validated input, ready for generate() / runGenerate() */
export interface GenerateRequest {
    salesChannelName: string;
    /** Undefined: crawled brand description or "{name} webshop" (resolved by the service) */
    description?: string;
    options: GenerateOptions;
}

export type GenerateRequestResult = { request: GenerateRequest } | { error: string };

/** Zod shape for the generate parameters of the MCP tool and the HTTP server body */
export const generateRequestParams = {
    name: z.string().describe("SalesChannel name (becomes subdomain, e.g., 'furniture')"),
    description: z
        .string()
        .optional()
        .describe("Store description for AI context (default: '{name} webshop')"),
    products: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Number of products to generate (default: 90)"),
    dryRun: z.boolean().optional().describe("Preview actions without making changes"),
    noTemplate: z.boolean().optional().describe("Skip checking for pre-generated templates"),
    languages: z
        .string()
        .optional()
        .describe(
            `Translate the catalog before upload: "all" (SalesChannel languages, de-DE for a new one), ` +
                `"none", or locale codes like "de-DE,fr-FR". Default: TRANSLATION_LANGUAGES, else ` +
                `English only (cached translations are still uploaded). Forecast the cost first with blueprint_estimate.`
        ),
    ...variantSettingParams,
};

/** Values of generateRequestParams after parsing */
export interface GenerateParams extends VariantSettingArgs {
    name: string;
    description?: string;
    products?: number;
    dryRun?: boolean;
    noTemplate?: boolean;
    languages?: string;
}

/** MCP tool arguments / server body (camelCase variant params) to GenerateInput */
export function generateInputFromParams(params: GenerateParams): GenerateInput {
    return {
        name: params.name,
        description: params.description,
        products: params.products,
        dryRun: params.dryRun,
        noTemplate: params.noTemplate,
        languages: params.languages,
        variants: variantOverridesFromParams(params),
    };
}

/**
 * Validate the input and resolve the defaults. Returns an "Error: ..." line for invalid
 * input, so every surface reports the same message.
 */
export function buildGenerateRequest(
    input: GenerateInput,
    env: Record<string, string | undefined> = process.env
): GenerateRequestResult {
    if (!input.name) return { error: `Error: name is required` };
    const validation = validateSubdomainName(input.name);
    if (!validation.valid) return { error: `Error: Invalid name - ${validation.error}` };

    if (input.products !== undefined && !(Number.isInteger(input.products) && input.products > 0)) {
        return {
            error: `Error: products must be a positive whole number (got: ${input.products})`,
        };
    }

    const languages = resolveLanguageSelection(input.languages, env);
    if ("error" in languages) return { error: languages.error };

    const variants = Object.fromEntries(
        Object.entries(input.variants ?? {}).filter(([, v]) => v !== undefined)
    );

    return {
        request: {
            salesChannelName: validation.sanitized,
            description: input.description || undefined,
            options: {
                products: input.products ?? 90,
                dryRun: input.dryRun ?? false,
                noTemplate: input.noTemplate ?? false,
                languages: languages.selection,
                variants,
            },
        },
    };
}

/** Explicit value first, then TRANSLATION_LANGUAGES (same rule for every command) */
export function resolveLanguageSelection(
    value: string | undefined,
    env: Record<string, string | undefined>
): { selection: GenerateOptions["languages"] } | { error: string } {
    const explicit = tryParseLanguageSelection(value);
    if (explicit.error) return { error: explicit.error };
    if (explicit.selection) return { selection: explicit.selection };

    const fromEnv = tryParseLanguageSelection(env.TRANSLATION_LANGUAGES);
    if (fromEnv.error)
        return { error: fromEnv.error.replace("Error: ", "Error: TRANSLATION_LANGUAGES: ") };
    return { selection: fromEnv.selection };
}
