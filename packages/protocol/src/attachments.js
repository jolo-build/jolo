// Browser-safe limits; importing these never loads the wire schema runtime.
export const IMAGE_LIMITS = Object.freeze({
  imageAttachmentBytes: 5 * 1024 * 1024,
  imageAttachments: 4,
  attachmentChunkBytes: 64 * 1024,
});
export const IMAGE_MIME_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
