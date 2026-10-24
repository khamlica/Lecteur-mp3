// Synchronisation avec le téléphone, sans serveur ni compte : sur le même réseau (Wi‑Fi, partage de connexion), le
// téléphone trouve l'ordinateur et vient chercher les morceaux qui lui manquent, et y dépose les siens. Rien n'est
// jamais supprimé ni remplacé, et un morceau qu'un appareil a déjà eu ne lui est plus renvoyé (supprimé exprès).
//
// L'ordinateur attend, le téléphone vient (android/…/Sync.kt) :
//   - découverte : le téléphone envoie « HANABI-DISCOVER 1 » en UDP (diffusion, port DISCOVERY_PORT), l'ordinateur
//     répond par son identifiant, son nom et son port ;
//   - tout le reste passe en HTTPS. Le certificat de l'ordinateur est fait ici, une fois : son empreinte (SHA-256 de
//     la clé publique) est son identifiant, que le téléphone épingle à l'association ;
//   - association : les deux appareils affichent un code à 6 chiffres, tiré des deux nonces et de l'empreinte vue
//     par le téléphone, et l'utilisateur confirme des deux côtés qu'ils sont identiques. Le téléphone s'engage sur
//     son nonce avant de connaître celui de l'ordinateur, et une seule tentative est possible à la fois : un appareil
//     qui s'intercalerait aurait une chance sur un million d'obtenir le même code des deux côtés. L'ordinateur remet
//     alors au téléphone un jeton secret, qu'il présente ensuite à chaque requête.
const crypto = require('crypto');
const dgram = require('dgram');
const https = require('https');
const os = require('os');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const qrcode = require('qrcode-generator');

const DISCOVERY_PORT = 47810;
const HTTPS_PORT = 47811;
const AUDIO = /\.(mp3|opus|m4a)$/i;
const MAX_UPLOAD = 400 * 1024 * 1024;
const PAIR_ATTEMPTS = 5;      // tentatives d'association par ouverture de la fenêtre
const PAIR_TIMEOUT = 120000;  // le temps de comparer les codes
const YOUTUBE_ID = /(?:[?&]v=|youtu\.be\/|\/shorts\/)([\w-]{11})/;
const QR_CHARS = 900;         // caractères par QR code : au-delà, le code devient trop fin pour un appareil photo

// ---------- Certificat (X.509 auto-signé, clé EC P-256), écrit à la main en DER ----------

function derLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (; n; n >>= 8) bytes.unshift(n & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const der = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
};
const derSeq = (...parts) => der(0x30, ...parts);
function derOid(dotted) {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const out = [40 * a + b];
  for (let v of rest) {
    const enc = [v & 0x7f];
    for (v = Math.floor(v / 128); v; v = Math.floor(v / 128)) enc.unshift(0x80 | (v & 0x7f));
    out.push(...enc);
  }
  return der(0x06, Buffer.from(out));
}
const derUtcTime = (date) => der(0x17, Buffer.from(date.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));
const ECDSA_SHA256 = derSeq(derOid('1.2.840.10045.4.3.2'));

