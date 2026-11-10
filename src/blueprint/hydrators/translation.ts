/**
 * Translation Hydrator - rewrites the English catalog for another locale.
 *
 * English (hydrated blueprint, CMS blueprint, fixture texts) is the source. The output is
 * one `TranslationFile` per locale. The prompts ask for native copy instead of a literal
 * translation. Steps:
 *
 * 1. Formality (formal/informal address), decided once per locale unless given
 * 2. Glossary: category, property group and option names, shared by every later call
 * 3. Category descriptions, product texts, reviews, CMS pages and fixture texts in batches
 *
 * Entries carry a hash of their English source. Unchanged entries are reused from the
 * previous file, so re-running after a partial re-hydration only translates what changed.
 */

import { z } from "zod";

import type {
    BlueprintCategory,
    CmsBlueprint,
    Formality,
    HydratedBlueprint,
    TextProvider,
    TranslationFile,
    TranslationSource,
} from "../../types/index.js";

import { buildProductReviews, TRANSLATABLE_FIXTURE_TEXTS } from "../../fixtures/index.js";
import { SOURCE_LOCALE } from "../../types/index.js";
import {
    buildCategoryPath,
    chunkArray,
    ConcurrencyLimiter,
    createShortHash,
    executeWithRetry,
    logger,
} from "../../utils/index.js";

// =============================================================================
// Source
// =============================================================================

/**
 * Product fields sent to the AI. The meta title and description stay in the source (they
 * are uploaded for English and part of the source hash) but are not translated: the
 * upload derives them from the translated name and description (`deriveProductSeoMeta`).
 */
export function translatableProductFields(
    product: TranslationSource["products"][string] | undefined
): Record<string, string> {
    return product ? { name: product.name, description: product.description } : {};
}

/**
 * Collect the English content that gets translated.
 *
 * Keys survive the Shopware ID remapping done during sync: category paths, product IDs,
 * English property group names, CMS page names.
 */
export function buildTranslationSource(
    blueprint: HydratedBlueprint,
    cmsBlueprint: CmsBlueprint | null
): TranslationSource {
    return {
        categories: collectCategories(blueprint.categories, null),
        products: Object.fromEntries(
            blueprint.products.map((p) => [
                p.id,
                {
                    name: p.name,
                    description: p.description,
                    ...(p.metaTitle && { metaTitle: p.metaTitle }),
                    ...(p.metaDescription && { metaDescription: p.metaDescription }),
                },
            ])
        ),
        propertyGroups: Object.fromEntries(
            blueprint.propertyGroups.map((g) => [
                g.name,
                { name: g.name, options: g.options.map((o) => o.name) },
            ])
        ),
        reviews: Object.fromEntries(
            blueprint.products
                .filter((p) => (p.metadata.reviewCount ?? 0) > 0)
                .map((p) => [
                    p.id,
                    buildProductReviews(p.id, p.name, p.metadata.reviewCount).map((r) => ({
                        title: r.title,
                        content: r.content,
                    })),
                ])
        ),
        cms: collectCmsTexts(cmsBlueprint),
        fixtures: { ...TRANSLATABLE_FIXTURE_TEXTS },
    };
}

/** CMS text slots per page name (English source) */
export function collectCmsTexts(cmsBlueprint: CmsBlueprint | null): TranslationSource["cms"] {
    return Object.fromEntries(
        (cmsBlueprint?.pages ?? []).map((page) => [page.name, cmsSlots(page)])
    );
}

function collectCategories(
    categories: BlueprintCategory[],
    parentPath: string | null
): TranslationSource["categories"] {
    return Object.fromEntries(
        categories.flatMap((cat) => {
            const path = buildCategoryPath(parentPath, cat.name);
            const children = Object.entries(collectCategories(cat.children, path));
            return [[path, { name: cat.name, description: cat.description }], ...children];
        })
    );
}

function cmsSlots(page: CmsBlueprint["pages"][number]): Record<string, string> {
    return Object.fromEntries(
        page.sections.flatMap((section, sectionIndex) =>
            section.blocks.flatMap((block) =>
                block.slots
                    .filter((slot) => slot.textContent)
                    .map((slot) => [
                        cmsSlotKey(sectionIndex, block.position, slot.slot),
                        slot.textContent ?? "",
                    ])
            )
        )
    );
}

