// Fenêtre-cadre (voir frame.css) : l'image du contour, et le reflet que le lecteur anime.
const el = document.getElementById('frame');

frame.onSkin((skin) => {
  el.style.setProperty('--frame-img', `url("skins/${skin}-frame.png")`);
  el.style.setProperty('--frame-mask', `url("skins/${skin}-mask.png")`);
});

frame.onFx(({ rim, angle, glint }) => {
  el.style.setProperty('--fx-rim', rim);
  el.style.setProperty('--fx-rim-angle', `${angle}deg`);
  el.style.setProperty('--fx-glint', glint);
});
