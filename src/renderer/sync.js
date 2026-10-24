// Fenêtre « Synchronisation », la même sur l'ordinateur (sync.js du processus principal) et sur le téléphone
// (Sync.kt, par host.js) : appareils associés, association avec son code à comparer, synchronisation en cours.
const $ = (id) => document.getElementById(id);

let state = null;
let forgetting = null; // appareil dont on confirme l'oubli

const TEXT = {
  pc: {
    intro: 'Le téléphone vient chercher ici les morceaux qui lui manquent et y dépose les siens, dès que les deux sont sur le même réseau (Wi‑Fi ou partage de connexion). Rien n\'est jamais supprimé, et un morceau supprimé d\'un côté n\'y revient pas.',
    devices: 'Téléphones associés',
    none: 'Aucun téléphone associé.',
    pair: 'Associer un téléphone',
  },
  phone: {
    intro: 'Dès que le téléphone et l\'ordinateur sont sur le même réseau (Wi‑Fi ou partage de connexion), les morceaux qui manquent d\'un côté y sont copiés. Rien n\'est jamais supprimé, et un morceau supprimé d\'un côté n\'y revient pas.',
    devices: 'Ordinateurs associés',
    none: 'Aucun ordinateur associé.',
    pair: 'Associer un ordinateur',
  },
};

function ago(time) {
  const s = Math.round((Date.now() - time) / 1000);
  if (s < 60) return 'à l\'instant';
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
  return `le ${new Date(time).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}`;
}

const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

function button(label, onClick, className = 'action') {
  const b = el('button', className, label);
  b.addEventListener('click', onClick);
  return b;
}

const act = async (name, arg) => render(await sync.action(name, arg));

// ---------- Affichage ----------

function render(next) {
  if (next) state = next;
  if (!state) return;
  const text = TEXT[state.role];
  $('intro').textContent = text.intro;
  $('devices-title').textContent = text.devices;
  renderDevices(text);
  renderPairing(text);
  renderOffline();
  renderStatus();
}

function renderDevices(text) {
  const list = $('devices');
  list.replaceChildren();
  if (!state.devices.length) list.append(el('div', 'empty', text.none));
  for (const d of state.devices) {
    const row = el('div', 'device');
    const info = el('div', 'text');
    info.append(el('div', 'name', d.name));
    const s = d.summary;
    const detail = d.lastSync
      ? `Synchronisé ${ago(d.lastSync)}${s && (s.received || s.sent) ? ` · ${plural(s.received, 'reçu')}, ${plural(s.sent, 'envoyé')}` : ''}`
      : 'Pas encore synchronisé';
    info.append(el('div', 'detail', d.error ? d.error : detail));
    row.append(info);
    const confirm = forgetting === d.id;
    row.append(button(confirm ? 'Oublier ?' : 'Oublier', () => {
      if (!confirm) {
        forgetting = d.id;
        render();
        setTimeout(() => { if (forgetting === d.id) { forgetting = null; render(); } }, 4000);
      } else {
        forgetting = null;
        act('forget', d.id);
      }
    }, `link${confirm ? ' confirm' : ''}`));
    list.append(row);
  }
}

function message(text, error = false) {
  return el('p', `message${error ? ' error' : ''}`, text);
}

function renderPairing(text) {
  const box = $('pair');
  box.replaceChildren();
  const p = state.pairing;
  const row = (...buttons) => {
    const r = el('div', 'row');
    r.append(...buttons);
    return r;
  };
  const start = () => row(button(text.pair, () => act(state.role === 'pc' ? 'pair-start' : 'pair-search'), 'action primary'));

  // ordinateur : le pare-feu de Windows bloquerait le téléphone
  if (state.role === 'pc' && state.firewall === false && (p || state.devices.length)) {
    box.append(message('Le pare-feu de Windows empêche le téléphone de trouver cet ordinateur.', true),
      row(button('Autoriser dans le pare-feu', () => act('firewall'))));
  }

  switch (p?.step) {
    case 'waiting': // ordinateur : en attente du téléphone
      box.append(el('p', 'waiting', 'En attente du téléphone'),
        message('Sur le téléphone, dans le même Wi‑Fi : bouton ✨ › Synchroniser avec l\'ordinateur › Associer un ordinateur.'),
        row(button('Annuler', () => act('pair-cancel'))));
      break;
    case 'searching': // téléphone : recherche sur le réseau
      box.append(el('p', 'waiting', 'Recherche des ordinateurs sur le réseau'));
      break;
    case 'found': {
      const found = p.found || [];
      if (!found.length) {
        box.append(message('Aucun ordinateur trouvé. Sur l\'ordinateur : icône Hanabi près de l\'horloge › Synchroniser avec le téléphone › Associer un téléphone. Les deux appareils doivent être sur le même réseau.'));
      } else {
        box.append(message('Touchez l\'ordinateur à associer :'));
        for (const peer of found) {
          const b = button(peer.name, () => act('pair-choose', peer.id), 'peer');
          if (!peer.pairing) b.append(el('span', 'paired', 'association non ouverte'));
          box.append(b);
        }
      }
      box.append(row(button('Annuler', () => act('pair-cancel')), button('Chercher encore', () => act('pair-search'))));
      break;
    }
    case 'connecting':
      box.append(el('p', 'waiting', `Connexion à ${p.peer || 'l\'ordinateur'}`));
      break;
    case 'code':
      box.append(el('div', 'code', p.code.replace(/^(\d{3})/, '$1 ')));
      if (state.role === 'pc') {
        box.append(message(p.message || `Le téléphone « ${p.peer} » affiche-t-il le même code ?`));
        if (!p.accepted) box.append(row(button('Refuser', () => act('pair-refuse')), button('Associer', () => act('pair-accept'), 'action primary')));
      } else {
        box.append(message(p.message || `L'ordinateur « ${p.peer} » affiche-t-il le même code ?`));
        if (!p.accepted) box.append(row(button('Annuler', () => act('pair-cancel')), button('C\'est le même', () => act('pair-confirm'), 'action primary')));
        else box.append(el('p', 'waiting', 'Confirmez aussi sur l\'ordinateur'));
      }
      break;
    case 'done':
      box.append(message(p.message || 'Associé.'), start());
      break;
    case 'failed':
      box.append(message(p.message || 'L\'association a échoué.', true), start());
      break;
    default:
      box.append(start());
  }
}

