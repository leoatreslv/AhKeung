// Browser-side resize for trainer-uploaded exercise photos. Phone cameras
// emit ~5MB JPEGs at 4000×3000; uploading them straight would waste
// bandwidth and Storage quota. We rescale to a 1024-px long edge at
// quality 0.85, which lands around 80–200 KB and is plenty for the
// inline thumbnails + the details-modal large view.

export interface ResizeOptions {
  maxEdge?: number;   // default 1024
  quality?: number;   // 0..1, default 0.85
  mimeType?: string;  // default 'image/jpeg'
}

export async function resizeImage(file: Blob, opts: ResizeOptions = {}): Promise<Blob> {
  const maxEdge = opts.maxEdge ?? 1024;
  const quality = opts.quality ?? 0.85;
  const mimeType = opts.mimeType ?? 'image/jpeg';

  const img = await loadImage(file);
  const { width, height } = img;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const targetW = Math.max(1, Math.round(width * scale));
  const targetH = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas context unavailable');
  ctx.drawImage(img, 0, 0, targetW, targetH);

  return await new Promise<Blob>((resolve, reject) => {
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
