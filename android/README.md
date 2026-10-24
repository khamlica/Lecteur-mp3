# Hanabi Player pour Android

Le lecteur de bureau, sur le téléphone. L'interface et les effets sont ceux de `src/renderer`, recopiés à chaque
build. La barre flottante du bureau devient un widget de l'écran d'accueil.

## Comment c'est fait

- **La page du lecteur** : `app/src/web/player.html`, la barre du bureau dépliée en plein écran. Elle utilise le même
  `renderer.js`, les mêmes effets et le même son. `host.js` y remplace le processus principal d'Electron
  (`main.js`) : réglages, menus, fenêtres de réglages ouvertes dans un panneau. Les fenêtres du bureau (menu,
  effets, édition) y sont chargées telles quelles, avec leur pont `child.js`.
- **`PlayerService`** : la page vit dans ce service, pas dans l'écran de l'app. La musique continue écran éteint ou
  app fermée, et la notification, l'écran verrouillé, le widget et les boutons du casque la pilotent.
- **YouTube** : yt-dlp aux mêmes réglages que sur le bureau, avec Python, QuickJS et ffmpeg (youtubedl-android). Le
  même nettoyage suit : SponsorBlock, silences, et la recherche iTunes du titre et de la pochette (`Youtube.kt`).
  yt-dlp se met à jour tout seul une fois par jour.
- **Fichiers** : l'app demande l'« accès à tous les fichiers ». Comme sur l'ordinateur, elle lit les dossiers de
  musique, réécrit les tags et télécharge dans Musique/YouTube.

## Construire

```
cd android
./gradlew assembleDebug      # app/build/outputs/apk/debug (téléphone et émulateur)
./gradlew assembleRelease    # app/build/outputs/apk/release (téléphones arm64), signé avec release.jks
```

Il faut le JDK 21 et le SDK Android (`local.properties` : `sdk.dir=…`).

## Publier

`npm run release` publie aussi l'APK. L'étiquette lance `.github/workflows/release.yml`, qui construit l'APK et le
dépose dans la Release, à côté de l'installeur Windows. Les téléphones le trouvent tout seuls, toutes les 6 h, et
proposent de l'installer.

Cette étape a besoin de deux secrets GitHub, `ANDROID_KEYSTORE` et `ANDROID_KEYSTORE_PASSWORD`. Pour les
enregistrer : `python set-github-secrets.py`.

**La clé `release.jks` et `keystore.properties` ne sont pas dans le dépôt : il faut les sauvegarder.** Un APK signé
avec une autre clé ne peut pas remplacer l'app déjà installée. Il faudrait la désinstaller et perdre ses réglages.
