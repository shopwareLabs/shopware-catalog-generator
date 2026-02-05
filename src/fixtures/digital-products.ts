/**
 * Digital Product Fixtures - Pre-defined digital products
 *
 * These fixtures contain all content for digital products.
 * Content is pre-generated (not AI at runtime) to keep processing fast.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Gift Card €50 - Universal digital product for all stores */
export const GIFT_CARD_50 = {
    productNumber: "GIFT-CARD-50",
    name: "Digital Gift Card €50",
    /** Path to the pre-generated product image */
    imagePath: path.join(__dirname, "digital-products", "gift-card-50.png"),
    description: `<div class="gift-card-description">
<h2>The Perfect Gift for Any Occasion</h2>
<p>Can't decide what to get? Our Digital Gift Card is the ideal solution! Give the gift of choice and let your loved ones pick exactly what they want from our entire collection.</p>

<h3>How It Works</h3>
<ol>
<li><strong>Purchase</strong> - Complete your order and receive instant confirmation</li>
<li><strong>Download</strong> - Get your personalized voucher PDF immediately</li>
<li><strong>Gift</strong> - Share the voucher code with your recipient</li>
<li><strong>Redeem</strong> - They enter the code at checkout to apply the €50 credit</li>
</ol>

<h3>Gift Card Benefits</h3>
<ul>
<li>Instant digital delivery - no waiting for shipping</li>
<li>Valid for 12 months from purchase date</li>
<li>Redeemable on any product in our store</li>
<li>Can be combined with other payment methods</li>
<li>Beautifully designed voucher PDF included</li>
</ul>

<p><em>Note: This is a digital product. After purchase, you will receive a downloadable voucher containing your unique gift card code.</em></p>
</div>`,
    price: 50.0,
    /** Voucher template content (text format for simple generation) */
    voucherTemplate: `
════════════════════════════════════════════════════════════════════════
                         DIGITAL GIFT CARD
════════════════════════════════════════════════════════════════════════

                             €50.00

                    Thank you for your purchase!

    ┌─────────────────────────────────────────────────────────────────┐
    │                                                                 │
    │   This voucher can be redeemed for any products in our store   │
    │   within 12 months of purchase.                                 │
    │                                                                 │
    │   VOUCHER CODE: {{CODE}}                                        │
    │                                                                 │
    │   To redeem, enter this code at checkout.                      │
    │                                                                 │
    └─────────────────────────────────────────────────────────────────┘

    Terms & Conditions:
    • Valid for 12 months from issue date
    • Not redeemable for cash
    • Can be combined with other payment methods
    • One code per order

════════════════════════════════════════════════════════════════════════
                    Generated: {{DATE}}
════════════════════════════════════════════════════════════════════════
`,
};

/** Future: Additional gift card denominations can be added here */
// export const GIFT_CARD_25 = { ... };
// export const GIFT_CARD_100 = { ... };
