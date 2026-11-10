import { describe, expect, test } from "bun:test";

import { viewFromFileName } from "../../../src/post-processors/image-utils.js";

describe("viewFromFileName", () => {
    test("reads the view from the file name suffix", () => {
        expect(viewFromFileName("oak-desk-front")).toBe("front");
        expect(viewFromFileName("oak-desk-lifestyle")).toBe("lifestyle");
    });

    test("returns null for unknown or missing names", () => {
        expect(viewFromFileName("oak-desk")).toBeNull();
        expect(viewFromFileName(null)).toBeNull();
    });
});
