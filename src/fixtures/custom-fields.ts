/**
 * Custom Field Fixtures - Custom field set attached to every generated product
 *
 * The sync step creates the set once per shop (idempotent, found by name) and
 * every product carries values for all fields. The set shows up in the
 * Administration under Settings > Custom fields and on the product detail page
 * in the "Specifications" tab, so testers can verify custom field rendering
 * without creating a set by hand.
 *
 * Field names are prefixed with `cg_` (catalog generator) to avoid clashes with
 * sets that already exist in a shop.
 */

/** Shopware custom field type (subset used by the generator) */
export type CustomFieldType = "bool" | "int" | "text";

/** Custom field definition */
export interface CustomFieldDefinition {
    /** Technical name (unique per shop, `cg_` prefix) */
    name: string;
    /** Shopware storage type */
    type: CustomFieldType;
    /** Label shown in the Administration (en-GB) */
    label: string;
    /** Whether the value is indexed for product search (Shopware 6.7.7+) */
    includeInSearch: boolean;
}

/** Custom field set definition */
export interface CustomFieldSetDefinition {
    /** Technical set name (unique per shop) */
    name: string;
    /** Label shown in the Administration (en-GB) */
    label: string;
    /** Entities the set is attached to */
    entities: readonly string[];
    /** Fields in the set, in display order */
    fields: readonly CustomFieldDefinition[];
}

/** Custom field set created for generated products */
export const PRODUCT_CUSTOM_FIELD_SET: CustomFieldSetDefinition = {
    name: "catalog_generator",
    label: "Catalog Generator",
    entities: ["product"],
    fields: [
        {
            name: "cg_featured",
            type: "bool",
            label: "Featured product",
            includeInSearch: false,
        },
        {
            name: "cg_launch_year",
            type: "int",
            label: "Launch year",
            includeInSearch: false,
        },
        {
            name: "cg_internal_note",
            type: "text",
            label: "Internal note",
            includeInSearch: true,
        },
    ],
};

/** Administration component config per custom field type */
const FIELD_CONFIG_BY_TYPE: Record<CustomFieldType, Record<string, unknown>> = {
    bool: { type: "switch", componentName: "sw-field", customFieldType: "switch" },
    int: {
        type: "number",
        numberType: "int",
        componentName: "sw-field",
        customFieldType: "number",
    },
    text: { type: "text", componentName: "sw-field", customFieldType: "text" },
};

/**
 * Build the Administration config object for a custom field.
 * The config decides which input the Administration renders.
 */
export function buildCustomFieldConfig(field: CustomFieldDefinition): Record<string, unknown> {
    return {
        ...FIELD_CONFIG_BY_TYPE[field.type],
        label: { "en-GB": field.label },
    };
}
