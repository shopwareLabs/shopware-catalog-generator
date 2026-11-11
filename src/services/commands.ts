/**
 * Command specs - one definition per command for the CLI and the MCP server.
 *
 * A spec holds the tool name, description, Zod parameters (with defaults) and the service
 * call. The MCP server registers its tools from the specs, the CLI maps its flags to the
 * same parameters and runs executeCommand(). Defaults, validation and env fallbacks
 * (TRANSLATION_LANGUAGES) therefore exist once. tests/unit/services/commands-parity.test.ts
 * runs every command through both surfaces.
 *
 * generate keeps its own request builder (generate-request.ts) because the HTTP server
 * body and the interactive language prompt are generate-only.
 */

import { z } from "zod";

import { registry } from "../post-processors/index.js";
import { validateSubdomainName } from "../utils/index.js";
import {
    createBlueprint,
    estimateBlueprintCost,
    fixBlueprint,
    HYDRATE_ONLY_MODES,
    hydrateBlueprint,
    inspireBlueprint,
} from "./blueprint-service.js";
import { clearCache, emptyTrash, listCache, listTrash, restoreFromTrash } from "./cache-service.js";
import { cleanupGlobal, cleanupSalesChannelData } from "./cleanup-service.js";
import { resolveLanguageSelection } from "./generate-request.js";
import { runProcessorsForSalesChannel } from "./generate-service.js";
import { fixImages, IMAGE_FIX_TYPES } from "./image-fix-service.js";
import { writeTemplateMetadata } from "./template-service.js";
import { estimateTranslation, translateBlueprint } from "./translation-service.js";
import { variantOverridesFromParams, variantSettingParams } from "./variant-params.js";

type Env = Record<string, string | undefined>;

/** Service functions the commands call (injectable for tests) */
export interface CommandServices {
    createBlueprint: typeof createBlueprint;
    estimateBlueprintCost: typeof estimateBlueprintCost;
    estimateTranslation: typeof estimateTranslation;
    translateBlueprint: typeof translateBlueprint;
    hydrateBlueprint: typeof hydrateBlueprint;
    inspireBlueprint: typeof inspireBlueprint;
    fixBlueprint: typeof fixBlueprint;
    fixImages: typeof fixImages;
    writeTemplateMetadata: typeof writeTemplateMetadata;
    runProcessors: typeof runProcessorsForSalesChannel;
    listCache: typeof listCache;
    clearCache: typeof clearCache;
    listTrash: typeof listTrash;
    restoreFromTrash: typeof restoreFromTrash;
    emptyTrash: typeof emptyTrash;
    cleanupSalesChannelData: typeof cleanupSalesChannelData;
    cleanupGlobal: typeof cleanupGlobal;
}

const DEFAULT_SERVICES: CommandServices = {
    createBlueprint,
    estimateBlueprintCost,
    estimateTranslation,
    translateBlueprint,
    hydrateBlueprint,
    inspireBlueprint,
    fixBlueprint,
    fixImages,
    writeTemplateMetadata,
    runProcessors: runProcessorsForSalesChannel,
    listCache,
    clearCache,
    listTrash,
    restoreFromTrash,
    emptyTrash,
    cleanupSalesChannelData,
    cleanupGlobal,
};

export interface CommandContext {
    services: CommandServices;
    env: Env;
}

export interface CommandSpec<Shape extends z.ZodRawShape> {
    /** MCP tool name */
    readonly tool: string;
    readonly description: string;
    /** Parameters in camelCase; the CLI flag is the kebab-case name (see cliFlagName) */
    readonly params: Shape;
    run(args: z.output<z.ZodObject<Shape>>, ctx: CommandContext): Promise<string[]>;
}

function defineCommand<Shape extends z.ZodRawShape>(spec: CommandSpec<Shape>): CommandSpec<Shape> {
    return spec;
}

export interface ExecuteCommandOptions {
    services?: Partial<CommandServices>;
    env?: Env;
    /** Name of a parameter in error messages (CLI: --flag-name) */
    formatParam?: (param: string) => string;
    /** Runs after the arguments are valid, before the service call (CLI: Shopware check) */
    beforeRun?: () => Promise<unknown>;
}

/** Zod object of the spec parameters (MCP tool schema) */
export function objectSchema<Shape extends z.ZodRawShape>(
    spec: CommandSpec<Shape>
): z.ZodObject<Shape> {
    return z.object(spec.params);
}

