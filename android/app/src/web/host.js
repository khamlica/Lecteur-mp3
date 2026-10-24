// Le « processus principal » du lecteur de bureau (src/main.js), pour le téléphone : réglages, menus, fenêtres de
// réglages (ouvertes ici dans un panneau) et window.api, que renderer.js utilise tel quel. Ce qu'une page ne
// sait pas faire (dossiers, tags, YouTube, notification, widget) passe par le pont Android (HanabiNative, voir
// PlayerService.kt). Chargé avant renderer.js ; after.js le complète une fois renderer.js chargé.
(() => {
  const N = window.HanabiNative;

  const DEFAULTS = {
    folder: null,
    lastTrack: null,
    position: 0,
    volume: 1,               // le volume du téléphone fait le reste
    muted: false,
    shuffle: false,
    repeat: 'off',           // 'off' | 'all' | 'one'
    transparent: true,       // fond de verre (fond d'écran flouté) ; false : fond sombre plein
    fxPulse: true,
    fxPressure: true,
    fxHalo: true,
    fxNotes: true,
    fxPulseLevel: 1,
    fxPressureLevel: 1,
    fxHaloLevel: 1,
    fxNotesLevel: 1,
    fxSyncMs: 0,
    fxSyncByDevice: {},
    fxTheme: 'glass',
    fxColorMode: 'theme',
    fxCustomColor: '#ff7a3d',
    soundFx: 'none',
  };

  let settings = { ...DEFAULTS };
  try {
    settings = { ...DEFAULTS, ...JSON.parse(N.loadSettings() || '{}') };
  } catch {
    settings = { ...DEFAULTS };
  }

  let saveTimer = null;
  function saveSettings() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(writeSettings, 500);
  }
  function writeSettings() {
    clearTimeout(saveTimer);
    N.saveSettings(JSON.stringify(settings));
  }

  // Travaux longs du côté Android : promesse résolue par _done (ou rejetée par _fail)
  let nextCall = 1;
  const calls = new Map();
  const call = (method, ...args) => new Promise((resolve, reject) => {
    const id = nextCall++;
    calls.set(id, { resolve, reject });
    N.call(id, method, JSON.stringify(args));
  });

  const trackUrl = (path) => '/music' + path.split('/').map(encodeURIComponent).join('/');
  const basename = (path) => path.slice(path.lastIndexOf('/') + 1);
  const dirname = (path) => path.slice(0, path.lastIndexOf('/')) || '/';
  const toBase64 = (bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  let commandCb = null;
  const send = (cmd, arg) => commandCb?.(cmd, arg);
  let playback = { audioDevice: null, fxColor: null };
  let updateReady = null;

  // ---------- Effets d'ambiance (comme dans main.js) ----------

  // Mêmes noms que FX_THEMES dans effects.js
  const FX_THEMES = [['glass', 'Verre liquide'], ['savage', 'SAVAGE'], ['savage-meshy', 'SAVAGE (Meshy)'], ['aurora', 'Aurore'], ['neon', 'Néon'], ['ember', 'Braise'], ['mono', 'Monochrome']];

  const FX_SETTINGS = {
    fxPulse: (v) => typeof v === 'boolean',
    fxPressure: (v) => typeof v === 'boolean',
    fxHalo: (v) => typeof v === 'boolean',
    fxNotes: (v) => typeof v === 'boolean',
    fxNotesLevel: (v) => typeof v === 'number' && v >= 0 && v <= 1.5,
    fxSyncMs: (v) => Number.isInteger(v) && v >= -200 && v <= 200,
    fxPulseLevel: (v) => typeof v === 'number' && v >= 0 && v <= 1.5,
    fxPressureLevel: (v) => typeof v === 'number' && v >= 0 && v <= 1.5,
    fxHaloLevel: (v) => typeof v === 'number' && v >= 0 && v <= 1.5,
    fxTheme: (v) => FX_THEMES.some(([name]) => name === v),
    fxColorMode: (v) => ['theme', 'cover', 'custom'].includes(v),
    fxCustomColor: (v) => /^#[0-9a-f]{6}$/i.test(v),
  };

  function fxConfig() {
    return {
      pulse: settings.fxPulse,
      pressure: settings.fxPressure,
      halo: settings.fxHalo,
      notes: settings.fxNotes,
      levels: { pulse: settings.fxPulseLevel, pressure: settings.fxPressureLevel, halo: settings.fxHaloLevel, notes: settings.fxNotesLevel },
      syncMs: settings.fxSyncMs,
      theme: settings.fxTheme,
      colorMode: settings.fxColorMode,
      customColor: settings.fxCustomColor,
    };
  }

  function setEffects(partial) {
    for (const [key, value] of Object.entries(partial)) {
      if (FX_SETTINGS[key]?.(value)) settings[key] = value;
    }
    if (typeof partial.fxSyncMs === 'number' && playback.audioDevice) settings.fxSyncByDevice[playback.audioDevice] = settings.fxSyncMs;
    saveSettings();
    send('effects', fxConfig());
    sendFxPanel();
    host.reportPlayback?.();
  }

  // ---------- Effets sonores (appliqués à l'écoute par sound.js) ----------

  const SOUND_EFFECTS = [
    ['none', 'Aucun'],
    null,
    ['room', 'Réverbération : salle'],
    ['cathedral', 'Réverbération : cathédrale'],
    ['slowed', 'Slowed + reverb'],
    ['speedup', 'Speed up'],
    null,
    ['bass', 'Bass boost'],
    ['8d', '8D (au casque)'],
    ['echo', 'Écho'],
    ['lofi', 'Lo-fi / radio'],
    null,
    ['night', 'Mode nuit (volume lissé)'],
    ['karaoke', 'Karaoké (voix atténuée)'],
  ];

  function soundEffect() {
    const found = SOUND_EFFECTS.find((e) => e && e[0] === settings.soundFx) || SOUND_EFFECTS[0];
    return { name: found[0], label: found[1] };
  }

  function setSoundEffect(name) {
    settings.soundFx = name;
    saveSettings();
    send('sound', soundEffect());
  }

  const soundMenu = () => SOUND_EFFECTS.map((e) => (e
    ? { label: e[1], type: 'radio', checked: settings.soundFx === e[0], click: () => setSoundEffect(e[0]) }
    : { type: 'separator' }));

  // Appui long sur le lecteur (le clic droit du bureau) : uniquement l'effet sonore
  const showSoundMenu = () => popupGlassMenu([{ label: 'Effet sonore', enabled: false }, ...soundMenu()]);

  function setTransparent(flag) {
    settings.transparent = flag;
    saveSettings();
    N.setTransparent(flag);
    send('transparent', flag);
  }

  // Le menu du bouton ✨ : celui du bureau, plus ce que proposait la zone de notification
  function effectsMenu() {
    return [
      ...(updateReady ? [
        { label: `Installer la version ${updateReady}`, click: () => N.installUpdate() },
        { type: 'separator' },
      ] : []),
      { label: 'Effet sonore', submenu: soundMenu() },
      { type: 'separator' },
      { label: 'Thème des effets visuels', enabled: false },
      ...FX_THEMES.map(([value, label]) => ({
        label,
        type: 'radio',
        checked: settings.fxTheme === value,
        click: () => setEffects({ fxTheme: value }),
      })),
      { type: 'separator' },
      { label: 'Rythme', type: 'checkbox', checked: settings.fxPulse, click: (item) => setEffects({ fxPulse: item.checked }) },
      { label: 'Basse', type: 'checkbox', checked: settings.fxPressure, click: (item) => setEffects({ fxPressure: item.checked }) },
      { label: 'Ambiance', type: 'checkbox', checked: settings.fxHalo, click: (item) => setEffects({ fxHalo: item.checked }) },
      { label: 'Voix', type: 'checkbox', checked: settings.fxNotes, click: (item) => setEffects({ fxNotes: item.checked }) },
      { type: 'separator' },
      { label: 'Transparence', type: 'checkbox', checked: settings.transparent, click: (item) => setTransparent(item.checked) },
      { label: 'Personnaliser les effets…', click: openFxPanel },
    ];
  }

  // ---------- Panneaux : menus, réglages des effets, édition du morceau ----------

  // Les fenêtres du bureau (menu.html, fx-panel.html, editor.html) s'ouvrent dans un panneau au-dessus du lecteur :
  // une feuille qui monte du bas pour les menus, l'écran entier pour les réglages. Elles y trouvent leur pont
  // (android/child.js) à la place de celui d'Electron.
  const layers = [];

  function openLayer(kind, page, onClose) {
    const el = document.createElement('div');
    el.className = `layer ${kind}-layer`;
    el.innerHTML = '<div class="backdrop"></div><div class="sheet"><iframe></iframe></div>';
    const layer = { kind, el, frame: el.querySelector('iframe'), onClose, closed: false };
    el.querySelector('.backdrop').addEventListener('click', () => closeLayer(layer));
    layer.frame.src = page;
    document.body.append(el);
    layers.push(layer);
    requestAnimationFrame(() => el.classList.add('open'));
    return layer;
  }

  function closeLayer(layer) {
    if (!layer || layer.closed) return;
    layer.closed = true;
    layers.splice(layers.indexOf(layer), 1);
    layer.el.classList.remove('open');
    setTimeout(() => layer.el.remove(), 220);
    layer.onClose?.();
  }

  const layerOf = (win) => layers.find((l) => l.frame.contentWindow === win);

  // Menus en verre, comme popupGlassMenu dans main.js (même modèle de menu ; l'ancre est ignorée : le menu monte
  // du bas de l'écran, sous le pouce) → promesse résolue à la fermeture du menu
  let glassMenu = null;

  function popupGlassMenu(template) {
    if (glassMenu) closeLayer(glassMenu.layer);
    const clicks = [], rows = [];
    const build = (list) => {
      const items = [];
      for (const it of list) {
        if (it.type === 'separator') {
          if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' });
        } else if (it.submenu) {
          const chosen = it.submenu.find((sub) => sub.checked && sub.type === 'radio');
          items.push({ type: 'submenu', label: it.label, value: chosen?.label || '', enabled: true, items: build(it.submenu) });
        } else if (it.enabled === false && !it.type && !it.click) {
          items.push({ type: 'header', label: it.label });
        } else {
          const row = { id: clicks.length, label: it.label, type: it.type || 'normal', checked: !!it.checked, enabled: it.enabled !== false };
          items.push(row);
          rows.push(row);
          clicks.push(it);
        }
      }
      while (items.length && items[items.length - 1].type === 'separator') items.pop();
      return items;
    };
    const items = build(template);
    return new Promise((resolve) => {
      const current = { items, rows, clicks };
      current.layer = openLayer('menu', 'menu.html', () => {
        if (glassMenu === current) glassMenu = null;
        resolve();
      });
      glassMenu = current;
    });
  }

  const menuApi = (win) => ({
    items: () => Promise.resolve(glassMenu && glassMenu.layer === layerOf(win) ? glassMenu.items : []),
    close: () => closeLayer(layerOf(win)),
    // la feuille prend la hauteur du menu affiché
    resize: (height) => {
      const layer = layerOf(win);
      if (layer) layer.el.style.setProperty('--menu-height', `${Math.ceil(height)}px`);
    },
    click: (id) => {
      const layer = layerOf(win);
      if (!glassMenu || glassMenu.layer !== layer) return;
      const it = glassMenu.clicks[id], shown = glassMenu.rows.find((row) => row.id === id);
      if (it?.click && shown?.enabled) it.click({ checked: shown.type === 'checkbox' ? !shown.checked : true });
      closeLayer(layer);
    },
  });

  // Fenêtre « Personnaliser les effets »
  let fxPanel = null;
  const fxPanelListeners = new Map(); // fenêtre → rappel

  function openFxPanel() {
    if (fxPanel) return;
    fxPanel = openLayer('panel', 'fx-panel.html', () => { fxPanel = null; });
  }

  // Réglages et couleur de la pochette en cours, pour les aperçus
  const fxPanelState = () => ({ config: fxConfig(), coverColor: playback.fxColor || null, audioDevice: playback.audioDevice || null });

  function sendFxPanel() {
    for (const [win, cb] of fxPanelListeners) {
      if (win.closed) fxPanelListeners.delete(win);
      else cb(fxPanelState());
    }
  }

  const fxPanelApi = (win) => ({
    load: () => Promise.resolve(fxPanelState()),
    set: (partial) => setEffects(partial),
    close: () => closeLayer(layerOf(win)),
    onUpdate: (cb) => fxPanelListeners.set(win, cb),
  });

  // Fenêtre d'édition (titre, artiste, pochette)
  let editor = null, editorFile = null, editorReload = null;

  function openEditor(file) {
    editorFile = file;
    if (editor) return editorReload?.();
    editor = openLayer('panel', 'editor.html', () => { editor = null; editorReload = null; });
  }

  // Le fichier peut être en cours de lecture : c'est le lecteur qui le libère le temps de l'écriture puis reprend la
  // lecture (saveTags dans renderer.js). On passe donc par lui.
  const tagRequests = new Map();
  let tagRequestId = 0;
  const saveTagsViaPlayer = (file, changes) => new Promise((resolve) => {
    const id = ++tagRequestId;
    tagRequests.set(id, resolve);
    send('save-tags', { id, file, changes });
  });

  const editorApi = (win) => ({
    load: async () => ({ file: editorFile, name: basename(editorFile), ...await call('metadata', editorFile) }),
    save: (changes) => saveTagsViaPlayer(editorFile, changes),
    lookup: async (fields) => {
      const found = await call('lookup', editorFile, fields);
      if (found.cover) found.cover = fromBase64(found.cover);
      else delete found.cover;
      return found;
    },
    close: () => closeLayer(layerOf(win)),
    onReload: (cb) => { editorReload = cb; },
  });

  // ---------- Dossier ou piste ----------

  // Choix dans les dossiers du téléphone : le choix de fichiers d'Android ne donne pas de chemin, et le lecteur
  // a besoin du dossier entier. Sur le téléphone, une seule liste propose dossiers et pistes (Windows, lui, ne
  // sait pas : d'où le petit menu du bureau). → { folder, file } ou null
  const browser = {
    el: document.getElementById('browser'),
    path: null,
    resolve: null,
  };

  const $b = (id) => document.getElementById(id);

  function browse() {
    return new Promise((resolve) => {
      browser.resolve?.(null);
      browser.resolve = resolve;
      browser.el.hidden = false;
      requestAnimationFrame(() => browser.el.classList.add('open'));
      const start = settings.folder || N.musicFolder();
      showDir(start);
    });
  }

  function closeBrowser(result = null) {
    if (browser.el.hidden) return;
    browser.el.classList.remove('open');
    setTimeout(() => { browser.el.hidden = true; }, 220);
    const resolve = browser.resolve;
    browser.resolve = null;
    resolve?.(result);
  }

  async function showDir(path) {
    const access = N.hasStorageAccess();
    $b('browser-access').hidden = access;
    $b('browser-list').hidden = !access;
    $b('browser-pick').hidden = !access;
    browser.el.querySelector('.hint').hidden = !access;
    if (!access) {
      $b('browser-name').textContent = 'Accès aux fichiers';
      $b('browser-path').textContent = '';
      $b('browser-up').hidden = true;
      browser.path = path;
      return;
    }
    let dir;
    try {
      dir = await call('listDir', path);
      if (path && !dir.dirs.length && !dir.files.length && dir.parent === null) throw new Error('vide');
    } catch {
      dir = await call('listDir', null);
    }
    browser.path = dir.path;
    $b('browser-name').textContent = dir.path ? dir.name : 'Emplacements';
    $b('browser-path').textContent = dir.path ? '‎' + dir.path : ''; // le début du chemin s'efface s'il est trop long (rtl)
    $b('browser-up').hidden = !dir.path;
    $b('browser-up').dataset.parent = dir.parent || '';
    $b('browser-pick').hidden = !dir.path;
    browser.el.querySelector('.hint').hidden = !dir.files.length;
    const list = $b('browser-list');
    list.replaceChildren();
    for (const d of dir.dirs) list.append(entry('dir', d.name, () => showDir(d.path)));
    for (const f of dir.files) list.append(entry('file', f.name.replace(/\.[^.]+$/, ''), () => closeBrowser({ folder: dir.path, file: f.path })));
    if (!dir.dirs.length && !dir.files.length) {
      list.append(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'Ni dossier ni piste ici' }));
    }
    list.scrollTop = 0;
  }

  function entry(kind, name, onClick) {
    const button = document.createElement('button');
    button.className = `entry ${kind}`;
    button.innerHTML = `<svg><use href="#${kind === 'dir' ? 'i-folder' : 'i-note'}"/></svg><span></span>${kind === 'dir' ? '<svg class="chevron"><use href="#i-chevron"/></svg>' : ''}`;
    button.querySelector('span').textContent = name;
    button.addEventListener('click', onClick);
    return button;
  }

  $b('browser-up').addEventListener('click', () => showDir($b('browser-up').dataset.parent || null));
  $b('browser-close').addEventListener('click', () => closeBrowser());
  browser.el.querySelector('.backdrop').addEventListener('click', () => closeBrowser());
  $b('browser-pick').addEventListener('click', () => browser.path && closeBrowser({ folder: browser.path, file: null }));
  $b('browser-allow').addEventListener('click', () => N.requestStorageAccess());

  // ---------- window.api (preload.js du bureau) ----------

  window.api = {
    getInitialState: async () => {
      let tracks = [];
      if (settings.folder && N.hasStorageAccess()) tracks = await call('scan', settings.folder).catch(() => []);
      return { settings, tracks, sound: soundEffect(), effects: fxConfig() };
    },
    // `kind` est ignoré : la liste propose dossiers et pistes à la fois
    chooseFolder: async () => {
      const chosen = await browse();
      if (!chosen) return null;
      settings.folder = chosen.folder;
      settings.lastTrack = chosen.file;
      settings.position = 0;
      saveSettings();
      return { folder: settings.folder, tracks: await call('scan', settings.folder), file: chosen.file };
    },
    getMetadata: (file) => call('metadata', file).catch(() => ({})),
    // Contenu d'un morceau pour la pré-analyse des effets : uniquement dans le dossier de musique, et pas les
    // fichiers énormes (un mix de plusieurs heures saturerait la mémoire une fois décodé)
    readAudio: async (file) => {
      if (!settings.folder || !/\.(mp3|opus|m4a)$/i.test(file) || !file.startsWith(settings.folder.replace(/\/$/, '') + '/')) return null;
      try {
        const res = await fetch(trackUrl(file));
        if (!res.ok || Number(res.headers.get('Content-Length')) > 40 * 1024 * 1024) return null;
        return new Uint8Array(await res.arrayBuffer());
      } catch {
        return null;
      }
    },
    reportFx: () => {}, // touches F et C du bureau : pas de clavier ici
    convertYoutube: async (url) => {
      const folder = settings.folder && N.hasStorageAccess() ? settings.folder : null;
      if (!N.hasStorageAccess()) {
        N.requestStorageAccess();
        return { error: 'Autorisez l\'accès aux fichiers, puis réessayez' };
      }
      const result = await call('youtube', url, folder).catch((err) => ({ error: `Échec : ${err.message}` }));
      if (result.folder && result.folder !== settings.folder) {
        // Musique/YouTube, créé pour l'occasion, devient le dossier de musique
        settings.folder = result.folder;
        settings.lastTrack = null;
        settings.position = 0;
        saveSettings();
      }
      return result;
    },
    cancelYoutube: () => N.cancelYoutube(),
    readClipboard: () => Promise.resolve(N.readClipboard()),
    writeTags: (file, changes) => {
      const c = { ...changes };
      if (c.cover) c.cover = toBase64(c.cover);
      return call('writeTags', file, c).catch((err) => ({ error: `Modifications non enregistrées : ${err.message}` }));
    },
    tagsSaved: (id, result) => {
      tagRequests.get(id)?.(result);
      tagRequests.delete(id);
    },
    openEditor,
    saveState: (partial) => {
      Object.assign(settings, partial);
      saveSettings();
    },
    hideWindow: () => N.moveToBack(),
    showEffectsMenu: () => popupGlassMenu(effectsMenu()),
    frameFx: () => {}, // pas de fenêtre-cadre sur le téléphone
    showSoundMenu,
    reportPlayback: (info) => {
      // la sortie audio vient d'Android (audio-device), pas de la page
      const { audioDevice, ...rest } = info;
      playback = { ...playback, ...rest };
      if (info.fxColor) sendFxPanel();
      host.reportPlayback?.();
    },
    onCommand: (cb) => { commandCb = cb; },
  };

  // ---------- Depuis Android ----------

  const host = window.hanabiHost = {
    settings: () => settings,
    playback: () => playback,
    call,
    menuApi,
    fxPanelApi,
    editorApi,
    reportPlayback: null, // posé par after.js
    onCommand: null,      // commandes propres au téléphone, posé par after.js
    onStorage: null,

    _done(id, result) {
      calls.get(id)?.resolve(result);
      calls.delete(id);
    },
    _fail(id, message) {
      calls.get(id)?.reject(new Error(message));
      calls.delete(id);
    },

    // Widget, notification, casque, partage d'un lien : play-pause, play, pause, next, prev, seek, youtube-url
    _command(cmd, arg) {
      if (host.onCommand?.(cmd, arg)) return;
      send(cmd, arg);
    },

    _event(name, arg) {
      switch (name) {
        case 'yt-progress': send('yt-progress', arg); break;
        case 'insets':
          for (const side of ['top', 'bottom', 'left', 'right']) document.documentElement.style.setProperty(`--inset-${side}`, `${arg[side]}px`);
          break;
        case 'audio-device':
          // Nouvelle sortie audio : on reprend le réglage de synchronisation retenu pour elle (0 si inconnue).
          if (arg !== playback.audioDevice) {
            playback.audioDevice = arg;
            setEffects({ fxSyncMs: settings.fxSyncByDevice[arg] ?? 0 });
          }
          break;
        case 'update-ready': updateReady = arg; break;
        case 'resume':
        case 'storage':
          // de retour des réglages d'Android : l'accès aux fichiers vient peut-être d'être accordé
          if (!browser.el.hidden) showDir(browser.path);
          host.onStorage?.();
          break;
      }
    },

    // Bouton Retour : ferme ce qui est ouvert → true, ou rien à fermer → false (l'app passe en arrière-plan)
    back() {
      if (!browser.el.hidden) {
        const up = $b('browser-up');
        if (!up.hidden && N.hasStorageAccess()) up.click();
        else closeBrowser();
        return true;
      }
      if (layers.length) {
        const top = layers[layers.length - 1];
        // un menu ouvert sur une liste (l'effet sonore) revient d'abord au menu
        const back = top.kind === 'menu' && top.frame.contentDocument?.querySelector('.item.back');
        if (back) back.click();
        else closeLayer(top);
        return true;
      }
      return host.onBack?.() || false;
    },
  };

  window.addEventListener('beforeunload', writeSettings);
  document.addEventListener('visibilitychange', () => document.hidden && writeSettings());
})();
