/**
 * Template Tools for MCP Server
 *
 * Exposes template metadata: template.json for the templates repo.
 */

import type { FastMCP } from "fastmcp";

import { z } from "zod";

import { writeTemplateMetadata } from "../../services/template-service.js";
import { validateSubdomainName } from "../../utils/index.js";

export function registerTemplateTools(server: FastMCP): void {
    // template_metadata - Write template.json
    server.addTool({
        name: "template_metadata",
        description:
            "Write template.json for a cached SalesChannel: generator version, date, text/image models, " +
            "languages and the Shopware versions it was imported into. Pass the e2e-results/<timestamp> " +
            "directory of a test-e2e-lanes.sh run to record lane results (older results of the same lane are replaced).",
        parameters: z.object({
            name: z.string().describe("SalesChannel name"),
            e2e: z
                .string()
                .optional()
                .describe("e2e-results/<timestamp> directory of a test-e2e-lanes.sh run"),
        }),
        execute: async (args) => {
            const validation = validateSubdomainName(args.name);
            if (!validation.valid) {
                return `Error: Invalid name - ${validation.error}`;
            }
            return writeTemplateMetadata(validation.sanitized, { e2eDir: args.e2e }).join("\n");
        },
    });
}
