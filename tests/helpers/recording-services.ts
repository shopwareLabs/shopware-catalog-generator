/**
 * Command services that record their calls instead of running (parity tests).
 */

import type { CommandServices } from "../../src/services/commands.js";

export interface ServiceCall {
    service: keyof CommandServices;
    args: unknown[];
}

/** Every service records its name and arguments and returns ["✓ ok"] */
export function recordingServices(calls: ServiceCall[]): CommandServices {
    const ok = ["✓ ok"];
    const record =
        (service: keyof CommandServices) =>
        (...args: unknown[]): string[] => {
            calls.push({ service, args });
            return ok;
        };
    return {
        createBlueprint: async (...a) => record("createBlueprint")(...a),
        estimateBlueprintCost: (...a) => record("estimateBlueprintCost")(...a),
        estimateTranslation: async (...a) => record("estimateTranslation")(...a),
        translateBlueprint: async (...a) => record("translateBlueprint")(...a),
        hydrateBlueprint: async (...a) => record("hydrateBlueprint")(...a),
        inspireBlueprint: async (...a) => record("inspireBlueprint")(...a),
        fixBlueprint: async (...a) => record("fixBlueprint")(...a),
        fixImages: async (...a) => record("fixImages")(...a),
        writeTemplateMetadata: (...a) => record("writeTemplateMetadata")(...a),
        runProcessors: async (...a) => record("runProcessors")(...a),
        listCache: (...a) => record("listCache")(...a),
        clearCache: (...a) => record("clearCache")(...a),
        listTrash: (...a) => record("listTrash")(...a),
        restoreFromTrash: (...a) => record("restoreFromTrash")(...a),
        emptyTrash: (...a) => record("emptyTrash")(...a),
        cleanupSalesChannelData: async (...a) => record("cleanupSalesChannelData")(...a),
        cleanupGlobal: async (...a) => record("cleanupGlobal")(...a),
    };
}
