/**
 * Customer Processor - Creates demo customer accounts and B2B customer group
 *
 * Creates pre-defined customer accounts so testers can log in immediately
 * without manual registration. Includes a B2B customer group with net pricing
 * to demonstrate Shopware's customer group feature.
 *
 * Credentials are also displayed on the homepage (via home-processor.ts).
 */

import type { CustomerSyncPayload } from "../types/index.js";
import type {
    PostProcessor,
    PostProcessorCleanupResult,
    PostProcessorContext,
    PostProcessorResult,
} from "./index.js";

import { B2B_CUSTOMER_GROUP, DEMO_CUSTOMERS, DEMO_PASSWORD } from "../fixtures/demo-customers.js";
import { generateUUID, logger } from "../utils/index.js";

class CustomerProcessorImpl implements PostProcessor {
    readonly name = "customers";
    readonly description = "Create demo customer accounts with B2B customer group";
    readonly dependsOn: string[] = [];

    async process(context: PostProcessorContext): Promise<PostProcessorResult> {
        const { options, salesChannelId } = context;
        const errors: string[] = [];
        let processed = 0;
        let skipped = 0;

        if (options.dryRun) {
            logger.info(
                `    [DRY RUN] Would create ${DEMO_CUSTOMERS.length} demo customers and B2B group`,
                { cli: true }
            );
            return {
                name: this.name,
                processed: DEMO_CUSTOMERS.length,
                skipped: 0,
                errors: [],
                durationMs: 0,
            };
        }

        if (!context.api) {
            errors.push("API helpers not available");
            return { name: this.name, processed: 0, skipped: 0, errors, durationMs: 0 };
        }

        try {
            // Resolve required reference IDs in parallel
            const [salutations, defaultGroupId, countryId, paymentMethodId] = await Promise.all([
                this.getSalutationIds(context),
                this.getDefaultCustomerGroupId(context),
                this.getCountryId(context),
                this.getDefaultPaymentMethodId(context),
            ]);

            if (!defaultGroupId) {
                errors.push("No default customer group found");
                return { name: this.name, processed: 0, skipped: 0, errors, durationMs: 0 };
            }

            if (!countryId) {
                errors.push("No country found for SalesChannel");
                return { name: this.name, processed: 0, skipped: 0, errors, durationMs: 0 };
            }

            if (!paymentMethodId) {
                errors.push("No payment method found for SalesChannel");
                return { name: this.name, processed: 0, skipped: 0, errors, durationMs: 0 };
            }

            // Create B2B customer group (idempotent)
            const b2bGroupId = await this.getOrCreateB2bGroup(context);

            // Find existing customers to support idempotency
            const existingEmails = await this.findExistingCustomerEmails(context);

            // Build customer payloads
            const customerPayloads: CustomerSyncPayload[] = [];

            for (const customer of DEMO_CUSTOMERS) {
                if (existingEmails.has(customer.email)) {
                    logger.info(`    ⊘ Customer "${customer.email}" already exists`, { cli: true });
                    skipped++;
                    continue;
                }

                const groupId = customer.group === "b2b" ? b2bGroupId : defaultGroupId;
                const salutationId = salutations.get(customer.salutationKey);

                if (!salutationId) {
                    errors.push(`No salutation found for key "${customer.salutationKey}"`);
                    continue;
                }

                const customerId = generateUUID();
                const billingAddressId = generateUUID();

                customerPayloads.push({
                    id: customerId,
                    customerNumber: `DEMO-${customer.email.split("@")[0]?.toUpperCase() ?? "UNKNOWN"}`,
                    salesChannelId,
                    groupId,
                    defaultPaymentMethodId: paymentMethodId,
                    languageId: await this.getLanguageId(context),
                    email: customer.email,
                    firstName: customer.firstName,
                    lastName: customer.lastName,
                    salutationId,
                    password: DEMO_PASSWORD,
                    defaultBillingAddressId: billingAddressId,
                    defaultShippingAddressId: billingAddressId,
                    addresses: [
                        {
                            id: billingAddressId,
                            customerId,
                            salutationId,
                            firstName: customer.firstName,
                            lastName: customer.lastName,
                            street: customer.address.street,
                            zipcode: customer.address.zipcode,
                            city: customer.address.city,
                            countryId,
                        },
                    ],
                });
            }

            if (customerPayloads.length > 0) {
                await context.api.syncEntities({
                    "create-customers": {
                        entity: "customer",
                        action: "upsert",
                        payload: customerPayloads,
                    },
                });
                processed = customerPayloads.length;
                logger.info(`    ✓ Created ${processed} demo customer accounts`, { cli: true });
            }
        } catch (error) {
            errors.push(
                `Customer creation failed: ${error instanceof Error ? error.message : String(error)}`
            );
        }

        return { name: this.name, processed, skipped, errors, durationMs: 0 };
    }

