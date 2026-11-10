import { describe, expect, mock, test } from "bun:test";

import type { PostProcessorContext } from "../../../src/post-processors/index.js";
import type { MockApiHelpers } from "../../mocks/index.js";

import {
    B2B_CUSTOMER_GROUP,
    DEMO_CUSTOMERS,
    DEMO_PASSWORD,
} from "../../../src/fixtures/demo-customers.js";
import {
    buildBusinessAccountFields,
    buildBusinessAccountUpgrades,
    buildCustomerPayload,
    CustomerProcessor,
} from "../../../src/post-processors/customer-processor.js";
import { createTestContext } from "../../helpers/post-processor-context.js";

/** Context without API helpers (simulates a missing Shopware connection) */
function withoutApi(context: PostProcessorContext): PostProcessorContext {
    const { api: _api, ...rest } = context;
    return { ...rest } as PostProcessorContext;
}

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

        test("returns error without API helpers", async () => {
            const { context } = createTestContext();
            const result = await CustomerProcessor.process(withoutApi(context));

            expect(result).toEqual({
                name: "customers",
                processed: 0,
                skipped: 0,
                errors: ["API helpers not available"],
                durationMs: 0,
            });
        });

        test("returns error when no country found", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.mockSearchResponse("sales-channel", [
                { id: "sc-123", customerGroupId: "g", paymentMethodId: "p" },
            ]);
            setupSalutationMock(mockApi);

            const result = await CustomerProcessor.process(context);

            expect(result.processed).toBe(0);
            expect(result.skipped).toBe(0);
            expect(result.errors).toEqual(["No country found for SalesChannel"]);
            expect(mockApi.getCallsByEndpoint("_action/sync")).toHaveLength(0);
        });

        test("returns error when no payment method found", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.mockSearchResponse("sales-channel", [
                { id: "sc-123", customerGroupId: "g", countryId: "c" },
            ]);
            setupSalutationMock(mockApi);

            const result = await CustomerProcessor.process(context);

            expect(result.errors).toEqual(["No payment method found for SalesChannel"]);
            expect(mockApi.getCallsByEndpoint("_action/sync")).toHaveLength(0);
        });

        test("reports customers whose salutation is missing and creates the rest", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.mockSyncSuccess();
            setupSalesChannelMock(mockApi);
            mockApi.mockSearchResponse("salutation", [{ id: "sal-mr", salutationKey: "mr" }]);
            mockApi.mockFindByName("customer-group", B2B_CUSTOMER_GROUP.name, "b2b-id");
            mockApi.mockSearchResponse("customer", []);

            const result = await CustomerProcessor.process(context);

            const withMr = DEMO_CUSTOMERS.filter((c) => c.salutationKey === "mr").length;
            expect(result.processed).toBe(withMr);
            expect(result.skipped).toBe(0);
            expect(result.errors).toEqual(
                DEMO_CUSTOMERS.filter((c) => c.salutationKey === "mrs").map(
                    () => 'No salutation found for key "mrs"'
                )
            );
        });

        test("reports a failing customer sync", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.mockSyncFailure(new Error("sync broke"));
            setupSalesChannelMock(mockApi);
            setupSalutationMock(mockApi);
            mockApi.mockFindByName("customer-group", B2B_CUSTOMER_GROUP.name, "b2b-id");
            mockApi.mockSearchResponse("customer", []);

            const result = await CustomerProcessor.process(context);

            expect(result.processed).toBe(0);
            expect(result.errors).toEqual(["Customer creation failed: sync broke"]);
        });

        test("does not sync when every customer already exists", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.mockSyncSuccess();
            setupSalesChannelMock(mockApi);
            setupSalutationMock(mockApi);
            mockApi.mockFindByName("customer-group", B2B_CUSTOMER_GROUP.name, "b2b-id");
            mockApi.mockSearchResponse(
                "customer",
                DEMO_CUSTOMERS.map((c) => ({
                    id: `id-${c.email}`,
                    email: c.email,
                    accountType: "business",
                }))
            );

            const result = await CustomerProcessor.process(context);

            expect(result.errors).toEqual([]);
            expect(mockApi.getCallsByEndpoint("_action/sync")).toHaveLength(0);
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

        test("looks up existing customers across all SalesChannels", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.mockSyncSuccess();
            setupSalesChannelMock(mockApi);
            setupSalutationMock(mockApi);
            mockApi.mockFindByName("customer-group", B2B_CUSTOMER_GROUP.name, "b2b-id");

            await CustomerProcessor.process(context);

            // Shopware enforces unique emails globally, so a SalesChannel filter
            // would miss customers created for another store and fail the sync.
            const lookup = mockApi
                .getCallsByEndpoint("search/customer")
                .map((call) => JSON.stringify(call.body))
                .find((body) => body.includes("equalsAny"));
            expect(lookup).toBeDefined();
            expect(lookup).not.toContain("salesChannelId");
        });

        test("ignores guest accounts and does not cap the lookup at one row per email", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.mockSyncSuccess();
            setupSalesChannelMock(mockApi);
            setupSalutationMock(mockApi);
            mockApi.mockFindByName("customer-group", B2B_CUSTOMER_GROUP.name, "b2b-id");

            await CustomerProcessor.process(context);

            // A guest and a registered account can share an email. With a limit of
            // one row per demo email, the duplicate pushed another email out.
            const lookup = mockApi
                .getCallsByEndpoint("search/customer")
                .map((call) => JSON.stringify(call.body))
                .find((body) => body.includes("equalsAny"));
            expect(lookup).toContain('"field":"guest"');
            expect(lookup).not.toContain(`"limit":${DEMO_CUSTOMERS.length}`);
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
            expect(b2bCustomer!.accountType).toBe("business");
            expect(b2bCustomer!.company).toBe("Schmidt Industrial GmbH");
            expect(b2bCustomer!.vatIds).toEqual(["DE123456789"]);
            const b2bAddresses = b2bCustomer!.addresses as Array<Record<string, unknown>>;
            expect(b2bAddresses[0]?.company).toBe("Schmidt Industrial GmbH");

            expect(defaultCustomer!.accountType).toBeUndefined();
            const defaultAddresses = defaultCustomer!.addresses as Array<Record<string, unknown>>;
            expect(defaultAddresses[0]?.company).toBeUndefined();
        });

        test("turns existing private demo customers with a company into business accounts", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.mockSyncSuccess();
            setupSalesChannelMock(mockApi);
            setupSalutationMock(mockApi);
            mockApi.mockFindByName("customer-group", B2B_CUSTOMER_GROUP.name, "b2b-id");
            mockApi.mockSearchResponse(
                "customer",
                DEMO_CUSTOMERS.map((c) => ({
                    id: `id-${c.email}`,
                    email: c.email,
                    accountType: "private",
                    defaultBillingAddressId: `addr-${c.email}`,
                }))
            );

            const result = await CustomerProcessor.process(context);

            const upgradeSync = mockApi.getCallsByEndpoint("_action/sync").find((c) => {
                const body = c.body as Record<string, unknown>;
                return "upgrade-business-customers" in body;
            });
            const body = upgradeSync?.body as
                | Record<string, { payload: Array<Record<string, unknown>> }>
                | undefined;
            const businessCustomers = DEMO_CUSTOMERS.filter((c) => c.company);
            expect(businessCustomers.length).toBeGreaterThan(0);
            expect(body?.["upgrade-business-customers"]?.payload).toEqual(
                businessCustomers.map((c) => ({
                    id: `id-${c.email}`,
                    accountType: "business",
                    company: c.company,
                    vatIds: c.vatId ? [c.vatId] : [],
                    addresses: [{ id: `addr-${c.email}`, company: c.company }],
                }))
            );
            expect(result.errors).toEqual([]);
            expect(result.skipped).toBe(DEMO_CUSTOMERS.length);
        });

        test("sends no update when existing demo customers are already business accounts", async () => {
            const { context, mockApi } = createTestContext();
            mockApi.mockSyncSuccess();
            setupSalesChannelMock(mockApi);
            setupSalutationMock(mockApi);
            mockApi.mockFindByName("customer-group", B2B_CUSTOMER_GROUP.name, "b2b-id");
            mockApi.mockSearchResponse(
                "customer",
                DEMO_CUSTOMERS.map((c) => ({
                    id: `id-${c.email}`,
                    email: c.email,
                    accountType: c.company ? "business" : "private",
                }))
            );

            await CustomerProcessor.process(context);

            const upgradeSync = mockApi.getCallsByEndpoint("_action/sync").find((c) => {
                const body = c.body as Record<string, unknown>;
                return "upgrade-business-customers" in body;
            });
            expect(upgradeSync).toBeUndefined();
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

describe("buildBusinessAccountFields", () => {
    test("returns business fields for customers with a company", () => {
        expect(
            buildBusinessAccountFields({
                ...DEMO_CUSTOMERS[0]!,
                company: "ACME",
                vatId: "DE1",
            })
        ).toEqual({ accountType: "business", company: "ACME", vatIds: ["DE1"] });
    });

    test("sends an empty VAT ID list when a company has no VAT ID", () => {
        expect(
            buildBusinessAccountFields({ ...DEMO_CUSTOMERS[0]!, company: "ACME" }).vatIds
        ).toEqual([]);
    });

    test("returns nothing for private customers", () => {
        expect(buildBusinessAccountFields({ ...DEMO_CUSTOMERS[0]!, company: undefined })).toEqual(
            {}
        );
    });

    test("every B2B demo customer is a business account", () => {
        const b2b = DEMO_CUSTOMERS.filter((c) => c.group === "b2b");
        expect(b2b.length).toBeGreaterThan(0);
        expect(b2b.every((c) => c.company && c.vatId)).toBe(true);
    });
});

describe("buildBusinessAccountUpgrades", () => {
    test("skips customers without a company and customers that do not exist yet", () => {
        const upgrades = buildBusinessAccountUpgrades(
            new Map([
                [
                    "customer@example.com",
                    { id: "c-1", email: "customer@example.com", accountType: "private" },
                ],
            ])
        );
        expect(upgrades).toEqual([]);
    });

    test("leaves the address out when the default billing address is unknown", () => {
        const upgrades = buildBusinessAccountUpgrades(
            new Map([["b2b@example.com", { id: "c-2", email: "b2b@example.com" }]])
        );
        expect(upgrades).toHaveLength(1);
        expect(upgrades[0]?.payload.addresses).toBeUndefined();
        expect(upgrades[0]?.payload.accountType).toBe("business");
    });
});

describe("buildCustomerPayload", () => {
    const refs = {
        salesChannelId: "sc-1",
        groupId: "group-1",
        paymentMethodId: "pay-1",
        languageId: "lang-1",
        salutationId: "sal-1",
        countryId: "country-1",
    };

    test("builds a private customer with one default address", () => {
        const customer = {
            email: "max.power@example.com",
            firstName: "Max",
            lastName: "Power",
            group: "default" as const,
            salutationKey: "mr" as const,
            address: { street: "Main 1", zipcode: "12345", city: "Town" },
        };
        const payload = buildCustomerPayload(customer, refs);
        const address = payload.addresses[0];

        expect(payload).toMatchObject({
            customerNumber: "DEMO-MAX.POWER",
            salesChannelId: "sc-1",
            groupId: "group-1",
            defaultPaymentMethodId: "pay-1",
            languageId: "lang-1",
            email: "max.power@example.com",
            firstName: "Max",
            lastName: "Power",
            salutationId: "sal-1",
            password: DEMO_PASSWORD,
        });
        expect(payload.accountType).toBeUndefined();
        expect(payload.addresses).toHaveLength(1);
        expect(payload.defaultBillingAddressId).toBe(address?.id ?? "missing-address");
        expect(payload.defaultShippingAddressId).toBe(address?.id ?? "missing-address");
        expect(payload.id).not.toBe(address?.id ?? "missing-address");
        expect(address).toEqual({
            id: payload.defaultBillingAddressId,
            customerId: payload.id,
            salutationId: "sal-1",
            firstName: "Max",
            lastName: "Power",
            street: "Main 1",
            zipcode: "12345",
            city: "Town",
            countryId: "country-1",
        });
    });

    test("adds company to the account and the address of a business customer", () => {
        const b2b = DEMO_CUSTOMERS.find((c) => c.company)!;
        const payload = buildCustomerPayload(b2b, refs);

        expect(payload.accountType).toBe("business");
        expect(payload.company).toBe(b2b.company);
        expect(payload.addresses[0]?.company).toBe(b2b.company);
    });
});
