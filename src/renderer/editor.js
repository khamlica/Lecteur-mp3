const $ = (id) => document.getElementById(id);

const ui = {
  art: $('art'),
  artImg: $('art-img'),
  artFile: $('art-file'),
  title: $('title-input'),
  artist: $('artist-input'),
  fileName: $('file-name'),
  status: $('status'),
  save: $('save'),
};

let original = { title: '', artist: '' }; // valeurs lues dans le fichier
let newCover = null; // JPEG choisi mais pas encore enregistré
let previewUrl = null;
let saving = false;

function setStatus(text, error = false) {
  ui.status.textContent = text;
  ui.status.title = text;
  ui.status.classList.toggle('error', error);
}

function showCover(src) {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = src && src.startsWith('blob:') ? src : null;
  ui.artImg.hidden = !src;
  if (src) ui.artImg.src = src;
  else ui.artImg.removeAttribute('src');
}

async function load() {
  const data = await editor.load();
  original = { title: data.title || '', artist: data.artist || '' };
  newCover = null;
  ui.title.value = original.title;
  ui.title.placeholder = data.name; // sans titre, le lecteur affiche le nom du fichier
  ui.artist.value = original.artist;
  ui.artist.placeholder = 'Artiste inconnu';
  ui.fileName.textContent = data.name;
  ui.fileName.title = data.file;
  showCover(data.cover);
  setStatus('');
  ui.title.focus();
}

async function useImage(blob) {
  if (!blob || saving) return;
  try {
    newCover = await squareCover(blob);
  } catch {
    return setStatus('Image illisible', true);
  }
  showCover(URL.createObjectURL(new Blob([newCover], { type: 'image/jpeg' })));
  setStatus('Nouvelle pochette');
}

async function save() {
  if (saving) return;
  const changes = {};
  const title = ui.title.value.trim();
  const artist = ui.artist.value.trim();
  if (title !== original.title) changes.title = title;
  if (artist !== original.artist) changes.artist = artist;
  if (newCover) changes.cover = newCover;
  if (!Object.keys(changes).length) return editor.close();

  saving = true;
  ui.save.disabled = true;
  setStatus('Enregistrement…');
  const result = await editor.save(changes);
  saving = false;
  ui.save.disabled = false;
  if (result.error) return setStatus(result.error, true);
  editor.close();
}

// ---------- Interface ----------

ui.art.addEventListener('click', () => ui.artFile.click());
ui.artFile.addEventListener('change', () => {
  useImage(ui.artFile.files[0]);
  ui.artFile.value = '';
});

// Coller une image (où que soit le curseur) remplace la pochette ; le texte se colle normalement.
document.addEventListener('paste', (e) => {
  const image = imageFrom(e.clipboardData);
  if (!image) return;
  e.preventDefault();
  useImage(image);
});

// Glisser-déposer d'une image sur la fenêtre
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  ui.art.classList.add('dragover');
});
document.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) ui.art.classList.remove('dragover');
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  ui.art.classList.remove('dragover');
  const image = imageFrom(e.dataTransfer);
  if (image) useImage(image);
  else setStatus('Ce n\'est pas une image', true);
});

$('save').addEventListener('click', save);
$('cancel').addEventListener('click', () => editor.close());
$('close').addEventListener('click', () => editor.close());

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') editor.close();
  else if (e.key === 'Enter' && e.target instanceof HTMLInputElement) save();
});

editor.onReload(load);
load();
