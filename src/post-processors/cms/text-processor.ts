/**
 * Text Elements Processor - Creates the Text demo page
 */

import { TEXT_ELEMENTS_PAGE } from "../../fixtures/index.js";
import { BaseCmsProcessor } from "./base-processor.js";

class TextProcessorImpl extends BaseCmsProcessor {
    readonly name = "cms-text";
    readonly description = "Create Text Elements demo page (text, hero, teaser, two-column, html)";
    readonly pageFixture = TEXT_ELEMENTS_PAGE;
}

export const TextProcessor = new TextProcessorImpl();
