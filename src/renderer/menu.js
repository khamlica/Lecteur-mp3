// Menu en verre (voir popupGlassMenu dans main.js) : les rangées viennent du processus principal, un clic
// renvoie leur numéro. Une rangée « liste » (l'effet sonore) ouvre ses choix dans le même menu, avec un
// retour ; la fenêtre prend la hauteur de ce qui est affiché. Flèches haut/bas pour se déplacer, Entrée pour
// choisir, flèche gauche ou Échap pour revenir ou fermer.
const root = document.getElementById('menu');
const pages = []; // pages ouvertes : la première est le menu lui-même

function row(className, label, extra = null) {
  const button = document.createElement('button');
  button.className = `item ${className}`;
  const mark = Object.assign(document.createElement('span'), { className: 'mark' });
  button.append(mark, Object.assign(document.createElement('span'), { className: 'label', textContent: label }));
  if (extra) button.append(extra);
  button.addEventListener('mouseenter', () => button.focus({ preventScroll: true }));
  return button;
}

function show(items, title = null) {
  root.replaceChildren();
  if (title) {
    const back = row('back', title);
    back.querySelector('.mark').innerHTML = '<svg><use href="#i-back"/></svg>';
    back.addEventListener('click', goBack);
    root.append(back, Object.assign(document.createElement('div'), { className: 'sep' }));
  }
  for (const item of items) {
    if (item.type === 'separator') {
      root.append(Object.assign(document.createElement('div'), { className: 'sep' }));
      continue;
    }
    if (item.type === 'header') {
      root.append(Object.assign(document.createElement('div'), { className: 'header', textContent: item.label }));
      continue;
    }
    if (item.type === 'submenu') {
      const value = Object.assign(document.createElement('span'), { className: 'value', textContent: item.value });
      const chevron = Object.assign(document.createElement('span'), { className: 'chevron', innerHTML: '<svg><use href="#i-chevron"/></svg>' });
      const button = row('submenu', item.label, value);
      button.append(chevron);
      button.addEventListener('click', () => open(item));
      root.append(button);
      continue;
    }
    const button = row(`${item.type}${item.checked ? ' checked' : ''}`, item.label);
    button.disabled = !item.enabled;
    button.setAttribute('role', item.type === 'checkbox' ? 'menuitemcheckbox' : item.type === 'radio' ? 'menuitemradio' : 'menuitem');
    if (item.type !== 'normal') button.setAttribute('aria-checked', String(item.checked));
    if (item.type === 'checkbox' && item.checked) button.querySelector('.mark').innerHTML = '<svg><use href="#i-check"/></svg>';
    button.addEventListener('click', () => menu.click(item.id));
    root.append(button);
  }
  menu.resize(Math.ceil(root.getBoundingClientRect().height));
  // un sous-menu s'affiche depuis son début (sur le téléphone, un long menu défile dans sa feuille)
  document.scrollingElement.scrollTop = 0;
  root.querySelector('.item:not(:disabled)')?.focus({ preventScroll: true });
}

function open(item) {
  pages.push(item);
  show(item.items, item.label);
}

function goBack() {
  pages.pop();
  const page = pages[pages.length - 1];
  show(page.items, pages.length > 1 ? page.label : null);
}

menu.items().then((items) => {
  pages.push({ items });
  show(items);
});

document.addEventListener('keydown', (e) => {
  const buttons = [...root.querySelectorAll('.item:not(:disabled)')];
  const at = buttons.indexOf(document.activeElement);
  if (e.key === 'Escape' || e.key === 'ArrowLeft') {
    if (pages.length > 1) goBack();
    else if (e.key === 'Escape') menu.close();
  } else if (e.key === 'ArrowRight' && document.activeElement?.classList.contains('submenu')) {
    document.activeElement.click();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const step = e.key === 'ArrowDown' ? 1 : -1;
    buttons[(at + step + buttons.length) % buttons.length]?.focus();
  }
});
