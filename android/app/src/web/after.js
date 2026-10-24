// Complète host.js une fois renderer.js chargé (ses fonctions et son élément audio sont alors accessibles) : ce
// qu'Android doit savoir du morceau en cours (notification, écran verrouillé, widget) et les commandes propres au
// téléphone.
(() => {
  const N = window.HanabiNative;
  const host = window.hanabiHost;

  // ---------- Le morceau en cours, pour Android ----------

  let timer = null;
  function report() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const track = current();
      N.playback(JSON.stringify({
        playing: !!track && !audio.paused,
        path: track ? track.path : null,
        title: track ? ui.title.textContent : 'Hanabi Player',
        artist: track ? ui.artist.textContent : '',
        position: audio.currentTime || 0,
        duration: isFinite(audio.duration) ? audio.duration : 0,
        rate: audio.playbackRate || 1,
        theme: host.settings().fxTheme,
        frame: host.settings().fxFrame,
        color: host.playback().fxColor || null,
      }));
    }, 60);
  }
  host.reportPlayback = report;
  for (const type of ['play', 'pause', 'loadedmetadata', 'durationchange', 'seeked', 'ratechange', 'emptied']) audio.addEventListener(type, report);
  for (const el of [ui.title, ui.artist]) new MutationObserver(report).observe(el, { childList: true, characterData: true, subtree: true });

  // ---------- Fond flou ----------

  // La palette de la pochette (--fx-palette, 24 × 6 pixels, posée par effects.js) préparée une fois : agrandie,
  // floutée, saturée et assombrie (--fx-palette-cut : une pochette claire l'est davantage) dans un petit canevas, posé
  // sur son propre élément (mobile.css, .fx-palette-img) : l'écran n'a plus qu'à l'étirer et le faire dériver, sans
  // filtre à recalculer
  const bar = document.getElementById('bar');
  const palette = document.createElement('div');
  palette.className = 'fx-palette-img';
  bar.querySelector('.fx-palette').append(palette);
  let lastPalette = null;
  function softenPalette() {
    const value = bar.style.getPropertyValue('--fx-palette');
    const cut = parseFloat(bar.style.getPropertyValue('--fx-palette-cut')) || 0;
    if (`${value}|${cut}` === lastPalette) return;
    const key = lastPalette = `${value}|${cut}`;
    const url = /url\("?([^")]+)"?\)/.exec(value)?.[1];
    if (!url) return palette.style.removeProperty('background-image');
    const img = new Image();
    img.onload = () => {
      if (lastPalette !== key) return;
      const W = 96, H = 72, pad = 12;
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      // la palette déborde du canevas, pour que le flou ne s'assombrisse pas sur les bords
      ctx.filter = `blur(6px) saturate(1.35) brightness(${(0.9 * (1 - cut)).toFixed(3)})`;
      ctx.drawImage(img, -pad, -pad, W + 2 * pad, H + 2 * pad);
      palette.style.backgroundImage = `url("${canvas.toDataURL('image/png')}")`;
    };
    img.src = url;
  }
  new MutationObserver(softenPalette).observe(bar, { attributes: true, attributeFilter: ['style'] });
  softenPalette();

  // ---------- Lueur de la pochette ----------

  // La voix éclaire la pochette par-derrière (mobile.css, .fx-cover-glow) : une lueur faite de la pochette elle-même,
  // floutée, plus vive et plus claire, une fois par morceau dans un petit canevas, avec une marge où le flou s'étale.
  // L'élément déborde de la pochette d'autant (un quart de sa taille de chaque côté), pour que l'image floutée tombe
  // pile derrière elle.
  const GLOW_SIZE = 64, GLOW_PAD = 16;
  const coverEl = document.getElementById('cover');
  const glow = document.createElement('div');
  glow.className = 'fx-cover-glow';
  bar.prepend(glow);

  // Cadre SAVAGE du plein écran (mobile.css, tools/savage/chrome_mobile.py) : le bord de l'écran, et le sertissage
  // de la pochette, qui la suit comme sa lueur ; chacun avec son reflet, découpé à la forme du chrome
  const COVER_SIZE = 338, COVER_MARGIN = 34; // le sertissage de référence : la pochette et la marge de ses griffes
  const savageFrame = document.createElement('div');
  savageFrame.className = 'fx-savage-frame';
  const savageCover = document.createElement('div');
  savageCover.className = 'fx-savage-cover';
  for (const el of [savageFrame, savageCover]) el.innerHTML = '<div class="fx-savage-glint"><i></i></div>';
  bar.append(savageFrame, savageCover);

  // La place de la pochette dans #bar, sans l'enfoncement d'un coup (offset* ignorent les transformations) ; elle
  // bouge avec la taille de l'écran, les marges des barres du système (--inset-*, posées sur la racine) et le champ
  // YouTube (body.yt), qui ne changent pas forcément sa taille : on les surveille tous
  let placing = 0;
  function placeGlow() {
    cancelAnimationFrame(placing);
    placing = requestAnimationFrame(() => {
      const m = coverEl.offsetWidth * GLOW_PAD / GLOW_SIZE;
      Object.assign(glow.style, {
        left: `${coverEl.offsetLeft - m}px`, top: `${coverEl.offsetTop - m}px`,
        width: `${coverEl.offsetWidth + 2 * m}px`, height: `${coverEl.offsetHeight + 2 * m}px`,
      });
      const c = coverEl.offsetWidth * COVER_MARGIN / COVER_SIZE;
      Object.assign(savageCover.style, {
        left: `${coverEl.offsetLeft - c}px`, top: `${coverEl.offsetTop - c}px`,
        width: `${coverEl.offsetWidth + 2 * c}px`, height: `${coverEl.offsetHeight + 2 * c}px`,
      });
    });
  }
  const resized = new ResizeObserver(placeGlow);
  for (const el of [coverEl, bar, document.getElementById('body')]) resized.observe(el);
  new MutationObserver(placeGlow).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
  new MutationObserver(placeGlow).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  addEventListener('resize', placeGlow);
  placeGlow();

  let glowFor = null;
  function blurCover() {
    const src = ui.coverImg.hidden || !ui.coverImg.src ? '../../assets/cover.svg' : ui.coverImg.src;
    if (src === glowFor) return;
    glowFor = src;
    const img = new Image();
    img.onload = () => {
      if (glowFor !== src) return;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = GLOW_SIZE + 2 * GLOW_PAD;
      const ctx = canvas.getContext('2d');
      // plus vive et plus claire que l'image : c'est une lumière
      ctx.filter = 'blur(9px) saturate(1.8) brightness(1.5)';
      ctx.drawImage(img, GLOW_PAD, GLOW_PAD, GLOW_SIZE, GLOW_SIZE);
      glow.style.backgroundImage = `url("${canvas.toDataURL('image/png')}")`;
      bar.classList.add('fx-cover-glow-on');
    };
    // image illisible : pas de lueur plutôt que celle du morceau précédent
    img.onerror = () => {
      if (glowFor === src) bar.classList.remove('fx-cover-glow-on');
    };
    img.src = src;
  }
  new MutationObserver(blurCover).observe(ui.coverImg, { attributes: true, attributeFilter: ['src', 'hidden'] });
  blurCover();

  // ---------- Thème SAVAGE : la lueur de la basse à travers des alvéoles ----------

  // Comme en Verre liquide, une nappe de la couleur de la pochette et un cœur plus clair (mobile.css), vus à travers
  // un réseau d'alvéoles (Voronoï : chaque germe est le centre d'une cellule, la paroi est là où les deux germes les
  // plus proches sont à égale distance). Le réseau est calculé une fois par texture et par taille d'écran, la
  // couleur une fois par morceau, dans deux canevas posés dans .fx-bass : la musique ne change que leur opacité.
  // Réglages (en pixels d'un écran de 400 de large) choisis avec l'utilisateur sur un banc d'essai.
  const CELLS = { mesh: 20, wall: 0.5, soft: 0.3, fill: 0.1 };
  const FX_CELL_KINDS = ['cells', 'hex', 'graded', 'plateau']; // (FX_TEXTURES de host.js)
  const bassEl = bar.querySelector('.fx-bass');
  const cellLayers = ['fx-cells-wide', 'fx-cells-core'].map((name) => {
    const canvas = document.createElement('canvas');
    canvas.className = name;
    bassEl.append(canvas);
    return canvas;
  });

  // Hasard reproductible : la même texture à chaque ouverture
  function seeded(seed) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Le masque (alpha) : parois pleines, qui débordent dans chaque cellule en fondu (le trou rétrécit, sans bord net).
  // Une image par pixel CSS (le fondu n'a pas besoin de plus : 4 fois moins de mémoire qu'à la densité de l'écran).
  function cellMask(kind, sw, sh, scale) {
    const R = seeded(7);
    const mesh = CELLS.mesh * scale, wall = (CELLS.wall * scale) / 2;
    const pad = mesh * 2; // germes hors du canevas : les cellules du bord sont complètes
    const pts = [];
    let big = mesh;
    if (kind === 'hex') {
      const dy = mesh * 0.866;
      for (let j = 0, y = -pad; y < sh + pad; j++, y += dy) {
        for (let x = -pad + (j % 2) * mesh / 2; x < sw + pad; x += mesh) pts.push([x + (R() - 0.5) * mesh * 0.08, y + (R() - 0.5) * mesh * 0.08]);
      }
    } else if (kind === 'cells') {
      for (let y = -pad; y < sh + pad; y += mesh) for (let x = -pad; x < sw + pad; x += mesh) pts.push([x + R() * mesh, y + R() * mesh]);
    } else {
      // tirage avec écart minimal : fine en bas, près de la source de la basse, pour l'écume graduée ; un peu
      // variable pour l'écume épaisse
      const gap = kind === 'graded' ? (y) => mesh * (0.45 + 1.25 * Math.min(1, Math.max(0, 1 - y / sh))) : () => mesh * (0.8 + 0.2 * R());
      if (kind === 'graded') big = mesh * 1.7;
      const gx = Math.ceil((sw + 2 * pad) / big), gy = Math.ceil((sh + 2 * pad) / big);
      const grid = Array.from({ length: gx * gy }, () => []);
      const tries = Math.ceil(((sw + 2 * pad) * (sh + 2 * pad)) / (mesh * 0.45) ** 2) * 4;
      for (let n = 0; n < tries; n++) {
        const px = -pad + R() * (sw + 2 * pad), py = -pad + R() * (sh + 2 * pad), g = gap(py) * 0.85;
        const ci = Math.floor((px + pad) / big), cj = Math.floor((py + pad) / big);
        let ok = true;
        for (let j = cj - 1; ok && j <= cj + 1; j++) for (let i = ci - 1; ok && i <= ci + 1; i++) {
          if (i < 0 || j < 0 || i >= gx || j >= gy) continue;
          for (const q of grid[j * gx + i]) if ((q[0] - px) ** 2 + (q[1] - py) ** 2 < g * g) { ok = false; break; }
        }
        if (ok) { const q = [px, py]; pts.push(q); grid[cj * gx + ci].push(q); }
      }
    }

    // cases de recherche : les trois germes les plus proches d'un pixel sont dans sa case ou les voisines
    const B = big * 1.3, bx = Math.ceil((sw + 2 * pad) / B) + 1, by = Math.ceil((sh + 2 * pad) / B) + 1;
    const buckets = Array.from({ length: bx * by }, () => []);
    for (const q of pts) {
      const i = Math.floor((q[0] + pad) / B), j = Math.floor((q[1] + pad) / B);
      if (i >= 0 && j >= 0 && i < bx && j < by) buckets[j * bx + i].push(q);
    }
    const img = new ImageData(sw, sh);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      const ci = Math.floor((x + pad) / B), cj = Math.floor((y + pad) / B);
      // (au carré pendant la recherche : la racine seulement pour les trois retenus)
      let d1 = 1e18, d2 = 1e18, d3 = 1e18;
      for (let j = cj - 1; j <= cj + 1; j++) for (let i = ci - 1; i <= ci + 1; i++) {
        if (i < 0 || j < 0 || i >= bx || j >= by) continue;
        for (const q of buckets[j * bx + i]) {
          const d = (q[0] - x) ** 2 + (q[1] - y) ** 2;
          if (d < d1) { d3 = d2; d2 = d1; d1 = d; } else if (d < d2) { d3 = d2; d2 = d; } else if (d < d3) d3 = d;
        }
      }
      d1 = Math.sqrt(d1); d2 = Math.sqrt(d2); d3 = Math.sqrt(d3);
      const e = (d2 - d1) / 2; // distance à la paroi
      let w0 = wall;
      // écume épaisse : près d'une jonction de trois cellules, le troisième germe est presque aussi proche
      if (kind === 'plateau') w0 = wall * (1 + 2.6 * Math.max(0, 1 - (d3 - d2) / 2 / ((d1 + d2) / 2 * 0.45)) ** 2);
      // le fondu couvre une part (CELLS.soft) du chemin entre la paroi et le centre de la cellule
      const fade = Math.max(0.7, CELLS.soft * Math.max(0, e + d1 - w0));
      const u = Math.min(1, Math.max(0, (e - w0) / fade));
      // un peu de lumière reste dans les trous (CELLS.fill)
      const a = CELLS.fill + (1 - CELLS.fill) * (1 - u * u * (3 - 2 * u));
      const o = (y * sw + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = 255;
      img.data[o + 3] = Math.round(a * 255);
    }
    const mask = document.createElement('canvas');
    mask.width = sw; mask.height = sh;
    mask.getContext('2d').putImageData(img, 0, 0);
    return mask;
  }

  // Une lumière posée sur le bas (les mêmes formes que la lueur continue du Verre liquide, mobile.css), plus forte
  // puisque la texture en retire une part, vue à travers le masque
  function paintCells(canvas, mask, rgb, core) {
    const w = canvas.width, h = canvas.height, ctx = canvas.getContext('2d');
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    // le canevas déborde de .fx-bass (5 % sur les côtés, 2 % en bas : mobile.css), pour la dérive
    const rx = (w / 1.1) * (core ? 0.8 : 1.3), ry = (h / 1.04) * (core ? 0.35 : 0.75);
    ctx.translate(w / 2, h * (1 - 0.02 / 1.04));
    ctx.scale(rx / ry, 1);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, ry);
    g.addColorStop(0, `rgb(${rgb} / ${core ? 0.57 : 0.87})`);
    if (!core) g.addColorStop(0.55, `rgb(${rgb} / 0.23)`);
    g.addColorStop(core ? 0.7 : 1, `rgb(${rgb} / 0)`);
    ctx.fillStyle = g;
    ctx.fillRect(-w * 2, -h * 2, w * 4, h * 4);
    ctx.restore();
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(mask, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
  }

  // Les derniers masques calculés (une rotation de l'écran, le clavier qui s'ouvre puis se ferme : on retrouve
  // le précédent sans tout recalculer) ; un nouveau masque attend que la taille ne bouge plus (250 ms), le calcul
  // (0,1 à 0,3 s) ne tombe donc pas au milieu d'une animation
  const CELL_MASKS = 3, CELL_SETTLE = 250;
  const cellMasks = new Map();
  let cellTimer = 0, cellPending = null, cellPaintFor = null;
  // taille de .fx-bass, tenue par le ResizeObserver : l'observateur du style passe à chaque image, il ne doit pas
  // mesurer la page (ce qui forcerait sa mise en page à chaque image)
  let bassBox = { width: 0, height: 0 };
  function updateCells() {
    if (bar.dataset.fxTheme !== 'savage-cells' && bar.dataset.fxTheme !== 'savage-enhanced') {
      if (cellPending) { clearTimeout(cellTimer); cellPending = null; }
      if (cellMasks.size) {
        // le thème a changé : on rend la mémoire des canevas
        cellMasks.clear();
        cellPaintFor = null;
        for (const canvas of cellLayers) canvas.width = canvas.height = 0;
      }
      return;
    }
    const kind = FX_CELL_KINDS.includes(host.settings().fxTexture) ? host.settings().fxTexture : 'cells';
    const w = Math.round(bassBox.width * 1.1), h = Math.round(bassBox.height * 1.04);
    if (w < 8 || h < 8) return;
    const maskKey = `${kind}|${w}|${h}`;
    const mask = cellMasks.get(maskKey);
    if (!mask) {
      // (l'observateur du style passe à chaque image : le délai ne repart que si la taille ou la texture change)
      if (cellPending === maskKey) return;
      cellPending = maskKey;
      clearTimeout(cellTimer);
      cellTimer = setTimeout(() => {
        cellPending = null;
        // les mailles à l'échelle du petit côté de l'écran (en paysage ou sur tablette, pas deux fois plus grosses)
        cellMasks.set(maskKey, cellMask(kind, w, h, Math.min(innerWidth, innerHeight) / 400));
        if (cellMasks.size > CELL_MASKS) cellMasks.delete(cellMasks.keys().next().value);
        updateCells();
      }, CELL_SETTLE);
      return;
    }
    const wide = bar.style.getPropertyValue('--fx-cover-color').trim(), core = bar.style.getPropertyValue('--fx-glint').trim();
    const paintKey = `${maskKey}|${wide}|${core}`;
    if (!wide || !core || paintKey === cellPaintFor) return;
    cellPaintFor = paintKey;
    for (const canvas of cellLayers) { canvas.width = w; canvas.height = h; }
    paintCells(cellLayers[0], mask, wide, false);
    paintCells(cellLayers[1], mask, core, true);
  }
  // le thème, la pochette (couleurs posées par effects.js sur #bar), la taille de l'écran, et la texture choisie
  // (setEffects de host.js prévient le widget par reportPlayback : on s'y accroche)
  new MutationObserver(updateCells).observe(bar, { attributes: true, attributeFilter: ['style', 'data-fx-theme'] });
  new ResizeObserver(([entry]) => { bassBox = entry.contentRect; updateCells(); }).observe(bassEl);
  const reportBase = host.reportPlayback;
  host.reportPlayback = () => { reportBase(); updateCells(); };
  updateCells();

  // ---------- Commandes propres au téléphone ----------

  host.onCommand = (cmd, arg) => {
    switch (cmd) {
      case 'play':
        if (audio.paused) togglePlay();
        return true;
      case 'seek':
        if (isFinite(audio.duration)) audio.currentTime = Math.max(0, Math.min(audio.duration, Number(arg)));
        return true;
      case 'youtube-url': // un lien partagé depuis une autre app
        if (!ytBusy) openYoutube(arg).then(convertYoutube);
        return true;
    }
    return false;
  };

  // Retour : le champ YouTube se referme (pas pendant un téléchargement : il continue)
  host.onBack = () => {
    if (document.body.classList.contains('yt') && !ytBusy) {
      closeYoutube();
      return true;
    }
    return false;
  };

  // L'accès aux fichiers vient d'être accordé : le dossier retenu se charge
  host.onStorage = async () => {
    const s = host.settings();
    if (tracks.length || !s.folder || !N.hasStorageAccess()) return;
    const list = await host.call('scan', s.folder).catch(() => []);
    if (list.length && !tracks.length) {
      folder = s.folder;
      setTracks(list, s.lastTrack, s.position);
    }
  };

  // Pas de souris : « touchez » plutôt que « cliquez »
  const showEmptyDesktop = showEmpty;
  showEmpty = function () {
    showEmptyDesktop();
    if (!folder) ui.artist.textContent = 'Touchez ici pour choisir un dossier de musique';
    else if (!N.hasStorageAccess()) ui.artist.textContent = 'Touchez ici pour autoriser l\'accès aux fichiers';
  };
  // le lecteur s'est peut-être déjà affiché vide, avant ce script (renderer.js démarre aussitôt chargé)
  if (document.body.classList.contains('empty')) showEmpty();

  // Appui long : le menu de l'effet sonore (le clic droit du bureau), sauf dans un champ de saisie, qui garde le
  // sien (coller un lien…)
  window.addEventListener('contextmenu', (e) => {
    if (e.target instanceof HTMLInputElement) e.stopImmediatePropagation();
  }, true);

  report();
  N.ready();
})();
