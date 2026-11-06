/**
 * Review Data Fixtures - Names and templates for review generation
 */

import type { GeneratedReview, ReviewerNames, ReviewTemplates } from "./types.js";

import { createSeededRandom, seededPick } from "../utils/seeded-random.js";

// =============================================================================
// Reviewer Names
// =============================================================================

/**
 * Common first and last names for generating fake reviewers
 */
export const REVIEWER_NAMES: ReviewerNames = {
    firstNames: [
        "Emma",
        "Liam",
        "Olivia",
        "Noah",
        "Ava",
        "Oliver",
        "Isabella",
        "Elijah",
        "Sophia",
        "Lucas",
        "Mia",
        "Mason",
        "Charlotte",
        "Logan",
        "Amelia",
        "Alexander",
        "Harper",
        "Ethan",
        "Evelyn",
        "Jacob",
        "Anna",
        "Michael",
        "Lisa",
        "James",
        "Maria",
        "Benjamin",
        "Julia",
        "Daniel",
        "Sarah",
        "Henry",
        "Laura",
        "Sebastian",
    ],
    lastNames: [
        "Smith",
        "Johnson",
        "Williams",
        "Brown",
        "Jones",
        "Garcia",
        "Miller",
        "Davis",
        "Rodriguez",
        "Martinez",
        "Hernandez",
        "Lopez",
        "Gonzalez",
        "Wilson",
        "Anderson",
        "Thomas",
        "Taylor",
        "Moore",
        "Jackson",
        "Martin",
        "Lee",
        "Perez",
        "Thompson",
        "White",
        "Harris",
        "Sanchez",
        "Clark",
        "Ramirez",
        "Lewis",
        "Robinson",
        "Walker",
    ],
} as const;

// =============================================================================
// Review Title Templates
// =============================================================================

/**
 * Review title templates organized by sentiment
 */
export const REVIEW_TEMPLATES: ReviewTemplates = {
    positiveTitles: [
        "Great quality!",
        "Exceeded my expectations",
        "Highly recommend",
        "Love it!",
        "Perfect for my needs",
        "Excellent product",
        "Very satisfied",
        "Best purchase I've made",
        "Outstanding quality",
        "Would buy again",
    ],
    neutralTitles: [
        "Good product",
        "As expected",
        "Decent quality",
        "Works as described",
        "Okay for the price",
        "Not bad",
        "Does the job",
    ],
    negativeTitles: [
        "Disappointed",
        "Not as expected",
        "Could be better",
        "Average quality",
        "Room for improvement",
    ],
} as const;

// =============================================================================
// Review Content Templates
// =============================================================================

/**
 * Review content templates by rating category
 */
export const REVIEW_CONTENT_TEMPLATES = {
    positive: [
        "This {productType} is exactly what I was looking for. The quality is excellent and it arrived quickly. Highly recommend!",
        "I'm very happy with my purchase. The {productType} looks even better in person than in the photos. Great value for money.",
        "Outstanding quality! The {productType} exceeded my expectations. Will definitely be ordering more products.",
        "Love this {productType}! It's well-made and the design is beautiful. Perfect addition to my home.",
        "Excellent product. The {productType} is sturdy, well-designed, and exactly as described. Very satisfied.",
    ],
    neutral: [
        "The {productType} is okay. It works as expected but nothing special. Decent for the price.",
        "Good quality overall. The {productType} does what it's supposed to do. No complaints.",
        "Average product. The {productType} is functional but I expected a bit more for the price.",
    ],
    negative: [
        "The {productType} didn't meet my expectations. The quality could be better for this price point.",
        "Disappointed with this purchase. The {productType} looks different from the photos.",
        "Not as good as I hoped. The {productType} is okay but there are better options out there.",
    ],
} as const;

/** Rating weights: 5 stars 40%, 4 stars 30%, 3 stars 15%, 2 stars 10%, 1 star 5% */
const RATING_THRESHOLDS: ReadonlyArray<{ below: number; rating: number }> = [
    { below: 0.4, rating: 5 },
    { below: 0.7, rating: 4 },
    { below: 0.85, rating: 3 },
    { below: 0.95, rating: 2 },
];

function pickRating(roll: number): number {
    return RATING_THRESHOLDS.find((t) => roll < t.below)?.rating ?? 1;
}

function sentimentOf(rating: number): "positive" | "neutral" | "negative" {
    if (rating >= 4) return "positive";
    if (rating === 3) return "neutral";
    return "negative";
}

const TITLES_BY_SENTIMENT = {
    positive: REVIEW_TEMPLATES.positiveTitles,
    neutral: REVIEW_TEMPLATES.neutralTitles,
    negative: REVIEW_TEMPLATES.negativeTitles,
} as const;

/**
 * Build the English reviews for a product.
 *
 * Deterministic: the same product always gets the same reviewers, ratings and texts.
 * The translate pass (Phase 2) and the review processor (Phase 3) both call this, so
 * translated review texts line up with the uploaded reviews by index.
 *
 * @param productId - Seed for all choices
 * @param productName - Used in the review text ("{productType}")
 * @param count - Number of reviews
 */
export function buildProductReviews(
    productId: string,
    productName: string,
    count: number
): GeneratedReview[] {
    const random = createSeededRandom(`reviews:${productId}`);
    const productType = productName.split(" - ")[0] || productName;

    return Array.from({ length: Math.max(0, count) }, () => {
        const rating = pickRating(random());
        const sentiment = sentimentOf(rating);
        const firstName = seededPick(REVIEWER_NAMES.firstNames, random);
        const lastName = seededPick(REVIEWER_NAMES.lastNames, random);
        const title = seededPick(TITLES_BY_SENTIMENT[sentiment], random);
        const template = seededPick(REVIEW_CONTENT_TEMPLATES[sentiment], random);

        return {
            user: `${firstName} ${lastName}`,
            email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.com`,
            title,
            content: template.replace("{productType}", productType),
            rating,
        };
    });
}
