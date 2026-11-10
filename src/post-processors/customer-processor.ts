/**
 * Customer Processor - Creates demo customer accounts and B2B customer group
 *
 * Creates pre-defined customer accounts so testers can log in immediately
 * without manual registration. Includes a B2B customer group with net pricing
 * to demonstrate Shopware's customer group feature.
 *
 * Credentials are also displayed on the homepage (via home-processor.ts).
 */

import type { DemoCustomer } from "../fixtures/demo-customers.js";
import type { CustomerSyncPayload } from "../types/index.js";
import type {
    PostProcessor,
    PostProcessorCleanupResult,
    PostProcessorContext,
    PostProcessorResult,
} from "./index.js";

import { B2B_CUSTOMER_GROUP, DEMO_CUSTOMERS, DEMO_PASSWORD } from "../fixtures/demo-customers.js";
import { generateUUID, logger } from "../utils/index.js";
import { errorMessage } from "./processor-utils.js";

/** Reference IDs every demo customer needs */
interface CustomerReferences {
    salutations: Map<string, string>;
    defaultGroupId: string;
    countryId: string;
    paymentMethodId: string;
}

/** IDs of one new demo customer's relations */
export interface CustomerPayloadRefs {
    salesChannelId: string;
    groupId: string;
    paymentMethodId: string;
    languageId: string;
    salutationId: string;
    countryId: string;
}

interface CustomerTally {
    processed: number;
    skipped: number;
    errors: string[];
}

/** Sync payload for a new demo customer with its default billing/shipping address */
export function buildCustomerPayload(
    customer: DemoCustomer,
    refs: CustomerPayloadRefs
): CustomerSyncPayload {
    const customerId = generateUUID();
    const billingAddressId = generateUUID();

    return {
        id: customerId,
        customerNumber: `DEMO-${customer.email.split("@")[0]?.toUpperCase() ?? "UNKNOWN"}`,
        salesChannelId: refs.salesChannelId,
        groupId: refs.groupId,
        defaultPaymentMethodId: refs.paymentMethodId,
        languageId: refs.languageId,
        email: customer.email,
        ...buildBusinessAccountFields(customer),
        firstName: customer.firstName,
        lastName: customer.lastName,
        salutationId: refs.salutationId,
        password: DEMO_PASSWORD,
        defaultBillingAddressId: billingAddressId,
        defaultShippingAddressId: billingAddressId,
        addresses: [
            {
                id: billingAddressId,
                customerId,
                salutationId: refs.salutationId,
                firstName: customer.firstName,
                lastName: customer.lastName,
                ...(customer.company && { company: customer.company }),
                street: customer.address.street,
                zipcode: customer.address.zipcode,
                city: customer.address.city,
                countryId: refs.countryId,
            },
        ],
    };
}

class CustomerProcessorImpl implements PostProcessor {
    readonly name = "customers";
    readonly description = "Create demo customer accounts with B2B customer group";
    readonly dependsOn: string[] = [];

