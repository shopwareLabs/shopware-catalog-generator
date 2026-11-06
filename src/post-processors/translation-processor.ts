/**
 * Translation Processor - writes cached translations to Shopware (no AI)
 *
 * Reads `translations/{locale}.json` (produced by `blueprint translate`) and writes the
 * texts as entity translations for every language of the SalesChannel that has content:
 * products, categories, property groups and options, manufacturers and CMS slots.
 *
 * Runs after the processors that create the translated entities (manufacturers,
 * variants, CMS pages). Reviews are handled by the review processor, because a review
 * belongs to exactly one language.
 */

import type { CmsPageStructure, LanguageContent } from "../shopware/index.js";
import type { CmsBlueprint } from "../types/index.js";
import type { PostProcessor, PostProcessorContext, PostProcessorResult } from "./index.js";

import { buildTranslationSource } from "../blueprint/hydrators/translation.js";
import {
    getShopLanguages,
    loadAllTranslations,
    planLanguageContent,
} from "../shopware/languages.js";
import { buildTranslationOperations } from "../shopware/translation-payload.js";
import { logger, toStoreScopedName } from "../utils/index.js";

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

/** Read the CMS pages of this store (sections > blocks > slots) */
async function loadCmsPages(
    context: PostProcessorContext,
    cmsBlueprint: CmsBlueprint | null
): Promise<CmsPageStructure[]> {
    if (!cmsBlueprint) return [];

    const pages = await Promise.all(
        cmsBlueprint.pages.map(async (page): Promise<CmsPageStructure | null> => {
            const rows = await context.api.searchEntities<CmsPageRow>(
                "cms-page",
                [
                    {
                        type: "equals",
                        field: "name",
                        value: toStoreScopedName(page.name, context.salesChannelName),
                    },
                ],
                { limit: 1, associations: CMS_PAGE_ASSOCIATIONS }
            );
            const row = rows[0];
            if (!row) return null;
            return {
                pageName: page.name,
                sections: (row.sections ?? []).map((section) => ({
                    position: section.position,
                    blocks: (section.blocks ?? []).map((block) => ({
                        position: block.position,
                        slots: block.slots ?? [],
                    })),
                })),
            };
        })
    );
    return pages.filter((page): page is CmsPageStructure => page !== null);
}

class TranslationProcessorImpl implements PostProcessor {
    readonly name = "translations";
    readonly description = "Write cached translations (products, categories, CMS, ...)";
    readonly dependsOn: string[] = ["manufacturers", "variants", "cms-testing"];

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
        const operations = buildTranslationOperations({
            blueprint: context.blueprint,
            source: buildTranslationSource(context.blueprint, cmsBlueprint),
            languages,
            manufacturers: context.cache.loadManufacturers(context.salesChannelName) ?? [],
            cmsPages: await loadCmsPages(context, cmsBlueprint),
            openGraph: context.shopware.supports("productOpenGraph"),
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
