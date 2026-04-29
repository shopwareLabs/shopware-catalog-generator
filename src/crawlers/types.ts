import { z } from "zod";

export const ExampleProductSchema = z.object({
    name: z.string(),
    description: z.string().optional(),
    category: z.string().optional(),
});

export const InspirationDataSchema = z.object({
    sourceUrl: z.string(),
    crawledAt: z.string(),
    brandDescription: z.string().optional(),
    brandColors: z
        .object({
            primary: z.string(),
            secondary: z.string(),
        })
        .optional(),
    categories: z.array(z.string()).default([]),
    exampleProducts: z.array(ExampleProductSchema).default([]),
});

export type InspirationData = z.infer<typeof InspirationDataSchema>;
export type ExampleProduct = z.infer<typeof ExampleProductSchema>;
