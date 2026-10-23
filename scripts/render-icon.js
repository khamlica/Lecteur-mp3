// Rendu SVG -> PNG avec Chromium (via Electron).
// Usage : electron main.js <in.svg> <out.png> <taille> <rayon des coins (fraction)>
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const [input, output, size, radius] = process.argv.slice(-4);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('about:blank');
  const svg = fs.readFileSync(input, 'base64');
  const dataUrl = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = 'data:image/svg+xml;base64,${svg}';
    await img.decode();
    const s = ${Number(size)}, r = s * ${Number(radius)};
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const g = c.getContext('2d');
    g.beginPath();
    g.roundRect(0, 0, s, s, r);
    g.clip();
    g.drawImage(img, 0, 0, s, s);
    return c.toDataURL('image/png');
  })()`);
  fs.writeFileSync(output, Buffer.from(dataUrl.split(',')[1], 'base64'));
  app.quit();
});