    async process(context: PostProcessorContext): Promise<PostProcessorResult> {
        const errors: string[] = [];

        if (context.options.dryRun) {
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

        const tally: CustomerTally = { processed: 0, skipped: 0, errors };
        try {
            await this.createDemoCustomers(context, tally);
        } catch (error) {
            errors.push(`Customer creation failed: ${errorMessage(error)}`);
        }

        return {
            name: this.name,
            processed: tally.processed,
            skipped: tally.skipped,
            errors,
            durationMs: 0,
        };
    }

    /** B2B group, new demo customers and business account upgrades */
    private async createDemoCustomers(
        context: PostProcessorContext,
        tally: CustomerTally
    ): Promise<void> {
        const refs = await this.resolveReferences(context);
        if (typeof refs === "string") {
            tally.errors.push(refs);
            return;
        }

        // Create B2B customer group (idempotent)
        const b2bGroupId = await this.getOrCreateB2bGroup(context);

        // Find existing customers to support idempotency
        const existingCustomers = await this.findExistingCustomers(context);

        const payloads = await this.buildNewCustomerPayloads(
            context,
            refs,
            b2bGroupId,
            existingCustomers,
            tally
        );

        await this.upgradeToBusinessAccounts(context, existingCustomers);
        await this.syncNewCustomers(context, payloads, tally);
    }

    /** Reference IDs every demo customer needs, or the error why they are missing */
    private async resolveReferences(
        context: PostProcessorContext
    ): Promise<CustomerReferences | string> {
        const [salutations, defaultGroupId, countryId, paymentMethodId] = await Promise.all([
            this.getSalutationIds(context),
            this.getDefaultCustomerGroupId(context),
            this.getCountryId(context),
            this.getDefaultPaymentMethodId(context),
        ]);

        if (!defaultGroupId) return "No default customer group found";
        if (!countryId) return "No country found for SalesChannel";
        if (!paymentMethodId) return "No payment method found for SalesChannel";
        return { salutations, defaultGroupId, countryId, paymentMethodId };
    }

    /** Payloads for demo customers that do not exist yet */
    private async buildNewCustomerPayloads(
        context: PostProcessorContext,
        refs: CustomerReferences,
        b2bGroupId: string,
        existingCustomers: Map<string, ExistingCustomer>,
        tally: CustomerTally
    ): Promise<CustomerSyncPayload[]> {
        const payloads: CustomerSyncPayload[] = [];

        for (const customer of DEMO_CUSTOMERS) {
            if (existingCustomers.has(customer.email)) {
                logger.info(`    ⊘ Customer "${customer.email}" already exists`, { cli: true });
                tally.skipped++;
                continue;
            }

            const salutationId = refs.salutations.get(customer.salutationKey);
            if (!salutationId) {
                tally.errors.push(`No salutation found for key "${customer.salutationKey}"`);
                continue;
            }

            payloads.push(
                buildCustomerPayload(customer, {
                    salesChannelId: context.salesChannelId,
                    groupId: customer.group === "b2b" ? b2bGroupId : refs.defaultGroupId,
                    paymentMethodId: refs.paymentMethodId,
                    languageId: await this.getLanguageId(context),
                    salutationId,
                    countryId: refs.countryId,
                })
            );
        }

        return payloads;
    }

    private async syncNewCustomers(
        context: PostProcessorContext,
        payloads: CustomerSyncPayload[],
        tally: CustomerTally
    ): Promise<void> {
        if (payloads.length === 0 || !context.api) return;

        await context.api.syncEntities({
            "create-customers": {
                entity: "customer",
                action: "upsert",
                payload: payloads,
            },
        });
        tally.processed = payloads.length;
        logger.info(`    ✓ Created ${tally.processed} demo customer accounts`, { cli: true });
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
            errors.push(`Customer cleanup failed: ${errorMessage(error)}`);
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

    /**
     * Turn existing demo customers with a company into business accounts.
     * Demo customers created before business accounts were added are private accounts,
     * and existing customers are otherwise skipped, so they would never get the company.
     */
    private async upgradeToBusinessAccounts(
        context: PostProcessorContext,
        existingCustomers: Map<string, ExistingCustomer>
    ): Promise<void> {
        const upgrades = buildBusinessAccountUpgrades(existingCustomers);
        if (upgrades.length === 0 || !context.api) return;

        await context.api.syncEntities({
            "upgrade-business-customers": {
                entity: "customer",
                action: "upsert",
                payload: upgrades.map((upgrade) => upgrade.payload),
            },
        });
        for (const upgrade of upgrades) {
            logger.info(`    ✓ Turned "${upgrade.email}" into a business account`, { cli: true });
        }
    }

    private async findExistingCustomers(
        context: PostProcessorContext
    ): Promise<Map<string, ExistingCustomer>> {
        if (!context.api) return new Map();

        try {
            // Shopware enforces unique customer emails across ALL SalesChannels
            // (unless "bind customers to SalesChannel" is enabled), so the lookup
            // must not be scoped to the current SalesChannel. Otherwise demo
            // customers created for another store cause "email already in use".
            const emails = DEMO_CUSTOMERS.map((c) => c.email);
            const customers = await context.api.searchEntities<ExistingCustomer>(
                "customer",
                [
                    {
                        type: "equalsAny",
                        field: "email",
                        value: emails,
                    },
                    // Guest accounts do not block email reuse, and they can share an
                    // email with a registered account. Counting them could push a
                    // registered demo email out of the result.
                    { type: "equals", field: "guest", value: false },
                ],
                {
                    includes: {
                        customer: ["id", "email", "accountType", "defaultBillingAddressId"],
                    },
                }
            );

            return new Map(customers.map((c) => [c.email, c]));
        } catch {
            return new Map();
        }
    }
}

/** Existing customer as returned by the demo customer lookup */
export interface ExistingCustomer {
    id: string;
    email: string;
    accountType?: string;
    defaultBillingAddressId?: string;
}

/** Partial customer update that turns a private account into a business account */
export interface BusinessAccountUpgrade {
    /** Email of the demo customer (for logging, not sent) */
    email: string;
    payload: {
        id: string;
        accountType: "business";
        company: string;
        vatIds: string[];
        addresses?: Array<{ id: string; company: string }>;
    };
}

/**
 * Updates for existing demo customers that should be business accounts but are not.
 * Customers that already are business accounts are left alone, so re-runs send nothing.
 * The company is also set on the default billing address, where orders read it from.
 */
export function buildBusinessAccountUpgrades(
    existingCustomers: Map<string, ExistingCustomer>
): BusinessAccountUpgrade[] {
    return DEMO_CUSTOMERS.flatMap((customer) => {
        const existing = existingCustomers.get(customer.email);
        if (!existing || !customer.company || existing.accountType === "business") return [];

        const addressId = existing.defaultBillingAddressId;
        const company = customer.company;
        return [
            {
                email: customer.email,
                payload: {
                    id: existing.id,
                    accountType: "business",
                    company,
                    vatIds: customer.vatId ? [customer.vatId] : [],
                    ...(addressId && { addresses: [{ id: addressId, company }] }),
                },
            },
        ];
    });
}

/** Customer processor singleton */
export const CustomerProcessor = new CustomerProcessorImpl();

/**
 * Business account fields for demo customers with a company.
 * Shopware then shows the company and VAT ID in the account and on orders.
 */
export function buildBusinessAccountFields(
    customer: DemoCustomer
): { accountType: "business"; company: string; vatIds: string[] } | Record<string, never> {
    if (!customer.company) return {};
    return {
        accountType: "business",
        company: customer.company,
        vatIds: customer.vatId ? [customer.vatId] : [],
    };
}
