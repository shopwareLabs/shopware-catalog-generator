/**
 * Template metadata types.
 *
 * `generation.json` records which generator version and which models produced each part
 * of a cached SalesChannel. `template.json` is the summary that ships with a template in
 * the templates repo: generator version, date, models, languages and the Shopware versions
 * the template was imported into.
 */

import { z } from "zod";

export const ModelInfoSchema = z.object({
    provider: z.string(),
    model: z.string(),
    /** OpenAI image quality (low, medium, high, auto) */
    quality: z.string().optional(),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

export const GeneratorInfoSchema = z.object({
    /** package.json version */
    version: z.string(),
    /** Short git commit, when run from a git checkout */
    commit: z.string().optional(),
});
export type GeneratorInfo = z.infer<typeof GeneratorInfoSchema>;

export const GenerationStepSchema = z.object({
    /** ISO timestamp of the run */
    at: z.string(),
    generator: GeneratorInfoSchema,
    text: ModelInfoSchema,
    /** Undefined when the step generated no images */
    image: ModelInfoSchema.optional(),
});
export type GenerationStep = z.infer<typeof GenerationStepSchema>;

/**
 * Last run of each generation step. Keys: "hydrate", "hydrate:categories",
 * "hydrate:properties", "hydrate:cms", "translate:<locale>".
 */
export const GenerationLogSchema = z.object({
    steps: z.record(z.string(), GenerationStepSchema),
});
export type GenerationLog = z.infer<typeof GenerationLogSchema>;

export const LaneResultSchema = z.object({
    /** Lane name of the e2e run, e.g. "67" or "trunk" */
    lane: z.string(),
    shopwareVersion: z.string(),
    passed: z.boolean(),
    /** Date of the e2e run (YYYY-MM-DD) */
    testedAt: z.string(),
});
export type LaneResult = z.infer<typeof LaneResultSchema>;

export const TEMPLATE_INFO_SCHEMA_VERSION = 1;

export const TemplateInfoSchema = z.object({
    schemaVersion: z.literal(TEMPLATE_INFO_SCHEMA_VERSION),
    name: z.string(),
    description: z.string(),
    /** ISO timestamp when template.json was written */
    createdAt: z.string(),
    /** Generator that wrote template.json */
    generator: GeneratorInfoSchema,
    content: z.object({
        products: z.number(),
        categories: z.number(),
        /** "en" plus every translated locale */
        languages: z.array(z.string()),
    }),
    /** Models of the full hydration run, when it was recorded */
    models: z
        .object({
            text: ModelInfoSchema,
            image: ModelInfoSchema.optional(),
        })
        .optional(),
    steps: z.record(z.string(), GenerationStepSchema),
    testedOn: z.array(LaneResultSchema),
});
export type TemplateInfo = z.infer<typeof TemplateInfoSchema>;
