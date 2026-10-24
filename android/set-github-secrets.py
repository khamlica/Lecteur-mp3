# Enregistre la clé de signature de l'APK (release.jks, keystore.properties) dans les secrets GitHub Actions du
# dépôt, pour que .github/workflows/release.yml signe l'APK publié avec elle. À lancer une fois (ou après avoir
# changé de clé), depuis android/ :
#   pip install pynacl
#   python set-github-secrets.py
# Le jeton GitHub est celui de git (git credential fill) ; il doit avoir le droit « repo ».
import base64
import json
import subprocess
import urllib.request

from nacl import encoding, public

REPO = 'khamlica/Lecteur-mp3'

cred = subprocess.run(['git', 'credential', 'fill'], input='protocol=https\nhost=github.com\n\n',
                      capture_output=True, text=True, check=True).stdout
token = next(line.split('=', 1)[1] for line in cred.splitlines() if line.startswith('password='))


def api(path, data=None, method='GET'):
    request = urllib.request.Request(f'https://api.github.com/repos/{REPO}{path}', method=method,
                                     data=json.dumps(data).encode() if data else None,
                                     headers={'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json'})
    with urllib.request.urlopen(request) as response:
        body = response.read()
        return json.loads(body) if body else {}


key = api('/actions/secrets/public-key')
box = public.SealedBox(public.PublicKey(key['key'].encode(), encoding.Base64Encoder()))
props = dict(line.split('=', 1) for line in open('keystore.properties').read().splitlines() if '=' in line)
secrets = {
    'ANDROID_KEYSTORE': base64.b64encode(open(props['storeFile'], 'rb').read()).decode(),
    'ANDROID_KEYSTORE_PASSWORD': props['storePassword'],
}
for name, value in secrets.items():
    api(f'/actions/secrets/{name}', {'encrypted_value': base64.b64encode(box.encrypt(value.encode())).decode(),
                                     'key_id': key['key_id']}, 'PUT')
    print('enregistré :', name)