/** Key of a CMS text slot inside a page: "<sectionIndex>.<blockPosition>.<slot>" */
export function cmsSlotKey(sectionIndex: number, blockPosition: number, slot: string): string {
    return `${sectionIndex}.${blockPosition}.${slot}`;
}

// =============================================================================
// Prompts
// =============================================================================

/** Human-readable name of a locale, e.g. "German (Germany)" */
export function describeLocale(locale: string): string {
    try {
        return new Intl.DisplayNames(["en"], { type: "language" }).of(locale) ?? locale;
    } catch {
        return locale;
    }
}

type PromptMode = "copy" | "reviews" | "terms";

/**
 * System prompt for a locale. Store-type agnostic: no domain examples.
 */
export function buildTranslationSystemPrompt(
    locale: string,
    formality: Formality,
    mode: PromptMode
): string {
    const language = describeLocale(locale);
    const address =
        formality === "formal"
            ? "Address the reader formally and consistently (e.g. the polite form of 'you')."
            : "Address the reader informally and consistently (e.g. the familiar form of 'you').";

    const shared = [
        `Use local conventions for units, numbers, dates and punctuation in ${language}.`,
        "Keep every HTML tag and the HTML structure exactly as in the source; only change the text between tags.",
        "Keep placeholders such as {name} unchanged.",
        "When a glossary is given, use its terms exactly.",
        "Return only JSON matching the schema. Return every key you were given, unchanged, with the same field names.",
    ];

    if (mode === "terms") {
        return [
            `You are a native ${language} e-commerce editor naming categories and product filters for an online store.`,
            `Give each term the word a native ${language} shop would use in its navigation and filters. Do not translate word for word.`,
            "Keep brand names, coined names and terms that natives commonly use in English anyway.",
            "Keep names short; use the same capitalisation style a native shop would use.",
            ...shared,
        ].join("\n");
    }

    if (mode === "reviews") {
        return [
            `You are a customer from the ${language} market writing product reviews in your own words.`,
            `Rewrite each review the way a real ${language}-speaking customer would write it: casual, everyday language, natural sentence rhythm, not a word-for-word translation.`,
            "Keep the sentiment and the star rating's tone of the original. Keep it about as long as the original.",
            "Use the given localised product names when the review mentions the product.",
            ...shared,
        ].join("\n");
    }

    return [
        `You are a native ${language} e-commerce copywriter. Rewrite the following store content for shoppers in that market.`,
        "Do not translate word for word: use the phrasing, idioms and sentence rhythm a native copywriter would write.",
        address,
        `Localise product names so they read naturally in ${language}: translate the generic part (product type, material, descriptive words), keep coined brand or product-line names that have no meaningful translation, and keep words natives commonly use in English anyway.`,
        "Keep facts, numbers, sizes and the meaning of every sentence. Do not add claims.",
        ...shared,
    ].join("\n");
}

// =============================================================================
// AI response schemas (strict-mode compatible: fixed keys, arrays instead of maps)
// =============================================================================

const TranslatedItemsSchema = z.object({
    items: z.array(
        z.object({
            key: z.string(),
            fields: z.array(z.object({ name: z.string(), value: z.string() })),
        })
    ),
});

const FormalityDecisionSchema = z.object({
    formality: z.enum(["formal", "informal"]),
    reason: z.string(),
});

// =============================================================================
// Validation
// =============================================================================

/** One unit of work: a key and its English fields */
export interface TranslationItem {
    key: string;
    fields: Record<string, string>;
}

/** Fields that may legitimately stay identical to English (names, short labels) */
const LONG_TEXT_MIN_LENGTH = 40;
const MIN_LENGTH_RATIO = 0.3;
const MAX_LENGTH_RATIO = 3;

function tagSet(text: string): string {
    const tags = [...text.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) =>
        (m[1] ?? "").toLowerCase()
    );
    return [...new Set(tags)].sort().join(",");
}

function placeholderSet(text: string): string {
    return [...new Set([...text.matchAll(/\{\w+\}/g)].map((m) => m[0]))].sort().join(",");
}

