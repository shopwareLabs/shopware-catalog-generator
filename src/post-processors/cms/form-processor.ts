/**
 * Form Elements Processor - Creates the Form demo page
 */

import { FORM_ELEMENTS_PAGE } from "../../fixtures/index.js";
import { BaseCmsProcessor } from "./base-processor.js";

class FormProcessorImpl extends BaseCmsProcessor {
    readonly name = "cms-form";
    readonly description = "Create Form Elements demo page (contact form, newsletter)";
    readonly pageFixture = FORM_ELEMENTS_PAGE;
}

export const FormProcessor = new FormProcessorImpl();
