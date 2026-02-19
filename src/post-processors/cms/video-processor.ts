/**
 * Video Elements Processor - Creates the Video demo page
 */

import { VIDEO_ELEMENTS_PAGE } from "../../fixtures/index.js";
import { BaseCmsProcessor } from "./base-processor.js";

class VideoProcessorImpl extends BaseCmsProcessor {
    readonly name = "cms-video";
    readonly description = "Create Video Elements demo page (youtube, vimeo)";
    readonly pageFixture = VIDEO_ELEMENTS_PAGE;
}

export const VideoProcessor = new VideoProcessorImpl();
