import { describe, expect, test } from "bun:test";

import { resolveCmsProcessors } from "../../../src/services/image-fix-service.js";

describe("resolveCmsProcessors", () => {
    test("all and cms select every CMS image processor", () => {
        const every = ["cms-home", "cms-images", "cms-text-images"];
        expect(resolveCmsProcessors("all")).toEqual(every);
        expect(resolveCmsProcessors("cms")).toEqual(every);
    });

    test("home and listing pages select cms-home", () => {
        expect(resolveCmsProcessors("home")).toEqual(["cms-home"]);
        expect(resolveCmsProcessors("home listing")).toEqual(["cms-home"]);
        expect(resolveCmsProcessors("product listing")).toEqual(["cms-home"]);
    });

    test("text & images pages select cms-text-images", () => {
        expect(resolveCmsProcessors("text & images")).toEqual(["cms-text-images"]);
        expect(resolveCmsProcessors("text-images")).toEqual(["cms-text-images"]);
        expect(resolveCmsProcessors("image with text")).toEqual(["cms-text-images"]);
    });

    test("text or image alone selects nothing", () => {
        expect(resolveCmsProcessors("text")).toEqual([]);
        expect(resolveCmsProcessors("image")).toEqual([]);
    });

    test("image elements pages select cms-images", () => {
        expect(resolveCmsProcessors("image elements")).toEqual(["cms-images"]);
        expect(resolveCmsProcessors("images")).toEqual(["cms-images"]);
        expect(resolveCmsProcessors("cms-images")).toEqual(["cms-images"]);
        expect(resolveCmsProcessors("my images")).toEqual([]);
    });

    test("selects several processors in a fixed order without duplicates", () => {
        expect(resolveCmsProcessors("home text & images image elements")).toEqual([
            "cms-home",
            "cms-text-images",
            "cms-images",
        ]);
    });

    test("unknown pages select nothing", () => {
        expect(resolveCmsProcessors("video")).toEqual([]);
        expect(resolveCmsProcessors("")).toEqual([]);
    });
});