/** Validate the arguments with the spec parameters and run the command */
export async function executeCommand<Shape extends z.ZodRawShape>(
    spec: CommandSpec<Shape>,
    rawArgs: unknown,
    options: ExecuteCommandOptions = {}
): Promise<string[]> {
    const parsed = objectSchema(spec).safeParse(rawArgs);
    if (!parsed.success) {
        return [`Error: ${formatIssues(parsed.error.issues, options.formatParam)}`];
    }
    await options.beforeRun?.();
    return spec.run(parsed.data, {
        services: { ...DEFAULT_SERVICES, ...options.services },
        env: options.env ?? process.env,
    });
}

function formatIssues(
    issues: z.core.$ZodIssue[],
    formatParam: (param: string) => string = (p) => p
): string {
    return issues
        .map((issue) => {
            const param = formatParam(String(issue.path[0] ?? "arguments"));
            const missing =
                issue.code === "invalid_type" && issue.message.endsWith("received undefined");
            return missing ? `${param} is required` : `${param}: ${issue.message}`;
        })
        .join("; ");
}

/** Validate the SalesChannel name, then run with the sanitized name */
async function withValidName(
    name: string,
    run: (salesChannelName: string) => Promise<string[]> | string[]
): Promise<string[]> {
    const validation = validateSubdomainName(name);
    if (!validation.valid) return [`Error: Invalid name - ${validation.error}`];
    return run(validation.sanitized);
}

const hasError = (lines: string[]): boolean => lines.some((l) => l.startsWith("Error:"));

const LANGUAGES_DESCRIPTION =
    `"all" (SalesChannel languages, de-DE for a new SalesChannel), "none", ` +
    `or comma-separated locale codes like "de-DE,fr-FR"`;

const nameParam = z.string().describe("SalesChannel name (becomes subdomain, e.g., 'furniture')");

// =============================================================================
// Blueprint
// =============================================================================

export const BLUEPRINT_CREATE = defineCommand({
    tool: "blueprint_create",
    description:
        "Generate blueprint.json structure without AI calls. Creates the category tree and product placeholders.",
    params: {
        name: nameParam,
        description: z
            .string()
            .optional()
            .describe("Store description for AI context (default: '{name} webshop')"),
        products: z
            .number()
            .int()
            .positive()
            .default(90)
            .describe("Number of products to generate (default: 90)"),
        ...variantSettingParams,
    },
    run: (args, { services }) =>
        withValidName(args.name, (name) =>
            services.createBlueprint(
                name,
                args.description || `${name} webshop`,
                args.products,
                variantOverridesFromParams(args)
            )
        ),
});

export const BLUEPRINT_ESTIMATE = defineCommand({
    tool: "blueprint_estimate",
    description:
        "Forecast AI calls, tokens, images and USD cost of blueprint_hydrate without calling any AI. " +
        "Uses the configured providers/models (AI_PROVIDER, AI_MODEL, IMAGE_MODEL, IMAGE_QUALITY).",
    params: {
        name: nameParam,
        only: z
            .enum(HYDRATE_ONLY_MODES)
            .optional()
            .describe(
                "Estimate a selective hydration (categories, properties, cms, variants, variant-images, prices, or names)"
            ),
        languages: z
            .string()
            .optional()
            .describe(
                `Also forecast translation: ${LANGUAGES_DESCRIPTION}. Default: TRANSLATION_LANGUAGES, else none`
            ),
        ...variantSettingParams,
    },
    run: (args, { services, env }) =>
        withValidName(args.name, async (name) => {
            const languages = resolveLanguageSelection(args.languages, env);
            if ("error" in languages) return [languages.error];

            const lines = services.estimateBlueprintCost(name, {
                only: args.only,
                variants: variantOverridesFromParams(args),
            });
            if (hasError(lines) || !languages.selection) return lines;
            return [
                ...lines,
                "",
                ...(await services.estimateTranslation(name, languages.selection)),
            ];
        }),
});

export const BLUEPRINT_TRANSLATE = defineCommand({
    tool: "blueprint_translate",
    description:
        "Translate the hydrated catalog (products, categories, properties, reviews, CMS texts) into " +
        "other languages with AI, written like a native shop instead of a 1:1 translation. " +
        "Saves translations/{locale}.json, uploaded by generate/process (translations, reviews). " +
        "Unchanged texts from earlier runs are reused. Use blueprint_estimate with languages for the cost.",
    params: {
        name: nameParam,
        languages: z
            .string()
            .optional()
            .describe(`${LANGUAGES_DESCRIPTION}. Default: TRANSLATION_LANGUAGES, else "all"`),
        formality: z
            .enum(["formal", "informal"])
            .optional()
            .describe("Form of address (default: the AI decides per language and store)"),
        force: z
            .boolean()
            .default(false)
            .describe("Translate everything again instead of reusing unchanged entries"),
    },
    run: (args, { services, env }) =>
        withValidName(args.name, (name) => {
            const languages = resolveLanguageSelection(args.languages, env);
            if ("error" in languages) return [languages.error];
            return services.translateBlueprint(name, {
                languages: languages.selection ?? { mode: "all" },
                formality: args.formality,
                force: args.force,
            });
        }),
});

