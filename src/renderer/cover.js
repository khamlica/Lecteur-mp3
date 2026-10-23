// Préparation des pochettes, commune au lecteur et à la fenêtre d'édition.

const COVER_SIZE = 600; // largement suffisant pour une pochette, et léger dans le fichier

// Recadre l'image en carré centré, la réduit et la compresse en JPEG.
async function squareCover(blob) {
  const bitmap = await createImageBitmap(blob);
  const side = Math.min(bitmap.width, bitmap.height);
  const size = Math.min(side, COVER_SIZE);
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // fond des images transparentes
  ctx.fillRect(0, 0, size, size);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
  bitmap.close();
  const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  return new Uint8Array(await jpeg.arrayBuffer());
}

// Première image d'un presse-papiers ou d'un glisser-déposer, s'il y en a une.
function imageFrom(dataTransfer) {
  const item = [...dataTransfer.items].find((i) => i.kind === 'file' && i.type.startsWith('image/'));
  return item ? item.getAsFile() : null;
}