// Sans réseau commun : l'ordinateur montre la liste de ses morceaux en QR code, le téléphone la scanne et
// retélécharge depuis YouTube ceux qui lui manquent
let qr = null;      // ordinateur : { total, youtube, codes: [{ image, count }] }
let qrPage = 0;

async function showQr() {
  qr = await sync.qrCodes();
  qrPage = 0;
  render();
  $('offline').scrollIntoView({ block: 'end', behavior: 'smooth' });
}

function renderOffline() {
  const box = $('offline');
  box.replaceChildren();
  const row = (...items) => {
    const r = el('div', 'row');
    r.append(...items);
    return r;
  };

  if (state.role === 'pc') {
    if (!qr) {
      box.append(message('Pas de réseau commun ? Le téléphone peut scanner la liste de vos morceaux et retélécharger depuis YouTube ceux qui lui manquent.'),
        row(button('Afficher le QR code', showQr)));
      return;
    }
    if (!qr.codes.length) {
      box.append(message('Aucun morceau ne vient de YouTube : il n\'y a rien à retélécharger.'), row(button('Fermer', () => { qr = null; render(); })));
      return;
    }
    const img = el('img', 'qr');
    img.src = qr.codes[qrPage].image;
    img.alt = 'QR code de la liste des morceaux';
    box.append(img);
    const left = qr.total - qr.youtube;
    box.append(message(`Sur le téléphone : ✨ › Synchroniser avec l'ordinateur › Scanner le QR code.${left > 0 ? ` ${plural(left, 'morceau')} sans lien YouTube ne ${left > 1 ? 'peuvent' : 'peut'} passer que par le Wi‑Fi.` : ''}`));
    const items = [];
    if (qr.codes.length > 1) {
      items.push(el('span', null, `Code ${qrPage + 1} sur ${qr.codes.length}`));
      items.push(button('Suivant', () => { qrPage = (qrPage + 1) % qr.codes.length; render(); }));
    }
    items.push(button('Fermer', () => { qr = null; render(); }));
    box.append(row(...items));
    return;
  }

  const o = state.offline;
  switch (o?.step) {
    case 'confirm':
      box.append(message(o.count
        ? `${plural(o.count, 'morceau')} à télécharger depuis YouTube, environ ${Math.max(1, Math.round(o.count * 3.5))} Mo de données.`
        : 'Le téléphone a déjà tous ces morceaux (ou vous les avez supprimés).'));
      box.append(row(button(o.count ? 'Annuler' : 'Fermer', () => act('qr-cancel')),
        ...(o.count ? [button('Télécharger', () => act('qr-download'), 'action primary')] : [])));
      break;
    case 'downloading':
      box.append(el('p', 'waiting', o.message || 'Téléchargement'), row(button('Arrêter', () => act('qr-cancel'))));
      break;
    case 'done':
    case 'failed':
      box.append(message(o.message, o.step === 'failed'), row(button('Scanner un QR code', () => act('qr-scan'))));
      break;
    default:
      box.append(message('Pas de réseau commun ? Sur l\'ordinateur, affichez le QR code de la liste (Synchroniser avec le téléphone › Afficher le QR code), puis scannez-le : les morceaux qui manquent ici sont retéléchargés depuis YouTube.'),
        row(button('Scanner le QR code', () => act('qr-scan'), 'action primary')));
  }
}

function renderStatus() {
  const a = state.activity;
  let status = '';
  if (a) {
    const counts = [a.received && plural(a.received, 'reçu'), a.sent && plural(a.sent, 'envoyé')].filter(Boolean).join(', ');
    status = a.step ? `${a.step}${counts ? ` (${counts})` : ''}` : `Synchronisation avec ${a.peer}${counts ? ` : ${counts}` : '…'}`;
  } else if (state.status) {
    status = state.status;
  }
  $('status').textContent = status;
  const now = $('sync-now');
  now.hidden = state.role !== 'phone' || !state.devices.length;
  now.disabled = !!a;
}

// ---------- Démarrage ----------

$('close').addEventListener('click', () => sync.close());
$('sync-now').addEventListener('click', () => act('sync-now'));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') sync.close();
});
sync.onUpdate(render);
sync.load().then(render);
// « il y a 5 min » avance tout seul
setInterval(render, 30000);
