/**
 * Packaging Unit Fixtures - Units and packaging options for product content display
 *
 * Shopware shows "6 pc (1 pc = $4.99)" style reference prices when a product has a
 * unit (`unitId`), a content amount (`purchaseUnit`), a reference amount
 * (`referenceUnit`) and a packaging label (`packUnit`). The blueprint generator
 * assigns one of these options to a share of all products; the sync step creates
 * the units in Shopware (a fresh shop has no unit rows) and links them.
 *
 * Labels are kept generic so they fit every store type.
 */

/** Shopware `unit` entity definition */
export interface UnitDefinition {
    /** Short code shown next to the amount (e.g. "pc") */
    shortCode: string;
    /** Display name (e.g. "Piece") */
    name: string;
}

/** Packaging option assigned to a product */
export interface PackagingOption {
    /** Short code of the unit, must exist in PACKAGING_UNITS */
    unitShortCode: string;
    /** Amount of `unit` in one sales unit (e.g. 6 pieces per pack) */
    purchaseUnit: number;
    /** Base amount for the reference price (e.g. price per 1 piece) */
    referenceUnit: number;
    /** Packaging label, singular (e.g. "Pack") */
    packUnit: string;
    /** Packaging label, plural (e.g. "Packs") */
    packUnitPlural: string;
}

/** Units created in Shopware when a product needs them (keyed by short code) */
export const PACKAGING_UNITS: readonly UnitDefinition[] = [
    { shortCode: "pc", name: "Piece" },
    { shortCode: "kg", name: "Kilogram" },
    { shortCode: "m", name: "Meter" },
];

/** Packaging options the generator picks from (share of products: PACKAGING_SHARE) */
export const PACKAGING_OPTIONS: readonly PackagingOption[] = [
    {
        unitShortCode: "pc",
        purchaseUnit: 2,
        referenceUnit: 1,
        packUnit: "Pair",
        packUnitPlural: "Pairs",
    },
    {
        unitShortCode: "pc",
        purchaseUnit: 3,
        referenceUnit: 1,
        packUnit: "Set",
        packUnitPlural: "Sets",
    },
    {
        unitShortCode: "pc",
        purchaseUnit: 6,
        referenceUnit: 1,
        packUnit: "Pack",
        packUnitPlural: "Packs",
    },
    {
        unitShortCode: "pc",
        purchaseUnit: 12,
        referenceUnit: 1,
        packUnit: "Box",
        packUnitPlural: "Boxes",
    },
    {
        unitShortCode: "kg",
        purchaseUnit: 0.5,
        referenceUnit: 1,
        packUnit: "Bag",
        packUnitPlural: "Bags",
    },
    {
        unitShortCode: "m",
        purchaseUnit: 5,
        referenceUnit: 1,
        packUnit: "Roll",
        packUnitPlural: "Rolls",
    },
];

/** Share of products that get a packaging option (0-1) */
export const PACKAGING_SHARE = 0.15;

/** Find the unit definition for a packaging option */
export function findPackagingUnit(shortCode: string): UnitDefinition | undefined {
    return PACKAGING_UNITS.find((unit) => unit.shortCode === shortCode);
}
