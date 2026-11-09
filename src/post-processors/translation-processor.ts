/**
 * Translation Processor - writes cached translations to Shopware (no AI)
 *
 * Reads `translations/{locale}.json` (produced by `blueprint translate`) and writes the
 * texts as entity translations for every language of the SalesChannel that has content:
 * products, categories, property groups and options, manufacturers, CMS slots (AI pages
 * and the homepage), units, packaging labels, promotions, image alt texts and the
 * footer navigation.
 *
 * Runs after the processors that create the translated entities (manufacturers,
 * variants, CMS pages, footer pages). Reviews are handled by the review processor, because a review
 * belongs to exactly one language.
 */

import type {
    CmsPageStructure,
    LanguageContent,
    TranslationPayloadInput,
} from "../shopware/index.js";
import type { CmsBlueprint } from "../types/index.js";
import type { PostProcessor, PostProcessorContext, PostProcessorResult } from "./index.js";

import { buildTranslationSource } from "../blueprint/hydrators/translation.js";
import { collectVariantImageTasks } from "../blueprint/hydrators/variant-images.js";
import {
    FOOTER_CATEGORY_NAMES,
    HOME_LISTING_PAGE,
    PACKAGING_UNITS,
    PROMOTIONS,
} from "../fixtures/index.js";
import { searchAllByEqualsAny, searchAllByFilter } from "../shopware/api-helpers.js";
import {
    getShopLanguages,
    loadAllTranslations,
    planLanguageContent,
} from "../shopware/languages.js";
import { buildTranslationOperations } from "../shopware/translation-payload.js";
import { buildBlueprintCategoryPathMap, logger, toStoreScopedName } from "../utils/index.js";
import { buildHomeSlotTexts, homeFeaturesFor } from "./cms/home-processor.js";
import { viewFromFileName } from "./image-utils.js";
import { variantImageMediaId } from "./variant-image-processor.js";

interface CmsPageRow {
    sections?: Array<{
        position: number;
        blocks?: Array<{
            position: number;
            slots?: Array<{ id: string; slot: string; config?: Record<string, unknown> | null }>;
        }>;
    }>;
}

const CMS_PAGE_ASSOCIATIONS = {
    sections: { associations: { blocks: { associations: { slots: {} } } } },
};

function describeLanguages(languages: LanguageContent[]): string {
    return languages
        .map(({ language, content }) =>
            content.kind === "source" ? `${language.locale} (English)` : language.locale
        )
        .join(", ");
}

/** Read one CMS page of this store (sections > blocks > slots) by its fixture name */
async function loadCmsPage(
    context: PostProcessorContext,
    pageName: string
): Promise<CmsPageStructure | null> {
    const rows = await context.api.searchEntities<CmsPageRow>(
        "cms-page",
        [
            {
                type: "equals",
                field: "name",
                value: toStoreScopedName(pageName, context.salesChannelName),
            },
        ],
        { limit: 1, associations: CMS_PAGE_ASSOCIATIONS }
    );
    const row = rows[0];
    if (!row) return null;
    return {
        pageName,
        sections: (row.sections ?? []).map((section) => ({
            position: section.position,
            blocks: (section.blocks ?? []).map((block) => ({
                position: block.position,
                slots: block.slots ?? [],
            })),
        })),
    };
}

/** Read the AI-hydrated CMS pages of this store */
async function loadCmsPages(
    context: PostProcessorContext,
    cmsBlueprint: CmsBlueprint | null
): Promise<CmsPageStructure[]> {
    if (!cmsBlueprint) return [];
    const pages = await Promise.all(
        cmsBlueprint.pages.map((page) => loadCmsPage(context, page.name))
    );
    return pages.filter((page): page is CmsPageStructure => page !== null);
}

/** Homepage (cms-home) with its slot texts, rebuilt per language from fixture texts */
async function loadHome(context: PostProcessorContext): Promise<TranslationPayloadInput["home"]> {
    const page = await loadCmsPage(context, HOME_LISTING_PAGE.name);
    if (!page) return undefined;
    const features = homeFeaturesFor(context.options.activeProcessors);
    return {
        page,
        slotTexts: (texts) => buildHomeSlotTexts(context.blueprint, features, texts),
    };
}

/** Units the generator creates, found by their (English) short code */
async function loadUnits(
    context: PostProcessorContext
): Promise<Array<{ id: string; shortCode: string }>> {
    return context.api.searchEntities<{ id: string; shortCode: string }>(
        "unit",
        [{ type: "equalsAny", field: "shortCode", value: PACKAGING_UNITS.map((u) => u.shortCode) }],
        { limit: PACKAGING_UNITS.length * 2, includes: { unit: ["id", "shortCode"] } }
    );
}

/** Demo promotions, found by code */
async function loadPromotions(
    context: PostProcessorContext
): Promise<Array<{ id: string; code: string }>> {
    return context.api.searchEntities<{ id: string; code: string }>(
        "promotion",
        [{ type: "equalsAny", field: "code", value: PROMOTIONS.map((p) => p.code) }],
        { limit: PROMOTIONS.length * 2, includes: { promotion: ["id", "code"] } }
    );
}

interface ProductMediaRow {
    productId: string;
    mediaId: string;
    media?: { fileName?: string | null } | null;
}

/** Product images of the blueprint products, with the view each one shows */
async function loadProductMedia(
    context: PostProcessorContext
): Promise<NonNullable<TranslationPayloadInput["productMedia"]>> {
    const productIds = context.blueprint.products.map((p) => p.id);
    if (productIds.length === 0) return [];
    const rows = await searchAllByFilter<ProductMediaRow>(
        context,
        "product-media",
        [{ type: "equalsAny", field: "productId", value: productIds }],
        { associations: { media: {} } }
    );
    const productMedia = rows.flatMap((row) => {
        const view = viewFromFileName(row.media?.fileName);
        return view ? [{ mediaId: row.mediaId, productId: row.productId, view }] : [];
    });
    return [...productMedia, ...(await loadVariantMedia(context))];
}