/**
 * Check a translated item against its source. Returns the problems found (empty = valid).
 */
export function validateTranslatedItem(
    source: TranslationItem,
    translated: Record<string, string> | undefined
): string[] {
    if (!translated) return ["missing"];

    return Object.entries(source.fields).flatMap(([field, english]) => {
        const value = translated[field];
        if (!english) return [];
        if (!value?.trim()) return [`${field}: empty`];
        if (tagSet(value) !== tagSet(english)) return [`${field}: HTML tags differ`];
        if (placeholderSet(value) !== placeholderSet(english))
            return [`${field}: placeholders differ`];
        if (english.length >= LONG_TEXT_MIN_LENGTH && value.trim() === english.trim()) {
            return [`${field}: identical to English`];
        }
        const ratio = value.length / english.length;
        if (
            english.length >= LONG_TEXT_MIN_LENGTH &&
            (ratio < MIN_LENGTH_RATIO || ratio > MAX_LENGTH_RATIO)
        ) {
            return [`${field}: length ratio ${ratio.toFixed(2)}`];
        }
        return [];
    });
}

/** Hash of the English source of an entry (detects stale translations) */
export function sourceHashOf(value: unknown): string {
    return createShortHash(JSON.stringify(value), 8);
}

// =============================================================================
// Batch translation
// =============================================================================

interface BatchContext {
    textProvider: TextProvider;
    locale: string;
    formality: Formality;
    glossary: Record<string, string>;
}

interface BatchRequest {
    mode: PromptMode;
    /** Short description of the content, shown to the model */
    label: string;
    items: TranslationItem[];
    /** Extra context lines for the user prompt (store info, product names) */
    context: string[];
}

interface BatchResult {
    translated: Map<string, Record<string, string>>;
    failed: string[];
}

/** Items per call, by content type. Keeps each response well below output limits. */
export const TRANSLATION_BATCH_SIZES = {
    terms: 150,
    categories: 20,
    products: 10,
    reviews: 25,
    fixtures: 20,
} as const;

function relevantGlossary(
    glossary: Record<string, string>,
    items: TranslationItem[]
): Record<string, string> {
    const text = items
        .flatMap((i) => Object.values(i.fields))
        .join("\n")
        .toLowerCase();
    return Object.fromEntries(
        Object.entries(glossary).filter(([term]) => text.includes(term.toLowerCase()))
    );
}

function buildUserPrompt(ctx: BatchContext, request: BatchRequest): string {
    const glossary = relevantGlossary(ctx.glossary, request.items);
    const payload = request.items.map((item) => ({ key: item.key, fields: item.fields }));

    return [
        ...request.context,
        "",
        `Content type: ${request.label}`,
        `Target locale: ${ctx.locale} (${describeLocale(ctx.locale)})`,
        ...(Object.keys(glossary).length > 0
            ? ["", "Glossary (English -> target):", JSON.stringify(glossary)]
            : []),
        "",
        "Items (each has a key and its English fields; return the same keys and field names):",
        JSON.stringify(payload),
    ].join("\n");
}

async function requestBatch(
    ctx: BatchContext,
    request: BatchRequest
): Promise<Map<string, Record<string, string>>> {
    const response = await executeWithRetry(() =>
        ctx.textProvider.generateCompletion(
            [
                {
                    role: "system",
                    content: buildTranslationSystemPrompt(ctx.locale, ctx.formality, request.mode),
                },
                { role: "user", content: buildUserPrompt(ctx, request) },
            ],
            TranslatedItemsSchema,
            "TranslatedItems"
        )
    );
    const parsed = TranslatedItemsSchema.parse(JSON.parse(response));
    return new Map(
        parsed.items.map((item) => [
            item.key,
            Object.fromEntries(item.fields.map((f) => [f.name, f.value])),
        ])
    );
}

