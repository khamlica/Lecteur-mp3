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

  // La palette de la pochette (--fx-palette, 24 × 6 pixels, posée par effects.js) adoucie une fois : agrandie et
  // floutée dans un petit canevas, que l'écran n'a plus qu'à étirer (voir mobile.css, .fx-palette)
  const bar = document.getElementById('bar');
  let lastPalette = null;
  function softenPalette() {
    const value = bar.style.getPropertyValue('--fx-palette');
    if (value === lastPalette) return;
    lastPalette = value;
    const url = /url\("?([^")]+)"?\)/.exec(value)?.[1];
    if (!url) return bar.style.removeProperty('--fx-palette-soft');
    const img = new Image();
    img.onload = () => {
      if (lastPalette !== value) return;
      const W = 96, H = 72, pad = 12;
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      // la palette déborde du canevas, pour que le flou ne s'assombrisse pas sur les bords
      ctx.filter = 'blur(6px)';
      ctx.drawImage(img, -pad, -pad, W + 2 * pad, H + 2 * pad);
      bar.style.setProperty('--fx-palette-soft', `url("${canvas.toDataURL('image/png')}")`);
    };
    img.src = url;
  }
  new MutationObserver(softenPalette).observe(bar, { attributes: true, attributeFilter: ['style'] });
  softenPalette();

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