/** Colour variant images that exist in Shopware, with the view and shade they show */
async function loadVariantMedia(
    context: PostProcessorContext
): Promise<NonNullable<TranslationPayloadInput["productMedia"]>> {
    const tasks = collectVariantImageTasks(context.blueprint, "all").map((task) => ({
        task,
        mediaId: variantImageMediaId(task.productId, task.view),
    }));
    if (tasks.length === 0) return [];
    const existing = await searchAllByEqualsAny<{ id: string }>(
        context,
        "media",
        "id",
        tasks.map((t) => t.mediaId),
        { includes: { media: ["id"] } }
    );
    const existingIds = new Set(existing.map((m) => m.id));
    return tasks
        .filter((t) => existingIds.has(t.mediaId))
        .map(({ task, mediaId }) => ({
            mediaId,
            productId: task.productId,
            view: task.sourceView,
            shade: task.color.name,
        }));
}

/** Category banner images of the blueprint categories */
async function loadCategoryMedia(
    context: PostProcessorContext
): Promise<NonNullable<TranslationPayloadInput["categoryMedia"]>> {
    const categoryIds = [...buildBlueprintCategoryPathMap(context.blueprint.categories).values()];
    if (categoryIds.length === 0) return [];
    const rows = await searchAllByFilter<{ id: string; mediaId?: string | null }>(
        context,
        "category",
        [{ type: "equalsAny", field: "id", value: categoryIds }],
        { includes: { category: ["id", "mediaId"] } }
    );
    return rows.flatMap((row) =>
        row.mediaId ? [{ mediaId: row.mediaId, categoryId: row.id }] : []
    );
}

interface SalesChannelFooterRow {
    footerCategoryId?: string | null;
    serviceCategoryId?: string | null;
}

/** Footer categories (cms-footer-pages) below this SalesChannel's footer roots */
async function loadFooterCategories(
    context: PostProcessorContext
): Promise<Array<{ id: string; name: string }>> {
    const salesChannel = await context.api.getEntity<SalesChannelFooterRow>(
        "sales-channel",
        context.salesChannelId
    );
    const rootIds = [salesChannel?.footerCategoryId, salesChannel?.serviceCategoryId].filter(
        (id): id is string => Boolean(id)
    );
    if (rootIds.length === 0) return [];

    const rows = await context.api.searchEntities<{ id: string; name?: string | null }>(
        "category",
        [
            { type: "equalsAny", field: "name", value: [...FOOTER_CATEGORY_NAMES] },
            {
                type: "multi",
                operator: "or",
                queries: rootIds.map((id) => ({ type: "contains", field: "path", value: id })),
            },
        ],
        { limit: 100, includes: { category: ["id", "name"] } }
    );
    return rows.flatMap((row) => (row.name ? [{ id: row.id, name: row.name }] : []));
}

class TranslationProcessorImpl implements PostProcessor {
    readonly name = "translations";
    readonly description = "Write cached translations (products, categories, CMS, ...)";
    readonly dependsOn: string[] = [
        "manufacturers",
        "variants",
        "cms-testing",
        "cms-home",
        "cms-footer-pages",
        "images",
        "variant-images",
        "promotions",
    ];

    async process(context: PostProcessorContext): Promise<PostProcessorResult> {
        const result = (processed: number, skipped: number, errors: string[] = []) => ({
            name: this.name,
            processed,
            skipped,
            errors,
            durationMs: 0,
        });

        const translations = loadAllTranslations(context.cache, context.salesChannelName);
        if (translations.size === 0) {
            logger.info("    No translations cached, skipping", { cli: true });
            return result(0, 1);
        }

        const languages = planLanguageContent(
            await getShopLanguages(context.api, context.salesChannelId),
            translations
        );
        if (languages.length === 0) {
            logger.warn(
                `    ⚠ No SalesChannel language matches the cached translations (${[...translations.keys()].join(", ")})`,
                { cli: true }
            );
            return result(0, 1);
        }

        const cmsBlueprint = context.cache.loadCmsBlueprint(context.salesChannelName);
        const [cmsPages, home, units, promotions, productMedia, categoryMedia, footerCategories] =
            await Promise.all([
                loadCmsPages(context, cmsBlueprint),
                loadHome(context),
                loadUnits(context),
                loadPromotions(context),
                loadProductMedia(context),
                loadCategoryMedia(context),
                loadFooterCategories(context),
            ]);
        const operations = buildTranslationOperations({
            blueprint: context.blueprint,
            source: buildTranslationSource(context.blueprint, cmsBlueprint),
            languages,
            manufacturers: context.cache.loadManufacturers(context.salesChannelName) ?? [],
            cmsPages,
            openGraph: context.shopware.supports("productOpenGraph"),
            home,
            units,
            promotions,
            productMedia,
            categoryMedia,
            footerCategories,
        });

        const records = Object.values(operations).reduce((n, op) => n + op.payload.length, 0);
        const summary = `${records} records for ${describeLanguages(languages)}`;

        if (context.options.dryRun) {
            logger.info(`    [DRY RUN] Would write translations: ${summary}`, { cli: true });
            return result(records, 0);
        }

        try {
            await context.api.syncEntities(operations);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return result(0, 0, [`Failed to write translations: ${message}`]);
        }

        logger.info(`    ✓ Wrote translations: ${summary}`, { cli: true });
        return result(records, 0);
    }
}

export const TranslationProcessor = new TranslationProcessorImpl();