async function attemptBatch(ctx: BatchContext, request: BatchRequest): Promise<BatchResult> {
    const result: BatchResult = { translated: new Map(), failed: [] };
    let response: Map<string, Record<string, string>>;
    try {
        response = await requestBatch(ctx, request);
    } catch (error) {
        logger.warn(`Translation batch failed (${request.label}, ${ctx.locale})`, {
            data: { error: error instanceof Error ? error.message : String(error) },
        });
        return { translated: new Map(), failed: request.items.map((i) => i.key) };
    }

    for (const item of request.items) {
        const translated = response.get(item.key);
        const problems = validateTranslatedItem(item, translated);
        if (problems.length > 0 || !translated) {
            logger.debug(`Translation rejected: ${request.label} ${item.key}`, {
                data: { problems },
            });
            result.failed.push(item.key);
            continue;
        }
        result.translated.set(item.key, translated);
    }
    return result;
}

/**
 * Translate items in batches. Items that fail validation are retried once in a
 * separate batch; items that fail again are reported and fall back to English.
 */
async function translateItems(
    ctx: BatchContext,
    limiter: ConcurrencyLimiter,
    request: Omit<BatchRequest, "items">,
    items: TranslationItem[],
    batchSize: number
): Promise<BatchResult> {
    if (items.length === 0) return { translated: new Map(), failed: [] };

    const firstPass = await limiter.all(
        chunkArray(items, batchSize).map(
            (batch) => () => attemptBatch(ctx, { ...request, items: batch })
        )
    );
    const translated = new Map(firstPass.flatMap((r) => [...r.translated]));
    const retryItems = items.filter((i) => !translated.has(i.key));
    if (retryItems.length === 0) return { translated, failed: [] };

    const secondPass = await limiter.all(
        chunkArray(retryItems, batchSize).map(
            (batch) => () => attemptBatch(ctx, { ...request, items: batch })
        )
    );
    for (const [key, value] of secondPass.flatMap((r) => [...r.translated])) {
        translated.set(key, value);
    }
    return { translated, failed: secondPass.flatMap((r) => r.failed) };
}

// =============================================================================
// Main entry
// =============================================================================

export interface TranslateCatalogInput {
    textProvider: TextProvider;
    locale: string;
    storeName: string;
    storeDescription: string;
    source: TranslationSource;
    /** Existing translation file for this locale (reused where the source is unchanged) */
    previous?: TranslationFile | null;
    /** Overrides the AI's formality choice */
    formality?: Formality;
    /** Translate everything again, ignoring the previous file */
    force?: boolean;
}

export interface TranslateCatalogResult {
    file: TranslationFile;
    /** Entries sent to the AI in this run */
    translated: number;
    /** Entries reused from the previous file */
    reused: number;
    /** Keys that failed validation twice and stay English ("<section>:<key>") */
    failed: string[];
}

async function decideFormality(
    textProvider: TextProvider,
    locale: string,
    storeName: string,
    storeDescription: string
): Promise<Formality> {
    try {
        const response = await executeWithRetry(() =>
            textProvider.generateCompletion(
                [
                    {
                        role: "system",
                        content: `You are a native ${describeLocale(locale)} e-commerce copywriter.`,
                    },
                    {
                        role: "user",
                        content: [
                            `Store: "${storeName}"`,
                            `Description: ${storeDescription}`,
                            "",
                            `Should this store address its customers formally or informally in ${describeLocale(locale)}?`,
                            "Decide the way a native shop with this positioning would.",
                        ].join("\n"),
                    },
                ],
                FormalityDecisionSchema,
                "FormalityDecision"
            )
        );
        return FormalityDecisionSchema.parse(JSON.parse(response)).formality;
    } catch (error) {
        logger.warn(`Could not decide formality for ${locale}, using formal`, {
            data: { error: error instanceof Error ? error.message : String(error) },
        });
        return "formal";
    }
}

/** Shared terms translated once into the glossary */
export function collectTerms(source: TranslationSource): string[] {
    const categoryNames = Object.values(source.categories).map((c) => c.name);
    const groupTerms = Object.values(source.propertyGroups).flatMap((g) => [g.name, ...g.options]);
    return [...new Set([...categoryNames, ...groupTerms].filter((t) => t.trim()))];
}

/**
 * A fixture text needs translating when it is new, changed since the last run or forced.
 * Files from before fixture hashes existed reuse every entry that has a text.
 */
