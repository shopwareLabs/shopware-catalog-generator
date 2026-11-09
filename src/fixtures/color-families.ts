/**
 * Colour families - the fixed, filterable colour level
 *
 * Every shade (the "Color" group, shown on the product detail page) maps to exactly one
 * of these 16 families. The families live in their own property group, "Color family",
 * which is the only colour group shown in the listing filter.
 *
 * Basis: the 11 basic colour terms of Berlin and Kay (1969), plus Beige, Gold, Silver,
 * Multicolor and Transparent, which commerce filters add on top.
 *
 * Families are generic and the same for every store, so their translations are fixed
 * here and need no AI. Languages without an entry fall back to the AI translation pass.
 */

import type { ColorFamily } from "../types/index.js";

import { COLOR_FAMILY_KEYS } from "../types/index.js";
import { deterministicUUID } from "../utils/uuid.js";

export interface ColorFamilyFixture {
    key: ColorFamily;
    /** English option name */
    name: string;
    /** Representative hex code for the filter swatch */
    hex: string;
    /** Option name per language code (ISO 639-1, e.g. "de") */
    translations: Record<string, string>;
}

/** Name of the shade group (variant options, product detail page) */
export const COLOR_SHADE_GROUP_NAME = "Color";

/** Name of the family group (listing filter) */
export const COLOR_FAMILY_GROUP_NAME = "Color family";

/** Stable ID of the family group, the same in every shop */
export const COLOR_FAMILY_GROUP_ID = deterministicUUID("property-group:color-family");

/** Family group name per language code */
export const COLOR_FAMILY_GROUP_TRANSLATIONS: Record<string, string> = {
    de: "Farbfamilie",
    fr: "Famille de couleurs",
    es: "Familia de colores",
    it: "Famiglia di colori",
    nl: "Kleurfamilie",
    pl: "Rodzina kolorów",
    pt: "Família de cores",
    da: "Farvefamilie",
    sv: "Färgfamilj",
};

