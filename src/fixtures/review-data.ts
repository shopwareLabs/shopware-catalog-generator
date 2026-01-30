/**
 * Review Data Fixtures - Names and templates for review generation
 */

import type { ReviewerNames, ReviewTemplates } from "./types.js";

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

/**
 * Get a random review content template for a rating
 * @param rating - Star rating (1-5)
 * @param productType - Product type name to insert
 */
export function getReviewContent(rating: number, productType: string): string {
    let templates: readonly string[];

    if (rating >= 4) {
        templates = REVIEW_CONTENT_TEMPLATES.positive;
    } else if (rating === 3) {
        templates = REVIEW_CONTENT_TEMPLATES.neutral;
    } else {
        templates = REVIEW_CONTENT_TEMPLATES.negative;
    }

    const template = templates[Math.floor(Math.random() * templates.length)] || templates[0];
    return (template as string).replace("{productType}", productType);
}