export function isStaleFixture(
    key: string,
    hash: string,
    previous: Pick<TranslationFile, "fixtures" | "fixtureHashes"> | null | undefined,
    force: boolean | undefined
): boolean {
    if (force || !previous?.fixtures[key]) return true;
    if (!previous.fixtureHashes) return false;
    return previous.fixtureHashes[key] !== hash;
}

/** Split keys into entries reused from the previous file (same hash) and stale ones */
function splitStale<T extends { sourceHash: string }>(
    keys: string[],
    hashes: Map<string, string>,
    previous: Record<string, T> | undefined,
    force: boolean
): { reused: Record<string, T>; stale: string[] } {
    const reused: Record<string, T> = {};
    const stale: string[] = [];
    for (const key of keys) {
        const entry = previous?.[key];
        if (!force && entry && entry.sourceHash === hashes.get(key)) {
            reused[key] = entry;
            continue;
        }
        stale.push(key);
    }
    return { reused, stale };
}

/** Shared state of one translateCatalog run */
interface CatalogRun {
    ctx: BatchContext;
    limiter: ConcurrencyLimiter;
    source: TranslationSource;
    previous: TranslationFile | null;
    force: boolean;
    storeContext: string[];
}

/** One translated section: its entries, counts and failed keys ("<section>:<key>") */
interface SectionResult<T> {
    entries: T;
    translated: number;
    reused: number;
    failed: string[];
}

const hashesOf = (entries: Record<string, unknown>): Map<string, string> =>
    new Map(Object.entries(entries).map(([k, v]) => [k, sourceHashOf(v)]));

/** 1. Glossary of shared terms. Terms that fail stay English (still a valid name). */
async function translateGlossary(run: CatalogRun): Promise<SectionResult<Record<string, string>>> {
    const { previous } = run;
    const terms = collectTerms(run.source);
    const knownTerms = Object.fromEntries(
        terms.filter((t) => previous?.glossary[t]).map((t) => [t, previous?.glossary[t] ?? t])
    );
    const missingTerms = terms.filter((t) => !(t in knownTerms));
    const result = await translateItems(
        run.ctx,
        run.limiter,
        { mode: "terms", label: "category, filter and option names", context: run.storeContext },
        missingTerms.map((t) => ({ key: t, fields: { term: t } })),
        TRANSLATION_BATCH_SIZES.terms
    );
    const glossary = {
        ...knownTerms,
        ...Object.fromEntries(missingTerms.map((t) => [t, result.translated.get(t)?.term ?? t])),
    };
    return {
        entries: glossary,
        translated: result.translated.size,
        reused: Object.keys(knownTerms).length,
        failed: [],
    };
}

/** 2. Categories: name from the glossary, description translated */
async function translateCategories(
    run: CatalogRun
): Promise<SectionResult<TranslationFile["categories"]>> {
    const { source, ctx } = run;
    const hashes = hashesOf(source.categories);
    const split = splitStale(
        Object.keys(source.categories),
        hashes,
        run.previous?.categories,
        run.force
    );
    const result = await translateItems(
        ctx,
        run.limiter,
        { mode: "copy", label: "category descriptions", context: run.storeContext },
        split.stale.map((path) => ({
            key: path,
            fields: { description: source.categories[path]?.description ?? "" },
        })),
        TRANSLATION_BATCH_SIZES.categories
    );
    const categories: TranslationFile["categories"] = { ...split.reused };
    for (const path of split.stale) {
        const english = source.categories[path];
        const description = result.translated.get(path)?.description;
        if (!english || description === undefined) continue;
        categories[path] = {
            name: ctx.glossary[english.name] ?? english.name,
            description,
            sourceHash: hashes.get(path) ?? "",
        };
    }
    return {
        entries: categories,
        translated: result.translated.size,
        reused: Object.keys(split.reused).length,
        failed: result.failed.map((k) => `categories:${k}`),
    };
}

