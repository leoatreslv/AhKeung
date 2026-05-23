// Browser-side resize for trainer-uploaded exercise photos. Phone cameras
// emit ~5MB JPEGs at 4000×3000; library photos can be even larger. We
// rescale to a long-edge cap and iterate JPEG quality until the encoded
// blob fits under a size cap, so uploads stay fast and the bucket-level
// 2 MB Storage limit can never reject a resized image.

export interface ResizeOptions {
  maxEdge?: number;       // long-edge pixel cap, default 1024
  maxBytes?: number;      // target encoded size, default 500 KB
  quality?: number;       // 0..1, starting JPEG quality, default 0.85
  minQuality?: number;    // 0..1, floor for the quality search, default 0.55
  mimeType?: string;      // default 'image/jpeg'
}

export async function resizeImage(file: Blob, opts: ResizeOptions = {}): Promise<Blob> {
  const maxEdge    = opts.maxEdge    ?? 1024;
  const maxBytes   = opts.maxBytes   ?? 500 * 1024;
  let   quality    = opts.quality    ?? 0.85;
  const minQuality = opts.minQuality ?? 0.55;
  const mimeType   = opts.mimeType   ?? 'image/jpeg';

  const img = await loadImage(file);
  // naturalWidth/naturalHeight are the decoded pixel dimensions. Plain
  // .width / .height read the layout dims, which are 0 on a brand-new
  // off-DOM Image — that produced the "library photo uploads at full
  // size" bug.
  const sourceW = img.naturalWidth || img.width;
  const sourceH = img.naturalHeight || img.height;
  if (!sourceW || !sourceH) throw new Error('image has no dimensions');

  const scale = Math.min(1, maxEdge / Math.max(sourceW, sourceH));
  const targetW = Math.max(1, Math.round(sourceW * scale));
  const targetH = Math.max(1, Math.round(sourceH * scale));

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas context unavailable');
  ctx.drawImage(img, 0, 0, targetW, targetH);

  // Iterate quality until the encoded blob fits, or quality floor hit.
  // Linear step of 0.1 is plenty — going from 0.85 → 0.55 is at most
  // four encodes, each ~50ms on a phone.
  let blob = await canvasToBlob(canvas, mimeType, quality);
  while (blob.size > maxBytes && quality > minQuality) {
    quality = Math.max(minQuality, quality - 0.1);
    blob = await canvasToBlob(canvas, mimeType, quality);
  }
  return blob;
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality: number): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob returned null'))),
      mimeType,
      quality,
    );
  });
}

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image decode failed')); };
    img.src = url;
  });
}
