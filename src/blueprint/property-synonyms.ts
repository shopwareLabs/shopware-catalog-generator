/**
 * Property group synonyms - merge groups that name the same thing
 *
 * Product hydration runs per category branch, so the AI sometimes names one property in
 * several ways: "Outlet", "Outlets" and "Outlet Count", or "Connector" and "Connector Type".
 * In the shop that becomes several filters for the same thing. Before upload the groups
 * are merged into the name most products use. Matching is generic (plural and a trailing
 * "Count" / "Type"), and only groups that really collide in this catalog are merged.
 */

import type { BlueprintPropertyGroup, HydratedBlueprint } from "../types/index.js";

import { COLOR_FAMILY_GROUP_NAME } from "../fixtures/index.js";

/** One merged group, for the log */
export interface PropertyGroupMerge {
    from: string;
    to: string;
}

const SUFFIXES = [" count", " type"];

function singular(word: string): string {
    if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
    if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) return word.slice(0, -1);
    return word;
}

/** Key two synonymous group names share: "Outlet Count", "Outlets" → "outlet" */
export function propertyGroupKey(name: string): string {
    const lower = name.trim().toLowerCase().replace(/\s+/g, " ");
    const suffix = SUFFIXES.find((s) => lower.endsWith(s) && lower.length > s.length);
    const base = suffix ? lower.slice(0, -suffix.length) : lower;
    return base.split(" ").map(singular).join(" ");
}

/** Groups that are never renamed: the colour system and every variant group */
function protectedGroupNames(blueprint: HydratedBlueprint): Set<string> {
    const variantGroups = blueprint.products.flatMap((p) =>
        (p.metadata.variantConfigs ?? []).map((c) => c.group.toLowerCase())
    );
    return new Set(["color", COLOR_FAMILY_GROUP_NAME.toLowerCase(), ...variantGroups]);
}

/** How many products use each group name */
function groupUsage(blueprint: HydratedBlueprint): Map<string, number> {
    const usage = new Map<string, number>();
    for (const product of blueprint.products) {
        for (const group of new Set(product.metadata.properties.map((p) => p.group))) {
            usage.set(group, (usage.get(group) ?? 0) + 1);
        }
    }
    return usage;
}

/** The name most products use; ties go to the shorter name */
function canonicalName(names: string[], usage: Map<string, number>): string {
    return [...names].sort(
        (a, b) => (usage.get(b) ?? 0) - (usage.get(a) ?? 0) || a.length - b.length
    )[0] as string;
}

/** Old name → new name for every group that is merged into another one */
function buildRenames(blueprint: HydratedBlueprint): Map<string, string> {
    const usage = groupUsage(blueprint);
    const fixed = protectedGroupNames(blueprint);
    const clusters = new Map<string, string[]>();
    for (const name of usage.keys()) {
        if (fixed.has(name.toLowerCase())) continue;
        const key = propertyGroupKey(name);
        clusters.set(key, [...(clusters.get(key) ?? []), name]);
    }
    const renames = new Map<string, string>();
    for (const names of clusters.values()) {
        if (names.length < 2) continue;
        const target = canonicalName(names, usage);
        names.filter((n) => n !== target).forEach((n) => renames.set(n, target));
    }
    return renames;
}

/** Merge the options of renamed groups into their target group */
function mergeGroups(
    groups: BlueprintPropertyGroup[],
    renames: Map<string, string>
): BlueprintPropertyGroup[] {
    const byName = new Map(groups.map((g) => [g.name, g]));
    for (const [from, to] of renames) {
        const source = byName.get(from);
        const target = byName.get(to);
        if (!source || !target) continue;
        const known = new Set(target.options.map((o) => o.name.toLowerCase()));
        target.options.push(...source.options.filter((o) => !known.has(o.name.toLowerCase())));
    }
    return groups.filter((g) => !renames.has(g.name) || !byName.has(renames.get(g.name) ?? ""));
}

/**
 * Merge synonymous property groups in place (product properties and property groups).
 * A product that had both names keeps the first value.
 */
export function mergeSynonymPropertyGroups(blueprint: HydratedBlueprint): PropertyGroupMerge[] {
    const renames = buildRenames(blueprint);
    if (renames.size === 0) return [];

    for (const product of blueprint.products) {
        const seen = new Set<string>();
        product.metadata.properties = product.metadata.properties
            .map((p) => ({ ...p, group: renames.get(p.group) ?? p.group }))
            .filter((p) => !seen.has(p.group) && seen.add(p.group) !== undefined);
    }
    blueprint.propertyGroups = mergeGroups(blueprint.propertyGroups, renames);
    return [...renames].map(([from, to]) => ({ from, to }));
}

/** Groups whose products use only one option: a filter with one entry filters nothing */
export function singleOptionGroupNames(blueprint: HydratedBlueprint): Set<string> {
    const values = new Map<string, Set<string>>();
    for (const product of blueprint.products) {
        for (const prop of product.metadata.properties) {
            const group = prop.group.toLowerCase();
            values.set(group, (values.get(group) ?? new Set()).add(prop.value.toLowerCase()));
        }
    }
    return new Set([...values].filter(([, v]) => v.size === 1).map(([group]) => group));
}