export const BLUEPRINT_HYDRATE = defineCommand({
    tool: "blueprint_hydrate",
    description:
        "Fill blueprint with AI-generated content (product/category names, descriptions, properties). " +
        "Supports selective hydration with only and full re-hydration with rehydrate.",
    params: {
        name: nameParam,
        only: z
            .enum(HYDRATE_ONLY_MODES)
            .optional()
            .describe(
                "Selectively hydrate only this part (categories, properties, cms, variants, variant-images, prices, or names). " +
                    "Preserves existing product names (important for image stability). " +
                    "'variants' re-picks the variant options for new variant settings. " +
                    "'variant-images' recolours the product images per colour variant (OpenAI image editing). " +
                    "'prices' re-prices the products with realistic prices (one AI call per 100 products). " +
                    "'names' removes variant values from variant parent names and renames products with a duplicate name."
            ),
        rehydrate: z
            .boolean()
            .default(false)
            .describe(
                "Force full re-hydration even if hydrated blueprint exists. " +
                    "WARNING: changes product names and triggers image regeneration."
            ),
        ...variantSettingParams,
    },
    run: (args, { services }) =>
        withValidName(args.name, (name) =>
            services.hydrateBlueprint(name, {
                only: args.only,
                force: args.rehydrate,
                variants: variantOverridesFromParams(args),
            })
        ),
});

export const BLUEPRINT_INSPIRE = defineCommand({
    tool: "blueprint_inspire",
    description:
        "Crawl an existing website to extract category names, example products, and brand colors. " +
        "Saves inspiration.json which is automatically used by blueprint_hydrate to guide AI generation " +
        "so the result feels like it could be the customer's actual store.",
    params: {
        name: nameParam,
        url: z.string().url().describe("URL of the website to crawl for inspiration"),
    },
    run: (args, { services }) =>
        withValidName(args.name, (name) => services.inspireBlueprint(args.url, name)),
});

export const BLUEPRINT_FIX = defineCommand({
    tool: "blueprint_fix",
    description:
        "Fix placeholder names in hydrated blueprint. " +
        "Regenerates AI content for products/categories that still have placeholder names " +
        "(e.g., 'Product 1', 'Top Category 1').",
    params: { name: nameParam },
    run: (args, { services }) => withValidName(args.name, (name) => services.fixBlueprint(name)),
});

// =============================================================================
// Images, templates, post-processors
// =============================================================================

export const IMAGE_FIX = defineCommand({
    tool: "image_fix",
    description:
        "Regenerate images for a product, category, CMS page, or theme media. " +
        "Deletes cached images, regenerates via AI, and uploads to Shopware.",
    params: {
        name: z.string().describe("SalesChannel name (must have existing hydrated blueprint)"),
        target: z
            .string()
            .optional()
            .describe(
                "Target to regenerate: product name/ID, category name/ID, CMS page name, " +
                    'or theme media key (logo, favicon, share, all). Required for all types except theme (defaults to "all")'
            ),
        type: z.enum(IMAGE_FIX_TYPES).default("product").describe("Type of image to regenerate"),
        dryRun: z
            .boolean()
            .default(false)
            .describe("If true, only show what would be done without generating or uploading"),
    },
    run: (args, { services }) =>
        withValidName(args.name, (name) =>
            services.fixImages(name, { type: args.type, target: args.target, dryRun: args.dryRun })
        ),
});

export const TEMPLATE_METADATA = defineCommand({
    tool: "template_metadata",
    description:
        "Write template.json for a cached SalesChannel: generator version, date, text/image models, " +
        "languages and the Shopware versions it was imported into. Pass the e2e-results/<timestamp> " +
        "directory of a test-e2e-lanes.sh run to record lane results (older results of the same lane are replaced).",
    params: {
        name: z.string().describe("SalesChannel name"),
        e2e: z
            .string()
            .optional()
            .describe("e2e-results/<timestamp> directory of a test-e2e-lanes.sh run"),
    },
    run: (args, { services }) =>
        withValidName(args.name, (name) =>
            services.writeTemplateMetadata(name, { e2eDir: args.e2e })
        ),
});

const processorNames = registry.getNames();

