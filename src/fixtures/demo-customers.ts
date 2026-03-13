/**
 * Demo Customer Fixtures - Pre-defined customer accounts for testing
 *
 * These customers are created by the customer post-processor
 * so testers can log in immediately without manual registration.
 * Credentials are also displayed on the homepage welcome text.
 */

/** Shared password for all demo accounts (Shopware hashes it on creation) */
export const DEMO_PASSWORD = "shopware";

/** Customer group assignment */
export type CustomerGroupKey = "default" | "b2b";

/** Demo customer definition */
export interface DemoCustomer {
    /** Login email */
    email: string;
    /** First name */
    firstName: string;
    /** Last name */
    lastName: string;
    /** Customer group key */
    group: CustomerGroupKey;
    /** Salutation key (mr/mrs) */
    salutationKey: "mr" | "mrs";
    /** Billing/shipping address */
    address: DemoAddress;
}

/** Demo address */
export interface DemoAddress {
    street: string;
    zipcode: string;
    city: string;
}

/** B2B customer group definition */
export const B2B_CUSTOMER_GROUP = {
    name: "B2B",
    displayGross: false,
    registrationActive: false,
} as const;

/** All demo customer accounts */
export const DEMO_CUSTOMERS: readonly DemoCustomer[] = [
    {
        email: "customer@example.com",
        firstName: "Max",
        lastName: "Mustermann",
        group: "default",
        salutationKey: "mr",
        address: { street: "Musterstraße 1", zipcode: "10115", city: "Berlin" },
    },
    {
        email: "b2b@example.com",
        firstName: "Anna",
        lastName: "Schmidt",
        group: "b2b",
        salutationKey: "mrs",
        address: { street: "Industrieweg 42", zipcode: "80331", city: "Munich" },
    },
    {
        email: "jane@example.com",
        firstName: "Jane",
        lastName: "Doe",
        group: "default",
        salutationKey: "mrs",
        address: { street: "123 Main Street", zipcode: "90210", city: "Los Angeles" },
    },
    {
        email: "b2b-buyer@example.com",
        firstName: "Tom",
        lastName: "Business",
        group: "b2b",
        salutationKey: "mr",
        address: { street: "Commerce Blvd 7", zipcode: "60311", city: "Frankfurt" },
    },
];