function makeCertificate(privateKey, publicKey) {
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f; // entier positif
  const name = derSeq(der(0x31, derSeq(derOid('2.5.4.3'), der(0x0c, Buffer.from('Hanabi Player')))));
  const tbs = derSeq(
    der(0x02, serial),
    ECDSA_SHA256,
    name,
    derSeq(derUtcTime(new Date(Date.now() - 86400000)), der(0x17, Buffer.from('491231235959Z'))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const signature = crypto.sign('sha256', tbs, privateKey);
  const cert = derSeq(tbs, ECDSA_SHA256, der(0x03, Buffer.from([0]), signature));
  return `-----BEGIN CERTIFICATE-----\n${cert.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
}

const fingerprint = (publicKey) => crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
const sha256 = (data) => crypto.createHash('sha256').update(data).digest();

// Le code affiché des deux côtés (Sync.kt calcule le même)
function pairingCode(pcId, phoneId, phoneNonce, pcNonce) {
  const h = sha256(`hanabi-pair-1|${pcId}|${phoneId}|${phoneNonce}|${pcNonce}`);
  return String(h.readUInt32BE(0) % 1000000).padStart(6, '0');
}

// ---------- Identité d'un morceau ----------

// Le même morceau a le même identifiant sur les deux appareils (Library.trackId dans l'app Android) : la vidéo
// YouTube d'origine si le fichier la mentionne (yt-dlp l'écrit dans les commentaires Vorbis des .opus), sinon son nom
// de fichier. Le titre ou la pochette peuvent changer, l'identifiant reste.
let mm = null;
const idCache = new Map(); // chemin → { size, mtimeMs, id }

async function trackId(file) {
  let stat;
  try { stat = await fs.promises.stat(file); } catch { return null; }
  const cached = idCache.get(file);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.id;
  let id = null;
  if (/\.(opus|ogg)$/i.test(file)) {
    try {
      mm ??= await import('music-metadata');
      const { native } = await mm.parseFile(file, { duration: false, skipCovers: true });
      for (const tag of Object.values(native).flat()) {
        if (!/^(purl|comment)$/i.test(tag.id) || typeof tag.value !== 'string') continue;
        const m = YOUTUBE_ID.exec(tag.value);
        if (m) { id = `yt:${m[1]}`; break; }
      }
    } catch {}
  }
  id ??= nameId(path.basename(file));
  idCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, id });
  return id;
}

const nameId = (name) => `name:${name.normalize('NFC').toLowerCase()}`;

// Empreinte du contenu (SHA-256) : deux copies identiques ont la même ; un titre, un artiste ou une pochette
// modifiés la changent. Sert à repérer de quel côté un morceau a été modifié depuis la dernière synchronisation.
const hashCache = new Map(); // chemin → { size, mtimeMs, hash }

async function fileHash(file) {
  const stat = await fs.promises.stat(file);
  const cached = hashCache.get(file);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.hash;
  const hash = await new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (chunk) => h.update(chunk)).on('end', () => resolve(h.digest('hex')));
  });
  hashCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, hash });
  return hash;
}

async function titleArtist(file) {
  try {
    mm ??= await import('music-metadata');
    const { common } = await mm.parseFile(file, { duration: false, skipCovers: true });
    return { title: common.title || '', artist: common.artist || '' };
  } catch {
    return { title: '', artist: '' };
  }
}

// Chemin relatif reçu du téléphone → chemin dans le dossier de musique, ou null s'il en sortirait. Les caractères
// interdits par Windows (permis par Android) sont remplacés.
function safePath(folder, rel) {
  if (typeof rel !== 'string' || !AUDIO.test(rel)) return null;
  const parts = rel.split('/').map((p) => p.replace(/[<>:"\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, ''));
  if (parts.some((p) => !p || p === '.' || p === '..')) return null;
  const full = path.join(folder, ...parts);
  return full.toLowerCase().startsWith(path.resolve(folder).toLowerCase() + path.sep) ? full : null;
}

// ---------- Le service ----------

// deps : { dataDir, folder() (dossier de musique, créé au besoin), scan(dir) (comme scanFolder),
//          onChange(state) (fenêtre à rafraîchir), onLibraryChanged() (nouveaux morceaux arrivés),
//          busy(file) (morceau ouvert par le lecteur : pas remplacé maintenant), firewall (voir main.js, facultatif :
//          { check() → true | false | null, allow() → promesse }) }
function createSync(deps) {
  const storeFile = path.join(deps.dataDir, 'sync.json');
  let store = { phones: [], known: {} };
  try { store = { ...store, ...JSON.parse(fs.readFileSync(storeFile, 'utf8')) }; } catch {}

  if (!store.key || !store.cert) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    store.key = privateKey.export({ type: 'pkcs8', format: 'pem' });
    store.cert = makeCertificate(privateKey, publicKey);
    save();
  }
  const id = fingerprint(crypto.createPublicKey(store.key));
  const name = os.hostname();

  let server = null, udp = null, port = null;
  let pairing = null; // { attempts, session, step: 'waiting' | 'code' | 'done' | 'failed', message }
  let activity = null; // { phone, received, sent } : la synchronisation en cours
  let activityTimer = null;
  // le téléphone a pu perdre le réseau en cours de route : sans nouvelles, la synchronisation est finie
  function touch(phone, field) {
    if (activity?.phone !== phone) activity = { phone, received: 0, sent: 0 };
    if (field) activity[field]++;
    clearTimeout(activityTimer);
    activityTimer = setTimeout(() => { activity = null; changed(); }, 60000);
    changed();
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(storeFile), { recursive: true });
      fs.writeFileSync(storeFile + '.tmp', JSON.stringify(store, null, 2));
      fs.renameSync(storeFile + '.tmp', storeFile);
    } catch (err) {
      console.error('Synchronisation : enregistrement impossible :', err);
    }
  }

  // Morceaux déjà eus dans ce dossier (présents ou supprimés depuis)
  const knownKey = (folder) => path.resolve(folder).toLowerCase();
  function known(folder) {
    return new Set(store.known[knownKey(folder)] || []);
  }
  function remember(folder, ids) {
    const set = known(folder);
    const before = set.size;
    for (const i of ids) set.add(i);
    if (set.size !== before) {
      store.known[knownKey(folder)] = [...set];
      save();
    }
  }

  async function library() {
    const folder = deps.folder();
    const tracks = [];
    for (const t of await deps.scan(folder)) {
      const tid = await trackId(t.path);
      if (!tid) continue;
      let size = 0, hash = null;
      try {
        size = (await fs.promises.stat(t.path)).size;
        hash = await fileHash(t.path);
      } catch {
        continue; // disparu entre-temps
      }
      tracks.push({ id: tid, path: path.relative(folder, t.path).split(path.sep).join('/'), size, hash });
    }
    remember(folder, tracks.map((t) => t.id));
    return { folder, tracks };
  }

  // ---------- État, pour la fenêtre ----------

  function state() {
    return {
      role: 'pc',
      name,
      devices: store.phones.map((p) => ({ id: p.id, name: p.name, lastSync: p.lastSync || null, summary: p.summary || null })),
      pairing: pairing && {
        step: pairing.step,
        code: pairing.session?.code || null,
        peer: pairing.session?.phoneName || null,
        accepted: pairing.session?.accepted === true,
        message: pairing.message || null,
      },
      activity: activity && { peer: activity.phone.name, received: activity.received, sent: activity.sent },
      // false : le pare-feu de Windows bloquerait le téléphone (bouton « Autoriser » dans la fenêtre)
      firewall: firewallOk,
    };
  }
  const changed = () => deps.onChange(state());

  // Le téléphone se connecte à l'ordinateur : sans règle du pare-feu de Windows pour le lecteur, il ne le trouve
  // pas. Vérifié quand le serveur démarre ; la règle est ajoutée sur demande (une confirmation de Windows).
  let firewallOk = null;
  async function checkFirewall({ fix = false } = {}) {
    if (!deps.firewall) return;
    firewallOk = await deps.firewall.check().catch(() => null);
    // l'association vient d'être lancée : la règle est ajoutée aussitôt (Windows demande confirmation)
    if (firewallOk === false && fix) {
      await deps.firewall.allow().catch(() => {});
      firewallOk = await deps.firewall.check().catch(() => null);
    }
    changed();
  }

  // ---------- Réseau ----------

  // Le serveur n'écoute que s'il sert à quelque chose (un téléphone associé, ou une association en cours) : pas de
  // demande du pare-feu Windows pour qui n'utilise pas la synchronisation.
  function updateServer() {
    const needed = store.phones.length > 0 || !!pairing;
    if (needed && !server) {
      start();
      checkFirewall();
    } else if (!needed && server) stop();
  }

  function start() {
    server = https.createServer({ key: store.key, cert: store.cert, minVersion: 'TLSv1.2' }, (req, res) => {
      handle(req, res).catch((err) => {
        console.warn('Synchronisation :', err.message);
        if (!res.headersSent) send(res, 500, { error: err.message });
        else res.destroy();
      });
    });
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && port === HTTPS_PORT) {
        port = 0;
        server.listen(0, '0.0.0.0');
      } else console.warn('Synchronisation : serveur arrêté :', err.message);
    });
    server.on('listening', () => { port = server.address().port; });
    port = HTTPS_PORT;
    server.listen(HTTPS_PORT, '0.0.0.0');

    udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    udp.on('message', (msg, rinfo) => {
      if (msg.toString() !== 'HANABI-DISCOVER 1' || !port) return;
      const reply = JSON.stringify({ app: 'hanabi', v: 1, id, name, port, pairing: pairing?.step === 'waiting' });
      udp.send(reply, rinfo.port, rinfo.address);
    });
    udp.on('error', (err) => console.warn('Synchronisation : découverte impossible :', err.message));
    udp.bind(DISCOVERY_PORT);
  }

  function stop() {
    server?.close();
    server = null;
    try { udp?.close(); } catch {}
    udp = null;
    port = null;
  }

  function send(res, status, body) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': data.length });
    res.end(data);
  }

  async function readJson(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 64 * 1024) throw new Error('requête trop grosse');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  }

  function authenticate(req) {
    const token = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization || '')?.[1];
    if (!token) return null;
    const hash = sha256(Buffer.from(token, 'hex'));
    return store.phones.find((p) => crypto.timingSafeEqual(Buffer.from(p.tokenHash, 'hex'), hash)) || null;
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'https://hanabi');
    const route = `${req.method} ${url.pathname}`;

    if (route.startsWith('POST /pair/')) return pairRoute(url.pathname.slice(6), await readJson(req), res);

    const phone = authenticate(req);
    if (!phone) return send(res, 401, { error: 'appareil inconnu' });
    // le téléphone a pu changer de nom
    const named = req.headers['x-hanabi-name'];
    if (typeof named === 'string' && named && named.length < 80 && named !== phone.name) { phone.name = named; save(); }

    switch (route) {
      case 'GET /sync/library': {
        activity = null;
        touch(phone);
        const { folder, tracks } = await library();
        return send(res, 200, { id, name, tracks, known: [...known(folder)] });
      }
      case 'GET /sync/file': {
        const folder = deps.folder();
        const file = safePath(folder, url.searchParams.get('path'));
        let stat;
        try { stat = file && await fs.promises.stat(file); } catch {}
        if (!stat?.isFile()) return send(res, 404, { error: 'introuvable' });
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size });
        await new Promise((resolve, reject) => {
          fs.createReadStream(file).on('error', reject).pipe(res).on('finish', resolve).on('error', reject);
        });
        touch(phone, 'sent');
        return;
      }
      case 'PUT /sync/file': {
        const folder = deps.folder();
        const file = safePath(folder, url.searchParams.get('path'));
        const tid = url.searchParams.get('id');
        const length = Number(req.headers['content-length']);
        if (!file || !tid || !(length > 0) || length > MAX_UPLOAD) return send(res, 400, { error: 'fichier refusé' });
        // `replace` : le téléphone a modifié ce morceau (titre, pochette…) et le remplace, à condition que la copie
        // d'ici soit toujours celle qu'il a vue (empreinte) : une modification faite ici entre-temps n'est pas écrasée
        const replace = url.searchParams.get('replace');
        if (fs.existsSync(file)) {
          let current = null;
          if (replace) try { current = await fileHash(file); } catch {}
          if (!replace || current !== replace) {
            // sinon jamais remplacé : un fichier de ce nom est déjà là
            remember(folder, [tid]);
            req.resume();
            return send(res, 200, { skipped: true });
          }
          if (deps.busy?.(file)) {
            req.resume();
            return send(res, 409, { error: 'morceau ouvert dans le lecteur : remplacé à la prochaine synchronisation' });
          }
        }
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        const part = `${file}.part`;
        try {
          let written = 0;
          await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(part);
            req.on('data', (chunk) => { written += chunk.length; if (written > length) req.destroy(new Error('trop long')); });
            req.on('error', reject);
            req.pipe(out).on('finish', resolve).on('error', reject);
          });
          if (written !== length) throw new Error('fichier incomplet');
          await fs.promises.rename(part, file);
        } catch (err) {
          fs.promises.rm(part, { force: true }).catch(() => {});
          throw err;
        }
        remember(folder, [tid]);
        touch(phone, 'received');
        deps.onLibraryChanged();
        return send(res, 200, { ok: true });
      }
      case 'POST /sync/done': {
        const body = await readJson(req);
        phone.lastSync = Date.now();
        // le téléphone compte de son côté : ce qu'il a reçu, l'ordinateur l'a envoyé
        phone.summary = { received: Number(body.sent) || 0, sent: Number(body.received) || 0 };
        save();
        activity = null;
        clearTimeout(activityTimer);
        changed();
        return send(res, 200, { ok: true });
      }
    }
    send(res, 404, { error: 'inconnu' });
  }

  // ---------- Association ----------

  async function pairRoute(step, body, res) {
    const session = pairing?.session;
    switch (step) {
      case 'start': {
        if (pairing?.step !== 'waiting') return send(res, 403, { error: 'Ouvrez « Associer un téléphone » sur l\'ordinateur' });
        if (++pairing.attempts > PAIR_ATTEMPTS) {
          endPairing('failed', 'Trop de tentatives : recommencez l\'association');
          return send(res, 429, { error: 'trop de tentatives' });
        }
        if (!/^[0-9a-f]{64}$/.test(body.commit) || !/^[0-9a-f-]{8,64}$/.test(body.phoneId)) return send(res, 400, { error: 'requête invalide' });
        pairing.session = {
          key: crypto.randomBytes(16).toString('hex'),
          phoneId: body.phoneId,
          phoneName: String(body.name || 'Téléphone').slice(0, 60),
          commit: body.commit,
          nonce: crypto.randomBytes(32).toString('hex'),
          code: null,
          accepted: null,     // décision sur l'ordinateur
          waiting: null,      // réponse en attente du téléphone (il a confirmé de son côté)
        };
        return send(res, 200, { session: pairing.session.key, nonce: pairing.session.nonce, name });
      }
      case 'reveal': {
        if (!session || body.session !== session.key || session.code) return send(res, 409, { error: 'association expirée' });
        if (typeof body.nonce !== 'string' || sha256(body.nonce).toString('hex') !== session.commit) {
          endPairing('failed', 'Le téléphone a répondu de façon invalide');
          return send(res, 400, { error: 'engagement non tenu' });
        }
        session.code = pairingCode(id, session.phoneId, body.nonce, session.nonce);
        pairing.step = 'code';
        session.timer = setTimeout(() => endPairing('failed', 'Temps écoulé : recommencez l\'association'), PAIR_TIMEOUT);
        changed();
        return send(res, 200, { ok: true });
      }
      case 'confirm': {
        if (!session || body.session !== session.key || !session.code) return send(res, 409, { error: 'association expirée' });
        session.waiting = res;
        res.on('close', () => { if (session.waiting === res) session.waiting = null; });
        return settle();
      }
      case 'cancel': {
        if (session && body.session === session.key) endPairing('failed', 'Association annulée sur le téléphone');
        return send(res, 200, { ok: true });
      }
    }
    send(res, 404, { error: 'inconnu' });
  }

  // Les deux confirmations sont là : le téléphone reçoit son jeton
  function settle() {
    const session = pairing?.session;
    if (!session?.waiting || session.accepted === null) return;
    const res = session.waiting;
    session.waiting = null;
    if (!session.accepted) return send(res, 403, { error: 'refusé sur l\'ordinateur' });
    const token = crypto.randomBytes(32);
    store.phones = store.phones.filter((p) => p.id !== session.phoneId);
    store.phones.push({ id: session.phoneId, name: session.phoneName, tokenHash: sha256(token).toString('hex'), pairedAt: Date.now() });
    save();
    send(res, 200, { token: token.toString('hex'), id, name });
    endPairing('done', `« ${session.phoneName} » est associé`);
  }

  function endPairing(step, message) {
    if (!pairing) return;
    const session = pairing.session;
    if (session) {
      clearTimeout(session.timer);
      if (session.waiting) send(session.waiting, 403, { error: message });
    }
    pairing = { attempts: pairing.attempts, session: null, step, message };
    changed();
  }

  // ---------- Depuis la fenêtre ----------

  const actions = {
    // règle du pare-feu de Windows pour le lecteur (une confirmation de Windows)
    firewall: () => checkFirewall({ fix: true }),
    'pair-start': () => {
      pairing = { attempts: 0, session: null, step: 'waiting', message: null };
      updateServer();
      if (firewallOk !== true) checkFirewall({ fix: true });
    },
    'pair-accept': () => {
      if (!pairing?.session?.code) return;
      pairing.session.accepted = true;
      pairing.message = 'En attente de la confirmation sur le téléphone…';
      settle();
    },
    'pair-refuse': () => {
      if (pairing?.session) { pairing.session.accepted = false; settle(); }
      endPairing('failed', 'Association refusée');
    },
    'pair-cancel': () => {
      if (pairing?.session) { pairing.session.accepted = false; settle(); }
      pairing = null;
      updateServer();
    },
    forget: (phoneId) => {
      store.phones = store.phones.filter((p) => p.id !== phoneId);
      save();
      updateServer();
    },
  };

  // Sans réseau commun : la liste des vidéos YouTube d'origine, avec le titre et l'artiste d'ici, en QR codes à scanner
  // avec le téléphone, qui retélécharge celles qui lui manquent (Sync.kt, scanned). « HANABI2|page/pages|données »,
  // les données : lignes « id⇥titre⇥artiste », compressées (deflate) puis en base64url (que des caractères ASCII :
  // les titres coréens ou japonais passent sans souci d'encodage).
  async function qrCodes() {
    const { folder, tracks } = await library();
    const seen = new Set();
    const lines = [];
    for (const t of tracks) {
      if (!t.id.startsWith('yt:') || seen.has(t.id)) continue;
      seen.add(t.id);
      const { title, artist } = await titleArtist(path.join(folder, ...t.path.split('/')));
      const clean = (v) => v.replace(/[\t\n\r]+/g, ' ').trim();
      lines.push([t.id.slice(3), clean(title), clean(artist)].join('\t'));
    }
    const encode = (list) => zlib.deflateRawSync(Buffer.from(list.join('\n'))).toString('base64url');
    const pages = [];
    let page = [];
    for (const line of lines) {
      if (page.length && encode([...page, line]).length > QR_CHARS) {
        pages.push(page);
        page = [];
      }
      page.push(line);
    }
    if (page.length) pages.push(page);
    return {
      total: tracks.length,
      youtube: lines.length,
      codes: pages.map((list, i) => {
        const text = `HANABI2|${i + 1}/${pages.length}|${encode(list)}`;
        const qr = qrcode(0, 'L');
        qr.addData(text);
        qr.make();
        // en SVG : net à toute taille
        const svg = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
        return { image: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, text, count: list.length };
      }),
    };
  }

  updateServer();

  return {
    state,
    qrCodes,
    action(name, arg) {
      actions[name]?.(arg);
      changed();
      return state();
    },
    // la fenêtre se ferme : une association en cours s'arrête
    windowClosed() {
      if (pairing) actions['pair-cancel']();
    },
    stop,
  };
}

module.exports = { createSync, makeCertificate, fingerprint, pairingCode, trackId, safePath };
