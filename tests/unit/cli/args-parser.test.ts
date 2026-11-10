import { describe, expect, test } from "bun:test";

import { parseCliArgs } from "../../../src/main.js";

// We drive parseCliArgs by overwriting process.argv for the duration of each test.
function parse(...args: string[]) {
    const orig = process.argv;
    process.argv = ["bun", "src/main.ts", ...args];
    try {
        return parseCliArgs();
    } finally {
        process.argv = orig;
    }
}

describe("parseCliArgs", () => {
    describe("--flag=value (equals form)", () => {
        test("parses --name=furniture", () => {
            expect(
                parse("blueprint", "inspire", "--name=furniture", "--url=https://example.com").name
            ).toBe("furniture");
        });

        test("parses URL with = signs intact", () => {
            const args = parse(
                "blueprint",
                "inspire",
                "--name=shop",
                "--url=https://example.com?a=1&b=2"
            );
            expect(args.url).toBe("https://example.com?a=1&b=2");
        });

        test("parses --products=60 as number", () => {
            expect(parse("generate", "--name=shop", "--products=60").products).toBe(60);
        });

        test("parses --only=categories,properties as array", () => {
            expect(
                parse("blueprint", "hydrate", "--name=shop", "--only=categories,properties").only
            ).toEqual(["categories", "properties"]);
        });
    });

    describe("--flag value (space form)", () => {
        test("parses --name furniture", () => {
            expect(
                parse("blueprint", "inspire", "--name", "furniture", "--url", "https://example.com")
                    .name
            ).toBe("furniture");
        });

        test("parses --url with space", () => {
            expect(
                parse("blueprint", "inspire", "--name", "shop", "--url", "https://example.com").url
            ).toBe("https://example.com");
        });

        test("parses --description with space", () => {
            expect(
                parse("generate", "--name", "shop", "--description", "My shop").description
            ).toBe("My shop");
        });
    });

    describe("boolean flags", () => {
        test("--rehydrate is true", () => {
            expect(parse("blueprint", "hydrate", "--name=shop", "--rehydrate").rehydrate).toBe(
                true
            );
        });

        test("--dry-run is true", () => {
            expect(parse("process", "--name=shop", "--dry-run").dryRun).toBe(true);
        });

        test("--rehydrate does not consume next arg as value", () => {
            const args = parse(
                "blueprint",
                "hydrate",
                "--name=shop",
                "--rehydrate",
                "--only=categories"
            );
            expect(args.rehydrate).toBe(true);
            expect(args.only).toEqual(["categories"]);
        });
    });

    describe("subcommand parsing", () => {
        test("extracts blueprint subcommand", () => {
            expect(parse("blueprint", "inspire", "--name=x", "--url=y").subcommand).toBe("inspire");
        });

        test("extracts template subcommand and --e2e directory", () => {
            const args = parse(
                "template",
                "metadata",
                "--name=beauty",
                "--e2e=e2e-results/20261109"
            );
            expect(args.subcommand).toBe("metadata");
            expect(args.e2e).toBe("e2e-results/20261109");
        });

        test("command without subcommand", () => {
            expect(parse("generate", "--name=shop").subcommand).toBeUndefined();
        });
    });

    describe("edge cases", () => {
        test("--help returns help command", () => {
            expect(parse("--help").command).toBe("help");
        });

        test("no args returns help command", () => {
            expect(parse().command).toBe("help");
        });
    });

    describe("flags without a value", () => {
        test("a bare string flag is undefined, not true", () => {
            const args = parse("blueprint", "create", "--name", "--dry-run");
            expect(args.name).toBeUndefined();
            expect(args.dryRun).toBe(true);
        });

        test("a bare --only does not throw", () => {
            expect(parse("process", "--name=shop", "--only").only).toBeUndefined();
        });

        test("a bare --products is NaN, so validation rejects it", () => {
            expect(parse("generate", "--name=shop", "--products").products).toBeNaN();
        });

        test("an empty --description= stays an empty string", () => {
            expect(parse("generate", "--name=shop", "--description=").description).toBe("");
        });

        test("only the first positional becomes the subcommand", () => {
            expect(parse("blueprint", "create", "extra", "--name=shop").subcommand).toBe("create");
            expect(parse("generate", "stray", "--name=shop").subcommand).toBeUndefined();
        });
    });
});
