import type { z } from "zod";

import type { ChatMessage, TextProvider } from "../../src/types/providers.js";

type DynamicResponseFn = (messages: ChatMessage[]) => unknown;

/**
 * Mock text provider for testing
 * Allows setting predefined responses based on schema names
 */
export class MockTextProvider implements TextProvider {
    readonly name = "mock";
    readonly isSequential = false;
    readonly maxConcurrency = 5;
    readonly tokenLimit = 128000;

    private responses: Map<string, string> = new Map();
    private dynamicResponses: Map<string, DynamicResponseFn> = new Map();
    private callLog: Array<{
        messages: ChatMessage[];
        schemaName?: string;
    }> = [];

    /**
     * Set a response for a specific schema name
     */
    setResponse(schemaName: string, response: unknown): void {
        this.responses.set(schemaName, JSON.stringify(response));
    }

    /**
     * Set a raw string response for a specific schema name
     */
    setRawResponse(schemaName: string, response: string): void {
        this.responses.set(schemaName, response);
    }

    /**
     * Set a dynamic response function that generates response based on the prompt
     */
    setDynamicResponse(schemaName: string, fn: DynamicResponseFn): void {
        this.dynamicResponses.set(schemaName, fn);
    }

    /**
     * Get all calls made to this provider
     */
    getCalls(): Array<{ messages: ChatMessage[]; schemaName?: string }> {
        return [...this.callLog];
    }

    /**
     * Clear all responses and call history
     */
    reset(): void {
        this.responses.clear();
        this.dynamicResponses.clear();
        this.callLog = [];
    }

    /**
     * Get the number of calls made
     */
    get callCount(): number {
        return this.callLog.length;
    }

    async generateCompletion(
        messages: ChatMessage[],
        _schema?: z.ZodTypeAny,
        schemaName?: string
    ): Promise<string> {
        this.callLog.push({ messages, schemaName });

        const key = schemaName || "default";

        // Check for dynamic response first
        const dynamicFn = this.dynamicResponses.get(key);
        if (dynamicFn) {
            return JSON.stringify(dynamicFn(messages));
        }

        // Then check for static response
        const response = this.responses.get(key);
        if (response !== undefined) {
            return response;
        }

        // Return empty object by default
        return "{}";
    }
}

/**
 * Create a mock text provider with predefined product data
 */
export function createMockTextProviderWithProducts(): MockTextProvider {
    const provider = new MockTextProvider();

    // Set up default responses for common schema names
    provider.setResponse("product", {
        name: "Test Product",
        description: "A test product description with enough words to pass validation.",
        stock: 100,
        price: 29.99,
        productReviews: [
            {
                title: "Great product",
                content: "Really enjoyed this product.",
                points: 5,
            },
        ],
    });

    // Batch product response - generates multiple products in one call
    provider.setResponse("products", {
        products: [
            {
                name: "Test Product 1",
                description: "First test product description with enough words.",
                stock: 100,
                price: 29.99,
                productReviews: [{ title: "Great", content: "Great product.", points: 5 }],
            },
            {
                name: "Test Product 2",
                description: "Second test product description with enough words.",
                stock: 50,
                price: 39.99,
                productReviews: [{ title: "Good", content: "Good product.", points: 4 }],
            },
            {
                name: "Test Product 3",
                description: "Third test product description with enough words.",
                stock: 75,
                price: 19.99,
                productReviews: [{ title: "Nice", content: "Nice product.", points: 4 }],
            },
            {
                name: "Test Product 4",
                description: "Fourth test product description with enough words.",
                stock: 25,
                price: 49.99,
                productReviews: [{ title: "Excellent", content: "Excellent product.", points: 5 }],
            },
            {
                name: "Test Product 5",
                description: "Fifth test product description with enough words.",
                stock: 200,
                price: 9.99,
                productReviews: [{ title: "OK", content: "OK product.", points: 3 }],
            },
        ],
    });

    provider.setResponse("propertyGroups", {
        propertyGroups: [
            {
                name: "Color",
                description: "Product color options",
                displayType: "color",
                options: [
                    { name: "Red", colorHexCode: "#FF0000" },
                    { name: "Blue", colorHexCode: "#0000FF" },
                ],
            },
            {
                name: "Size",
                description: "Product size options",
                displayType: "text",
                options: [{ name: "Small" }, { name: "Medium" }, { name: "Large" }],
            },
        ],
    });

    return provider;
}