export const PROCESS = defineCommand({
    tool: "process",
    description: `Run post-processors on an existing SalesChannel. Available processors: ${processorNames.join(", ")}. Use to add images, manufacturers, reviews, or variants after initial generation.`,
    params: {
        name: z.string().describe("SalesChannel name (must exist in Shopware)"),
        processors: z
            .array(z.enum(processorNames as [string, ...string[]]))
            .optional()
            .describe("List of processors to run. If omitted, runs all processors."),
        dryRun: z.boolean().default(false).describe("Preview actions without making changes"),
    },
    run: (args, { services }) =>
        withValidName(args.name, (name) =>
            services.runProcessors(name, args.processors ?? [], args.dryRun)
        ),
});

// =============================================================================
// Cache (local files only)
// =============================================================================

export const CACHE_LIST = defineCommand({
    tool: "cache_list",
    description:
        "List all cached SalesChannels with their data (categories, products, images). " +
        "Cache contains AI-generated content that can be reused.",
    params: {},
    run: async (_args, { services }) => services.listCache(),
});

export const CACHE_CLEAR = defineCommand({
    tool: "cache_clear",
    description:
        "Move cached data to trash (recoverable with cache_restore). " +
        "Clears one SalesChannel, or everything when salesChannel is omitted.",
    params: {
        salesChannel: z
            .string()
            .optional()
            .describe("SalesChannel to clear. If omitted, clears ALL cached data."),
    },
    run: async (args, { services }) => services.clearCache({ salesChannel: args.salesChannel }),
});

export const CACHE_TRASH = defineCommand({
    tool: "cache_trash",
    description: "List items in the trash that can be restored with cache_restore.",
    params: {},
    run: async (_args, { services }) => services.listTrash(),
});

export const CACHE_RESTORE = defineCommand({
    tool: "cache_restore",
    description:
        "Restore an item (or all items) from trash back to the cache. " +
        "Targets that already exist and are not empty are never overwritten.",
    params: {
        item: z.string().optional().describe("Item name to restore (from cache_trash output)"),
        all: z.boolean().default(false).describe("Restore every item in the trash"),
    },
    run: async (args, { services }) =>
        services.restoreFromTrash({ item: args.item, all: args.all }),
});

export const CACHE_EMPTY_TRASH = defineCommand({
    tool: "cache_empty_trash",
    description: "Permanently delete all items in trash. This cannot be undone!",
    params: {
        confirm: z.boolean().default(false).describe("Must be true to confirm permanent deletion"),
    },
    run: async (args, { services }) => services.emptyTrash({ confirm: args.confirm }),
});

// =============================================================================
// Cleanup (Shopware)
// =============================================================================

const dryRunParam = z
    .boolean()
    .default(false)
    .describe("Preview what would be deleted without making changes");

export const CLEANUP = defineCommand({
    tool: "cleanup",
    description:
        "Delete products, categories, and optionally the SalesChannel from Shopware. " +
        "With processors, only the entities of those post-processors are deleted " +
        `("all" or full=true for every processor). Available processors: ${processorNames.join(", ")}. ` +
        "Does NOT delete local cache.",
    params: {
        salesChannel: z.string().describe("SalesChannel name to clean up"),
        deleteSalesChannel: z
            .boolean()
            .default(false)
            .describe("Also delete the SalesChannel itself and its root category"),
        deleteProps: z
            .boolean()
            .default(false)
            .describe("Also delete all property groups (use with caution)"),
        processors: z
            .array(z.enum(["all", ...processorNames] as [string, ...string[]]))
            .default([])
            .describe(
                'Only clean up the entities of these processors ("all" for every processor). ' +
                    "If omitted, products and categories are deleted."
            ),
        full: z
            .boolean()
            .default(false)
            .describe(
                "Clean up every processor, then products and categories. " +
                    "The SalesChannel is only deleted with deleteSalesChannel=true."
            ),
        dryRun: dryRunParam,
    },
    run: (args, { services }) => services.cleanupSalesChannelData(args),
});

export const CLEANUP_MEDIA = defineCommand({
    tool: "cleanup_media",
    description: "Delete orphaned product media (media whose product no longer exists). Shop-wide.",
    params: { dryRun: dryRunParam },
    run: (args, { services }) =>
        services.cleanupGlobal({ targets: ["orphaned-media"], dryRun: args.dryRun }),
});

export const CLEANUP_UNUSED_PROPS = defineCommand({
    tool: "cleanup_unused_props",
    description: "Delete property groups where no option is used by any product. Shop-wide.",
    params: { dryRun: dryRunParam },
    run: (args, { services }) =>
        services.cleanupGlobal({ targets: ["unused-props"], dryRun: args.dryRun }),
});

export const CLEANUP_UNUSED_OPTIONS = defineCommand({
    tool: "cleanup_unused_options",
    description: "Delete single property options that no product uses. Shop-wide.",
    params: { dryRun: dryRunParam },
    run: (args, { services }) =>
        services.cleanupGlobal({ targets: ["unused-options"], dryRun: args.dryRun }),
});