/** 3. Product names and descriptions */
async function translateProducts(
    run: CatalogRun
): Promise<SectionResult<TranslationFile["products"]>> {
    const { source } = run;
    const hashes = hashesOf(source.products);
    const split = splitStale(
        Object.keys(source.products),
        hashes,
        run.previous?.products,
        run.force
    );
    const result = await translateItems(
        run.ctx,
        run.limiter,
        { mode: "copy", label: "product names and descriptions", context: run.storeContext },
        split.stale.map((id) => ({
            key: id,
            fields: translatableProductFields(source.products[id]),
        })),
        TRANSLATION_BATCH_SIZES.products
    );
    const products: TranslationFile["products"] = { ...split.reused };
    for (const [id, fields] of result.translated) {
        products[id] = {
            name: fields.name ?? source.products[id]?.name ?? "",
            description: fields.description ?? "",
            sourceHash: hashes.get(id) ?? "",
        };
    }
    return {
        entries: products,
        translated: result.translated.size,
        reused: Object.keys(split.reused).length,
        failed: result.failed.map((k) => `products:${k}`),
    };
}

/** 4. Reviews (item keys "<productId>#<index>"), with the localised product names as context */
async function translateReviews(
    run: CatalogRun,
    products: TranslationFile["products"]
): Promise<SectionResult<TranslationFile["reviews"]>> {
    const { source } = run;
    const hashes = hashesOf(source.reviews);
    const split = splitStale(Object.keys(source.reviews), hashes, run.previous?.reviews, run.force);
    const items = split.stale.flatMap((id) =>
        (source.reviews[id] ?? []).map((review, index) => ({
            key: `${id}#${index}`,
            fields: { title: review.title, content: review.content },
        }))
    );
    const productNames = Object.fromEntries(
        split.stale.map((id) => [
            source.products[id]?.name ?? id,
            products[id]?.name ?? source.products[id]?.name ?? id,
        ])
    );
    const result = await translateItems(
        run.ctx,
        run.limiter,
        {
            mode: "reviews",
            label: "customer reviews (title and text)",
            context: [
                ...run.storeContext,
                "Localised product names (English -> target):",
                JSON.stringify(productNames),
            ],
        },
        items,
        TRANSLATION_BATCH_SIZES.reviews
    );
    const reviews: TranslationFile["reviews"] = { ...split.reused };
    for (const id of split.stale) {
        const english = source.reviews[id] ?? [];
        const translated = english.map((_, i) => result.translated.get(`${id}#${i}`));
        if (translated.some((t) => !t)) continue;
        reviews[id] = {
            reviews: translated.map((t) => ({ title: t?.title ?? "", content: t?.content ?? "" })),
            sourceHash: hashes.get(id) ?? "",
        };
    }
    return {
        entries: reviews,
        translated: result.translated.size,
        // Count single reviews, the same unit as translated
        reused: Object.values(split.reused).reduce((n, r) => n + r.reviews.length, 0),
        failed: result.failed.map((k) => `reviews:${k}`),
    };
}

/** 5. CMS pages, one call per page */
async function translateCmsPages(run: CatalogRun): Promise<SectionResult<TranslationFile["cms"]>> {
    const { source } = run;
    const hashes = hashesOf(source.cms);
    const split = splitStale(Object.keys(source.cms), hashes, run.previous?.cms, run.force);
    const pages = await Promise.all(
        split.stale.map(async (pageName) => {
            const slots = source.cms[pageName] ?? {};
            const items = Object.entries(slots).map(([key, html]) => ({ key, fields: { html } }));
            const result = await translateItems(
                run.ctx,
                run.limiter,
                {
                    mode: "copy",
                    label: `CMS page "${pageName}" (HTML text blocks)`,
                    context: run.storeContext,
                },
                items,
                Math.max(1, items.length)
            );
            return { pageName, items, result };
        })
    );
    const section: SectionResult<TranslationFile["cms"]> = {
        entries: { ...split.reused },
        translated: 0,
        // Count CMS slots, the same unit as translated
        reused: Object.values(split.reused).reduce((n, p) => n + Object.keys(p.slots).length, 0),
        failed: [],
    };
    for (const { pageName, items, result } of pages) {
        if (items.length === 0) continue;
        section.entries[pageName] = {
            slots: Object.fromEntries(
                [...result.translated].map(([key, f]) => [key, f.html ?? ""])
            ),
            // An incomplete page is stored without hash, so the next run translates it again
            sourceHash: result.failed.length === 0 ? (hashes.get(pageName) ?? "") : "",
        };
        section.failed.push(...result.failed.map((k) => `cms:${pageName}:${k}`));
        section.translated += result.translated.size;
    }
    return section;
}

