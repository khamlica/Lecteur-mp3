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