const FAMILY_DATA: Record<ColorFamily, Omit<ColorFamilyFixture, "key">> = {
    black: {
        name: "Black",
        hex: "#1a1a1a",
        translations: {
            de: "Schwarz",
            fr: "Noir",
            es: "Negro",
            it: "Nero",
            nl: "Zwart",
            pl: "Czarny",
            pt: "Preto",
            da: "Sort",
            sv: "Svart",
        },
    },
    white: {
        name: "White",
        hex: "#ffffff",
        translations: {
            de: "Weiß",
            fr: "Blanc",
            es: "Blanco",
            it: "Bianco",
            nl: "Wit",
            pl: "Biały",
            pt: "Branco",
            da: "Hvid",
            sv: "Vit",
        },
    },
    gray: {
        name: "Gray",
        hex: "#808080",
        translations: {
            de: "Grau",
            fr: "Gris",
            es: "Gris",
            it: "Grigio",
            nl: "Grijs",
            pl: "Szary",
            pt: "Cinzento",
            da: "Grå",
            sv: "Grå",
        },
    },
    red: {
        name: "Red",
        hex: "#d32f2f",
        translations: {
            de: "Rot",
            fr: "Rouge",
            es: "Rojo",
            it: "Rosso",
            nl: "Rood",
            pl: "Czerwony",
            pt: "Vermelho",
            da: "Rød",
            sv: "Röd",
        },
    },
    orange: {
        name: "Orange",
        hex: "#f57c00",
        translations: {
            de: "Orange",
            fr: "Orange",
            es: "Naranja",
            it: "Arancione",
            nl: "Oranje",
            pl: "Pomarańczowy",
            pt: "Laranja",
            da: "Orange",
            sv: "Orange",
        },
    },
    yellow: {
        name: "Yellow",
        hex: "#fbc02d",
        translations: {
            de: "Gelb",
            fr: "Jaune",
            es: "Amarillo",
            it: "Giallo",
            nl: "Geel",
            pl: "Żółty",
            pt: "Amarelo",
            da: "Gul",
            sv: "Gul",
        },
    },
    green: {
        name: "Green",
        hex: "#388e3c",
        translations: {
            de: "Grün",
            fr: "Vert",
            es: "Verde",
            it: "Verde",
            nl: "Groen",
            pl: "Zielony",
            pt: "Verde",
            da: "Grøn",
            sv: "Grön",
        },
    },
    blue: {
        name: "Blue",
        hex: "#1976d2",
        translations: {
            de: "Blau",
            fr: "Bleu",
            es: "Azul",
            it: "Blu",
            nl: "Blauw",
            pl: "Niebieski",
            pt: "Azul",
            da: "Blå",
            sv: "Blå",
        },
    },
    purple: {
        name: "Purple",
        hex: "#7b1fa2",
        translations: {
            de: "Lila",
            fr: "Violet",
            es: "Morado",
            it: "Viola",
            nl: "Paars",
            pl: "Fioletowy",
            pt: "Roxo",
            da: "Lilla",
            sv: "Lila",
        },
    },
    pink: {
        name: "Pink",
        hex: "#ec407a",
        translations: {
            de: "Rosa",
            fr: "Rose",
            es: "Rosa",
            it: "Rosa",
            nl: "Roze",
            pl: "Różowy",
            pt: "Rosa",
            da: "Lyserød",
            sv: "Rosa",
        },
    },
    brown: {
        name: "Brown",
        hex: "#795548",
        translations: {
            de: "Braun",
            fr: "Marron",
            es: "Marrón",
            it: "Marrone",
            nl: "Bruin",
            pl: "Brązowy",
            pt: "Castanho",
            da: "Brun",
            sv: "Brun",
        },
    },
    beige: {
        name: "Beige",
        hex: "#d8c3a5",
        translations: {
            de: "Beige",
            fr: "Beige",
            es: "Beige",
            it: "Beige",
            nl: "Beige",
            pl: "Beżowy",
            pt: "Bege",
            da: "Beige",
            sv: "Beige",
        },
    },
    gold: {
        name: "Gold",
        hex: "#d4af37",
        translations: {
            de: "Gold",
            fr: "Doré",
            es: "Dorado",
            it: "Oro",
            nl: "Goud",
            pl: "Złoty",
            pt: "Dourado",
            da: "Guld",
            sv: "Guld",
        },
    },
    silver: {
        name: "Silver",
        hex: "#c0c0c0",
        translations: {
            de: "Silber",
            fr: "Argenté",
            es: "Plateado",
            it: "Argento",
            nl: "Zilver",
            pl: "Srebrny",
            pt: "Prateado",
            da: "Sølv",
            sv: "Silver",
        },
    },
    multicolor: {
        name: "Multicolor",
        hex: "#9e9e9e",
        translations: {
            de: "Mehrfarbig",
            fr: "Multicolore",
            es: "Multicolor",
            it: "Multicolore",
            nl: "Meerkleurig",
            pl: "Wielokolorowy",
            pt: "Multicolor",
            da: "Flerfarvet",
            sv: "Flerfärgad",
        },
    },
    transparent: {
        name: "Transparent",
        hex: "#f5f5f5",
        translations: {
            de: "Transparent",
            fr: "Transparent",
            es: "Transparente",
            it: "Trasparente",
            nl: "Transparant",
            pl: "Przezroczysty",
            pt: "Transparente",
            da: "Gennemsigtig",
            sv: "Transparent",
        },
    },
};

/** All 16 families in display order */
export const COLOR_FAMILIES: ColorFamilyFixture[] = COLOR_FAMILY_KEYS.map((key) => ({
    key,
    ...FAMILY_DATA[key],
}));

/** Stable option ID of a family, the same in every shop */
export function colorFamilyOptionId(family: ColorFamily): string {
    return deterministicUUID(`property-group-option:color-family:${family}`);
}

export function getColorFamily(family: ColorFamily): ColorFamilyFixture {
    return { key: family, ...FAMILY_DATA[family] };
}

/** Language part of a locale ("de-DE" → "de") */
function languageOf(locale: string): string {
    return locale.toLowerCase().split(/[-_]/)[0] ?? "";
}

/**
 * Fixed translation of a family option or the family group for a locale.
 * Returns undefined when the fixture has no entry for the locale's language.
 */
export function colorFamilyTranslation(locale: string, family?: ColorFamily): string | undefined {
    const language = languageOf(locale);
    if (!family) return COLOR_FAMILY_GROUP_TRANSLATIONS[language];
    return FAMILY_DATA[family].translations[language];
}
