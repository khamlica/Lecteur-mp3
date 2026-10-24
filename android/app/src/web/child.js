// Les fenêtres du bureau (menu.html, fx-panel.html, editor.html) ouvertes dans un panneau du lecteur (host.js) : leur
// pont vers le lecteur, à la place des preload d'Electron. Ajouté à ces pages par la build (build.gradle.kts).
(() => {
  const host = parent.hanabiHost;
  const page = location.pathname.slice(location.pathname.lastIndexOf('/') + 1);
  document.documentElement.classList.add('android', `android-${page.replace('.html', '')}`);
  if (page === 'menu.html') window.menu = host.menuApi(window);
  else if (page === 'fx-panel.html') window.fxPanel = host.fxPanelApi(window);
  else if (page === 'editor.html') window.editor = host.editorApi(window);
  // pas de souris ni de glisser-déposer : on touche la pochette pour choisir une image
  if (page === 'editor.html') {
    addEventListener('DOMContentLoaded', () => {
      const hint = document.querySelector('#art .hint');
      if (hint) hint.textContent = 'Toucher pour choisir une image';
    });
  }
  // marges des barres du système, comme dans le lecteur
  const root = parent.document.documentElement.style;
  for (const side of ['top', 'bottom', 'left', 'right']) document.documentElement.style.setProperty(`--inset-${side}`, root.getPropertyValue(`--inset-${side}`) || '0px');
})();
