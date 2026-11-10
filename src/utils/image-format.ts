/**
 * Image format detection from magic bytes (shared by media uploads and image providers)
 */

export interface ImageFormat {
    extension: string;
    mimeType: string;
}

/**
 * Detect image format from magic bytes
 */
export function detectImageFormat(buffer: Buffer): ImageFormat {
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return { extension: "jpg", mimeType: "image/jpeg" };
    }
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
        return { extension: "png", mimeType: "image/png" };
    }
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
        return { extension: "gif", mimeType: "image/gif" };
    }
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
        if (
            buffer[8] === 0x57 &&
            buffer[9] === 0x45 &&
            buffer[10] === 0x42 &&
            buffer[11] === 0x50
        ) {
            return { extension: "webp", mimeType: "image/webp" };
        }
    }
    return { extension: "jpg", mimeType: "image/jpeg" };
}
