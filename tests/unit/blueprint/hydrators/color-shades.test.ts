import { describe, expect, test } from "bun:test";

import {
    COLOR_SHADE_BATCH_SIZE,
    findUnknownShades,
    hydrateColorShades,
} from "../../../../src/blueprint/hydrators/index.js";
import { MockTextProvider } from "../../../mocks/index.js";

const STORE = { name: "test-store", description: "Test store" };

describe("findUnknownShades", () => {
    test("skips curated, learned, image and combination colours", () => {
        const learned = { moss: { name: "Moss", hex: "#4a6b2a", family: "green" as const } };
        const unknown = findUnknownShades(
            ["grey", "Moss", "Rainbow", "Black & White", "dusty rose", "Dusty Rose", ""],
            learned
        );
        expect(unknown).toEqual(["Dusty Rose"]);
    });
});

describe("hydrateColorShades", () => {
    test("makes no AI call when every name is known", async () => {
        const provider = new MockTextProvider();
        const learned = await hydrateColorShades(provider, ["Navy", "grey"], STORE);
        expect(provider.callCount).toBe(0);
        expect(learned).toEqual({});
    });

    test("classifies unknown names with the store context", async () => {
        const provider = new MockTextProvider();
        provider.setResponse("ColorShades", {
            shades: [{ name: "dusty rose", hex: "#c48b8b", family: "pink" }],
        });

        const learned = await hydrateColorShades(provider, ["Dusty Rose", "Navy"], STORE, {
            moss: { name: "Moss", hex: "#4a6b2a", family: "green" },
        });

        expect(learned).toEqual({
            moss: { name: "Moss", hex: "#4a6b2a", family: "green" },
            "dusty rose": { name: "Dusty Rose", hex: "#c48b8b", family: "pink" },
        });
        const prompt =
            provider
                .getCalls()[0]
                ?.messages.map((m) => m.content)
                .join("\n") ?? "";
        expect(prompt).toContain('Store: "test-store"');
        expect(prompt).toContain("- Dusty Rose");
        expect(prompt).not.toContain("- Navy");
    });

    test("estimates names the AI skipped", async () => {
        const provider = new MockTextProvider();
        provider.setResponse("ColorShades", { shades: [] });
        const learned = await hydrateColorShades(provider, ["Deep Forest Green"], STORE);
        expect(learned["deep forest green"]).toMatchObject({ family: "green" });
    });

    test("estimates every name when the response is invalid", async () => {
        const provider = new MockTextProvider();
        provider.setRawResponse("ColorShades", '{"shades":[{"name":"Xyzzy","hex":"red"}]}');
        const learned = await hydrateColorShades(provider, ["Xyzzy"], STORE);
        expect(learned.xyzzy).toEqual({ name: "Xyzzy", hex: "#808080", family: "gray" });
    });

    test("accepts responses wrapped in code fences", async () => {
        const provider = new MockTextProvider();
        provider.setRawResponse(
            "ColorShades",
            '```json\n{"shades":[{"name":"Moss","hex":"#4a6b2a","family":"green"}]}\n```'
        );
        const learned = await hydrateColorShades(provider, ["Moss"], STORE);
        expect(learned.moss?.hex).toBe("#4a6b2a");
    });

    test("splits large name lists into batches", async () => {
        const provider = new MockTextProvider();
        provider.setResponse("ColorShades", { shades: [] });
        const names = Array.from({ length: COLOR_SHADE_BATCH_SIZE + 1 }, (_, i) => `Shade ${i}`);
        const learned = await hydrateColorShades(provider, names, STORE);
        expect(provider.callCount).toBe(2);
        expect(Object.keys(learned)).toHaveLength(names.length);
    });
});
