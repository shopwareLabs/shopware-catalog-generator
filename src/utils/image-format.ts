/**
 * Image format detection from magic bytes (shared by media uploads and image providers)
 */

export interface ImageFormat {
    extension: string;
    mimeType: string;
}

interface ImageSignature {
    format: ImageFormat;
    /** Byte sequences that must all match, each at its own offset */
    parts: Array<{ offset: number; bytes: number[] }>;
}

const JPEG: ImageFormat = { extension: "jpg", mimeType: "image/jpeg" };

const IMAGE_SIGNATURES: ImageSignature[] = [
    { format: JPEG, parts: [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }] },
    {
        format: { extension: "png", mimeType: "image/png" },
        parts: [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47] }],
    },
    {
        format: { extension: "gif", mimeType: "image/gif" },
        parts: [{ offset: 0, bytes: [0x47, 0x49, 0x46] }],
    },
    {
        // "RIFF" container with "WEBP" form type
        format: { extension: "webp", mimeType: "image/webp" },
        parts: [
            { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
            { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
        ],
    },
];

function matchesSignature(buffer: Buffer, signature: ImageSignature): boolean {
    return signature.parts.every(({ offset, bytes }) =>
        bytes.every((byte, index) => buffer[offset + index] === byte)
    );
}

/**
 * Detect image format from magic bytes (falls back to JPEG)
 */
export function detectImageFormat(buffer: Buffer): ImageFormat {
    const signature = IMAGE_SIGNATURES.find((candidate) => matchesSignature(buffer, candidate));
    return { ...(signature?.format ?? JPEG) };
}
