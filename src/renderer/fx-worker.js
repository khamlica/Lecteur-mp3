// Pré-analyse d'un morceau hors du fil de l'interface (voir analyseTrackOffThread dans effects.js) :
// séparation harmonique/percussive, contour de la mélodie et chronologie des effets prennent
// plusieurs secondes et feraient saccader l'affichage.
importScripts('fx-perc-model.js', 'fx-voice-model.js', 'effects.js'); // modèle des percussions : seule la pré-analyse s'en sert

onmessage = async ({ data }) => {
  try {
    const profile = await analyseSamples(data.channels, data.duration, null, data.options);
    // les tableaux de la chronologie repartent sans copie
    const buffers = profile ? [...Object.values(profile.timeline), profile.flux].map((a) => a.buffer) : [];
    postMessage({ profile }, buffers);
  } catch (err) {
    // sans réponse, la page attendrait indéfiniment et n'analyserait plus aucun morceau
    postMessage({ error: String(err?.stack || err) });
  }
};
