import { describe, expect, mock, test } from "bun:test";

import type { MockApiHelpers } from "../../mocks/index.js";

import {
    B2B_CUSTOMER_GROUP,
    DEMO_CUSTOMERS,
    DEMO_PASSWORD,
} from "../../../src/fixtures/demo-customers.js";
import { CustomerProcessor } from "../../../src/post-processors/customer-processor.js";
import { createTestContext } from "../../helpers/post-processor-context.js";

function setupSalesChannelMock(mockApi: MockApiHelpers): void {
    mockApi.mockSearchResponse("sales-channel", [
        {
            id: "sc-123",
            customerGroupId: "default-group-id",
            countryId: "country-id",
            paymentMethodId: "payment-method-id",
            languageId: "language-id",
        },
    ]);
}

function setupSalutationMock(mockApi: MockApiHelpers): void {
    mockApi.mockSearchResponse("salutation", [
        { id: "sal-mr", salutationKey: "mr" },
        { id: "sal-mrs", salutationKey: "mrs" },
    ]);
}

describe("CustomerProcessor", () => {
    describe("metadata", () => {
        test("has correct name", () => {
            expect(CustomerProcessor.name).toBe("customers");
        });

        test("has description", () => {
            expect(CustomerProcessor.description).toBeDefined();
            expect(CustomerProcessor.description.length).toBeGreaterThan(0);
        });

        test("has no dependencies", () => {
            expect(CustomerProcessor.dependsOn).toEqual([]);
        });
    });

    describe("process", () => {
        test("dry run reports what would be created", async () => {
            const { context } = createTestContext({ dryRun: true });
            const result = await CustomerProcessor.process(context);

            expect(result.processed).toBe(DEMO_CUSTOMERS.length);
            expect(result.skipped).toBe(0);
            expect(result.errors).toHaveLength(0);
        });

        test("returns error when no default customer group found", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.mockSearchResponse("sales-channel", []);
            setupSalutationMock(mockApi);
            mockApi.mockFindByName("customer-group", B2B_CUSTOMER_GROUP.name, null);
            mockApi.mockSearchResponse("customer", []);

            const result = await CustomerProcessor.process(context);

            expect(result.processed).toBe(0);
            expect(result.errors).toContain("No default customer group found");
        });

        test("creates B2B group and demo customers", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.mockSyncSuccess();
            setupSalesChannelMock(mockApi);
            setupSalutationMock(mockApi);
            mockApi.mockFindByName("customer-group", B2B_CUSTOMER_GROUP.name, null);
            mockApi.mockSearchResponse("customer", []);

            const result = await CustomerProcessor.process(context);

            expect(result.processed).toBe(DEMO_CUSTOMERS.length);
            expect(result.skipped).toBe(0);
            expect(result.errors).toHaveLength(0);

            const syncCalls = mockApi.getCallsByEndpoint("_action/sync");
            expect(syncCalls.length).toBe(2);
        });

        test("skips existing B2B group", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.mockSyncSuccess();
            setupSalesChannelMock(mockApi);
            setupSalutationMock(mockApi);
            mockApi.mockFindByName("customer-group", B2B_CUSTOMER_GROUP.name, "existing-b2b-id");
            mockApi.mockSearchResponse("customer", []);

            const result = await CustomerProcessor.process(context);

            expect(result.processed).toBe(DEMO_CUSTOMERS.length);
            expect(result.errors).toHaveLength(0);

            const syncCalls = mockApi.getCallsByEndpoint("_action/sync");
            expect(syncCalls.length).toBe(1);
        });

        test("is idempotent - skips existing customers", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.mockSyncSuccess();
            setupSalesChannelMock(mockApi);
            setupSalutationMock(mockApi);
            mockApi.mockFindByName("customer-group", B2B_CUSTOMER_GROUP.name, "b2b-id");

            mockApi.mockSearchResponse(
                "customer",
                DEMO_CUSTOMERS.map((c) => ({ id: `id-${c.email}`, email: c.email }))
            );

            const result = await CustomerProcessor.process(context);

            expect(result.processed).toBe(0);
            expect(result.skipped).toBe(DEMO_CUSTOMERS.length);
        });

        test("skips only existing customers, creates new ones", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.mockSyncSuccess();
            setupSalesChannelMock(mockApi);
            setupSalutationMock(mockApi);
            mockApi.mockFindByName("customer-group", B2B_CUSTOMER_GROUP.name, "b2b-id");

            const firstCustomer = DEMO_CUSTOMERS[0];
            mockApi.mockSearchResponse("customer", [
                { id: "existing-1", email: firstCustomer?.email ?? "" },
            ]);

            const result = await CustomerProcessor.process(context);

            expect(result.processed).toBe(DEMO_CUSTOMERS.length - 1);
            expect(result.skipped).toBe(1);
        });

        test("customer payload includes correct fields", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.mockSyncSuccess();
            setupSalesChannelMock(mockApi);
            setupSalutationMock(mockApi);
            mockApi.mockFindByName("customer-group", B2B_CUSTOMER_GROUP.name, "b2b-group-id");
            mockApi.mockSearchResponse("customer", []);

            await CustomerProcessor.process(context);

            const syncCalls = mockApi.getCallsByEndpoint("_action/sync");
            const customerSync = syncCalls.find((c) => {
                const body = c.body as Record<string, { entity: string }>;
                return body["create-customers"]?.entity === "customer";
            });

            expect(customerSync).toBeDefined();
            const syncBody = customerSync?.body as
                | Record<string, { payload: Array<Record<string, unknown>> }>
                | undefined;
            const payload = syncBody?.["create-customers"]?.payload ?? [];

            const defaultCustomer = payload.find((p) => p.email === "customer@example.com");
            expect(defaultCustomer).toBeDefined();
            expect(defaultCustomer!.salesChannelId).toBe("sc-123");
            expect(defaultCustomer!.groupId).toBe("default-group-id");
            expect(defaultCustomer!.password).toBe(DEMO_PASSWORD);
            expect(defaultCustomer!.firstName).toBe("Max");
            expect(defaultCustomer!.lastName).toBe("Mustermann");
            expect(defaultCustomer!.addresses).toBeDefined();

            const b2bCustomer = payload.find((p) => p.email === "b2b@example.com");
            expect(b2bCustomer).toBeDefined();
            expect(b2bCustomer!.groupId).toBe("b2b-group-id");
        });

        test("handles API errors gracefully", async () => {
            const { context, mockApi } = createTestContext();
            setupSalesChannelMock(mockApi);
            setupSalutationMock(mockApi);
            mockApi.mockFindByName("customer-group", B2B_CUSTOMER_GROUP.name, null);
            mockApi.mockSearchResponse("customer", []);
            mockApi.mockSyncFailure(new Error("Sync failed"));

            const result = await CustomerProcessor.process(context);

            expect(result.errors.length).toBeGreaterThan(0);
        });
    });

    describe("cleanup", () => {
        test("returns early in dry run mode", async () => {
            const { context } = createTestContext({ dryRun: true });

            const result = await CustomerProcessor.cleanup!(context);

            expect(result.deleted).toBe(0);
            expect(result.errors).toHaveLength(0);
        });

        test("deletes demo customers and empty B2B group", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.mockSyncSuccess();
            mockApi.mockSearchResponseSequence("customer", [
                [
                    { id: "c1", email: "customer@example.com" },
                    { id: "c2", email: "b2b@example.com" },
                ],
                [],
            ]);

            mockApi.mockFindByName("customer-group", B2B_CUSTOMER_GROUP.name, "b2b-group-id");
            mockApi.deleteEntities = mock(async () => {});

            const result = await CustomerProcessor.cleanup!(context);

            expect(result.deleted).toBe(3);
            expect(result.errors).toHaveLength(0);
        });

        test("keeps B2B group if other customers still use it", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.mockSyncSuccess();
            mockApi.mockSearchResponseSequence("customer", [
                [{ id: "c1", email: "customer@example.com" }],
                [{ id: "other-b2b-customer" }],
            ]);

            mockApi.mockFindByName("customer-group", B2B_CUSTOMER_GROUP.name, "b2b-group-id");
            mockApi.deleteEntities = mock(async () => {});

            const result = await CustomerProcessor.cleanup!(context);

            expect(result.deleted).toBe(1);
            expect(result.errors).toHaveLength(0);
        });

        test("handles cleanup error gracefully", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.searchEntities = mock(async () => {
                throw new Error("Search failed");
            });

            const result = await CustomerProcessor.cleanup!(context);

            expect(result.deleted).toBe(0);
            expect(result.errors.length).toBeGreaterThan(0);
            expect(result.errors[0]).toContain("Customer cleanup failed");
        });
    });
});