    async cleanup(context: PostProcessorContext): Promise<PostProcessorCleanupResult> {
        const errors: string[] = [];
        let deleted = 0;

        if (context.options.dryRun) {
            logger.info("    [DRY RUN] Would delete demo customer accounts and B2B group", {
                cli: true,
            });
            return { name: this.name, deleted: 0, errors: [], durationMs: 0 };
        }

        if (!context.api) {
            errors.push("API helpers not available - cannot perform cleanup");
            return { name: this.name, deleted: 0, errors, durationMs: 0 };
        }

        try {
            // Find and delete demo customers by email
            const emails = DEMO_CUSTOMERS.map((c) => c.email);
            const customers = await context.api.searchEntities<{ id: string; email: string }>(
                "customer",
                [
                    {
                        type: "equalsAny",
                        field: "email",
                        value: emails,
                    },
                    {
                        type: "equals",
                        field: "salesChannelId",
                        value: context.salesChannelId,
                    },
                ],
                { limit: emails.length }
            );

            if (customers.length > 0) {
                const customerIds = customers.map((c) => c.id);
                await context.api.deleteEntities("customer", customerIds);
                deleted += customerIds.length;
                logger.info(`    ✓ Deleted ${customerIds.length} demo customers`, { cli: true });
            }

            // Delete B2B customer group if no customers remain in it
            const b2bGroupId = await context.api.findByName(
                "customer-group",
                B2B_CUSTOMER_GROUP.name
            );

            if (b2bGroupId) {
                const remainingB2b = await context.api.searchEntities<{ id: string }>(
                    "customer",
                    [{ type: "equals", field: "groupId", value: b2bGroupId }],
                    { limit: 1 }
                );

                if (remainingB2b.length === 0) {
                    await context.api.deleteEntities("customer_group", [b2bGroupId]);
                    deleted++;
                    logger.info(`    ✓ Deleted B2B customer group (no remaining customers)`, {
                        cli: true,
                    });
                } else {
                    logger.info(
                        `    ⊘ Keeping B2B group (still has customers in other SalesChannels)`,
                        { cli: true }
                    );
                }
            }
        } catch (error) {
            errors.push(
                `Customer cleanup failed: ${error instanceof Error ? error.message : String(error)}`
            );
        }

        return { name: this.name, deleted, errors, durationMs: 0 };
    }

    private async getSalutationIds(context: PostProcessorContext): Promise<Map<string, string>> {
        const map = new Map<string, string>();
        if (!context.api) return map;

        const salutations = await context.api.searchEntities<{
            id: string;
            salutationKey: string;
        }>("salutation", [], {
            limit: 10,
            includes: { salutation: ["id", "salutationKey"] },
        });

        for (const s of salutations) {
            map.set(s.salutationKey, s.id);
        }

        return map;
    }

    private async getDefaultCustomerGroupId(context: PostProcessorContext): Promise<string | null> {
        if (!context.api) return null;

        // Get the SalesChannel's customer group
        const salesChannels = await context.api.searchEntities<{
            id: string;
            customerGroupId: string;
        }>("sales-channel", [{ type: "equals", field: "id", value: context.salesChannelId }], {
            limit: 1,
            includes: { sales_channel: ["id", "customerGroupId"] },
        });

        return salesChannels[0]?.customerGroupId ?? null;
    }

    private async getCountryId(context: PostProcessorContext): Promise<string | null> {
        if (!context.api) return null;

        // Get the SalesChannel's default country
        const salesChannels = await context.api.searchEntities<{
            id: string;
            countryId: string;
        }>("sales-channel", [{ type: "equals", field: "id", value: context.salesChannelId }], {
            limit: 1,
            includes: { sales_channel: ["id", "countryId"] },
        });

        return salesChannels[0]?.countryId ?? null;
    }

    private async getDefaultPaymentMethodId(context: PostProcessorContext): Promise<string | null> {
        if (!context.api) return null;

        const salesChannels = await context.api.searchEntities<{
            id: string;
            paymentMethodId: string;
        }>("sales-channel", [{ type: "equals", field: "id", value: context.salesChannelId }], {
            limit: 1,
            includes: { sales_channel: ["id", "paymentMethodId"] },
        });

        return salesChannels[0]?.paymentMethodId ?? null;
    }

    private async getLanguageId(context: PostProcessorContext): Promise<string> {
        if (!context.api) return "";

        const salesChannels = await context.api.searchEntities<{
            id: string;
            languageId: string;
        }>("sales-channel", [{ type: "equals", field: "id", value: context.salesChannelId }], {
            limit: 1,
            includes: { sales_channel: ["id", "languageId"] },
        });

        return salesChannels[0]?.languageId ?? "";
    }

    private async getOrCreateB2bGroup(context: PostProcessorContext): Promise<string> {
        if (!context.api) return "";

        // Check if B2B group already exists
        const existingId = await context.api.findByName("customer-group", B2B_CUSTOMER_GROUP.name);

        if (existingId) {
            logger.info(`    ⊘ B2B customer group already exists`, { cli: true });
            return existingId;
        }

        const groupId = generateUUID();
        await context.api.syncEntities({
            "create-b2b-group": {
                entity: "customer_group",
                action: "upsert",
                payload: [
                    {
                        id: groupId,
                        name: B2B_CUSTOMER_GROUP.name,
                        displayGross: B2B_CUSTOMER_GROUP.displayGross,
                        registrationActive: B2B_CUSTOMER_GROUP.registrationActive,
                    },
                ],
            },
        });

        logger.info(`    ✓ Created B2B customer group (net pricing)`, { cli: true });
        return groupId;
    }

    private async findExistingCustomerEmails(context: PostProcessorContext): Promise<Set<string>> {
        if (!context.api) return new Set();

        try {
            const emails = DEMO_CUSTOMERS.map((c) => c.email);
            const customers = await context.api.searchEntities<{ email: string }>(
                "customer",
                [
                    {
                        type: "equalsAny",
                        field: "email",
                        value: emails,
                    },
                    {
                        type: "equals",
                        field: "salesChannelId",
                        value: context.salesChannelId,
                    },
                ],
                { limit: emails.length, includes: { customer: ["id", "email"] } }
            );

            return new Set(customers.map((c) => c.email));
        } catch {
            return new Set();
        }
    }
}

/** Customer processor singleton */
export const CustomerProcessor = new CustomerProcessorImpl();
