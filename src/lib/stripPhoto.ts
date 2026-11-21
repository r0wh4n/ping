// Photos carry whatever the camera wrote into them, GPS location included.
// Drawing the pixels onto a canvas and encoding them again keeps the picture and
// drops all of that metadata. Browsers apply the EXIF rotation when they decode,
// so the copy comes out upright without needing the tag.
// ponytail: re-encodes (JPEG and WEBP at quality 0.92) instead of editing the
// EXIF bytes in place; a byte-level edit would be lossless but loses rotation.
// GIFs pass through: redrawing would flatten the animation, and GIF carries no
// camera metadata.
const KEEP_TYPE = new Set(["image/jpeg", "image/png", "image/webp"]);
// iOS Safari won't draw a canvas past about 16.7 million pixels. Anything larger
// is scaled to fit, still well beyond what a chat ever shows.
const MAX_PIXELS = 16_000_000;

export async function stripPhotoMetadata(file: File): Promise<File> {
  if (file.type === "image/gif") return file;
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (img.naturalWidth * img.naturalHeight)));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No canvas.");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    // Anything else (HEIC from a Mac, say) becomes a JPEG.
    const want = KEEP_TYPE.has(file.type) ? file.type : "image/jpeg";
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, want, 0.92));
    if (!blob) throw new Error("Couldn't encode the photo.");
    // A browser that can't write WEBP hands back a PNG; name it for what it is.
    return new File([blob], file.name, { type: blob.type || want, lastModified: Date.now() });
  } finally {
    URL.revokeObjectURL(url);
  }
}
