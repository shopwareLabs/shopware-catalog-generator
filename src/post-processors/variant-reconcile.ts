/**
 * Compare the variants a product should have with the variants it has in Shopware.
 *
 * A failed or interrupted run can leave a parent with only some of its variants or
 * configurator settings. Instead of skipping such a product, the variant processor
 * creates what is missing and removes what no longer matches the blueprint.
 */

/** A child variant that already exists in Shopware */
export interface ExistingVariantChild {
    id: string;
    optionIds: string[];
}

/** A configurator setting that already exists on the parent */
export interface ExistingConfiguratorSetting {
    id: string;
    optionId: string;
}

/** Variants and configurator settings that already exist for a parent product */
export interface ExistingVariants {
    children: ExistingVariantChild[];
    settings: ExistingConfiguratorSetting[];
}

/** What has to change so the product matches the blueprint */
export interface VariantReconcilePlan<T extends { id: string }> {
    /** Option combinations without a child variant */
    missingCombos: T[][];
    /** Children whose option combination is not in the blueprint */
    staleChildIds: string[];
    /** Options without a configurator setting */
    missingOptionIds: string[];
    /** Configurator settings for options that are not in the blueprint */
    staleSettingIds: string[];
}

/** Order-independent key of an option combination */
function comboKey(optionIds: string[]): string {
    return [...optionIds].sort().join("|");
}

export function planVariantReconcile<T extends { id: string }>(
    combos: T[][],
    existing: ExistingVariants
): VariantReconcilePlan<T> {
    const wantedCombos = new Set(combos.map((combo) => comboKey(combo.map((o) => o.id))));
    const existingCombos = new Set(existing.children.map((c) => comboKey(c.optionIds)));
    const wantedOptionIds = new Set(combos.flat().map((o) => o.id));
    const existingOptionIds = new Set(existing.settings.map((s) => s.optionId));

    return {
        missingCombos: combos.filter(
            (combo) => !existingCombos.has(comboKey(combo.map((o) => o.id)))
        ),
        staleChildIds: existing.children
            .filter((c) => !wantedCombos.has(comboKey(c.optionIds)))
            .map((c) => c.id),
        missingOptionIds: [...wantedOptionIds].filter((id) => !existingOptionIds.has(id)),
        staleSettingIds: existing.settings
            .filter((s) => !wantedOptionIds.has(s.optionId))
            .map((s) => s.id),
    };
}

/** True when the product already matches the blueprint */
export function isVariantPlanEmpty<T extends { id: string }>(
    plan: VariantReconcilePlan<T>
): boolean {
    return (
        plan.missingCombos.length === 0 &&
        plan.staleChildIds.length === 0 &&
        plan.missingOptionIds.length === 0 &&
        plan.staleSettingIds.length === 0
    );
}