interface FixtureTranslations {
    fixtures: Record<string, string>;
    fixtureHashes: Record<string, string>;
}

/** 6. Fixture texts. A failed entry keeps its old text without hash, so the next run retries it */
async function translateFixtures(run: CatalogRun): Promise<SectionResult<FixtureTranslations>> {
    const { source, previous } = run;
    const previousFixtures = previous?.fixtures ?? {};
    const keys = Object.keys(source.fixtures);
    const hashes = new Map(keys.map((k) => [k, sourceHashOf(source.fixtures[k] ?? "")]));
    const stale = keys.filter((k) => isStaleFixture(k, hashes.get(k) ?? "", previous, run.force));
    const result = await translateItems(
        run.ctx,
        run.limiter,
        { mode: "copy", label: "short store texts", context: run.storeContext },
        stale.map((k) => ({ key: k, fields: { text: source.fixtures[k] ?? "" } })),
        TRANSLATION_BATCH_SIZES.fixtures
    );
    const fixtures: Record<string, string> = Object.fromEntries(
        keys
            .map((k): [string, string | undefined] => [
                k,
                result.translated.get(k)?.text ?? previousFixtures[k],
            ])
            .filter((entry): entry is [string, string] => entry[1] !== undefined)
    );
    const failedKeys = new Set(result.failed);
    const fixtureHashes = Object.fromEntries(
        [...hashes].filter(([k]) => fixtures[k] !== undefined && !failedKeys.has(k))
    );
    return {
        entries: { fixtures, fixtureHashes },
        translated: result.translated.size,
        reused: keys.length - stale.length,
        failed: result.failed.map((k) => `fixtures:${k}`),
    };
}

/** Property groups and options, named from the glossary (no AI call of their own) */
function propertyGroupsFromGlossary(
    source: TranslationSource,
    glossary: Record<string, string>
): TranslationFile["propertyGroups"] {
    return Object.fromEntries(
        Object.entries(source.propertyGroups).map(([key, group]) => [
            key,
            {
                name: glossary[group.name] ?? group.name,
                options: Object.fromEntries(group.options.map((o) => [o, glossary[o] ?? o])),
            },
        ])
    );
}

/**
 * Translate the catalog into one locale.
 */
export async function translateCatalog(
    input: TranslateCatalogInput
): Promise<TranslateCatalogResult> {
    const { textProvider, locale, storeName, storeDescription } = input;
    const force = input.force ?? false;
    const previous = force ? null : (input.previous ?? null);
    const formality =
        input.formality ??
        previous?.style.formality ??
        (await decideFormality(textProvider, locale, storeName, storeDescription));
    const run: CatalogRun = {
        ctx: { textProvider, locale, formality, glossary: {} },
        limiter: new ConcurrencyLimiter(textProvider.maxConcurrency),
        source: input.source,
        previous,
        force,
        storeContext: [`Store: "${storeName}"`, `Store description: ${storeDescription}`],
    };

    // Sequential: every later section uses the glossary, reviews use the product names
    const glossary = await translateGlossary(run);
    run.ctx.glossary = glossary.entries;
    const categories = await translateCategories(run);
    const products = await translateProducts(run);
    const reviews = await translateReviews(run, products.entries);
    const cms = await translateCmsPages(run);
    const fixtures = await translateFixtures(run);
    const sections = [glossary, categories, products, reviews, cms, fixtures];

    return {
        file: {
            locale,
            sourceLocale: SOURCE_LOCALE,
            translatedAt: new Date().toISOString(),
            style: { formality },
            glossary: glossary.entries,
            categories: categories.entries,
            products: products.entries,
            propertyGroups: propertyGroupsFromGlossary(input.source, glossary.entries),
            reviews: reviews.entries,
            cms: cms.entries,
            ...fixtures.entries,
        },
        translated: sections.reduce((n, s) => n + s.translated, 0),
        reused: sections.reduce((n, s) => n + s.reused, 0),
        failed: sections.flatMap((s) => s.failed),
    };
}
