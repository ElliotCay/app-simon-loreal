# Spy Rush — serveur autonome

Jeu HTML/CSS/JS sans compilation, API Python et base SQLite sur le même serveur. Aucun compte Supabase, aucune clé API. Tous les navigateurs utilisent la même base du VPS.

## Démarrer en local

Python 3.10 ou plus récent, avec SQLite 3.25 ou plus récent :

```sh
python3 server.py
```

Ouvrir http://127.0.0.1:8000. **Remplace l’ancien `python3 -m http.server`**, qui ne fournit pas l’API. Le serveur crée automatiquement `data/spy-rush.sqlite3`. `HOST`, `PORT` et `SPY_DB_PATH` permettent de changer l’écoute ou le fichier de base. `RETENTION_DAYS` fixe la durée de conservation des parties.

## Parties, identité et classement

- Le joueur saisit son **prénom et son nom** avant de jouer ; ils sont mémorisés dans le navigateur. Aucun e-mail, matricule, équipe ou autre champ personnel n’est demandé, et l’API refuse tout champ supplémentaire.
- Le classement affiche **une ligne par joueur, avec son meilleur score**. Un joueur est identifié par son prénom et son nom, sans tenir compte de la casse ni des accents : « Élodie Dupont » sur téléphone et « elodie dupont » sur ordinateur partagent la même ligne. À égalité, le premier à avoir atteint le score passe devant.
- En fin de partie, le joueur voit son score, son record, son rang et l’écart avec la place suivante.
- La ligne du joueur est surlignée et porte « Vous » lorsqu’au moins une de ses parties vient de ce navigateur. Le navigateur est reconnu par un jeton aléatoire dans un cookie HttpOnly, SameSite=Lax, conservé un an et Secure sous HTTPS ; la base n’en conserve que l’empreinte.
- Le nom n’est pas vérifié : rien n’empêche de jouer sous le nom d’un collègue. Pour l’empêcher, il faudrait une authentification (SSO).
- Si l’envoi du score échoue, l’écran de fin propose de le renvoyer ; renvoyer la même partie ne crée pas de doublon. Si le serveur est injoignable au lancement, la partie se joue quand même, **hors classement**.
- La page Classement se rafraîchit toutes les 15 secondes, au retour sur la page et avec « Actualiser ».

### Scores vérifiés par le serveur

Le navigateur ne transmet jamais de score. À chaque partie, le serveur tire la séquence de cibles (`POST /api/games`) et la conserve. En fin de partie, le navigateur envoie la liste des clics (numéro de cible, instant en millisecondes). Le serveur rejoue la partie et calcule lui-même le score. Il refuse une partie rendue avant la fin de ses 30 secondes ou plus d’une heure après son lancement, un clic sur une cible qui n’était pas affichée à cet instant, une cible cliquée deux fois, ou une partie lancée depuis un autre navigateur.

Ce contrôle borne les scores à ce qu’une partie parfaite permet. Il n’empêche pas un programme de jouer à la place d’un humain, et il ne limite pas le nombre de requêtes : pour un usage exposé, ajouter une limitation de débit dans Nginx (`limit_req`).

Les règles existent en deux exemplaires, `DIFFICULTY` et `types` dans `game.js`, `RULES` et `POINTS` dans `server.py`. Un test vérifie qu’ils concordent.

## Données personnelles (RGPD)

Ce que l’application fait d’elle-même :

- **Minimisation.** Seuls le prénom, le nom et les résultats des parties sont enregistrés. Le classement public n’expose ni date ni identifiant.
- **Information.** Le formulaire renvoie vers `confidentialite.html`, qui décrit les données, leur usage, leur durée de conservation et les droits des joueurs.
- **Durée de conservation.** Chaque partie est supprimée automatiquement `RETENTION_DAYS` jours après avoir été jouée (365 par défaut). La purge s’exécute au plus une fois par heure, au lancement d’une partie.
- **Effacement.** Le bouton « Supprimer mes données » de la page Données efface les parties enregistrées depuis le navigateur, son identifiant et son cookie (`DELETE /api/scores`). Pour effacer un joueur sans passer par son navigateur : `DELETE FROM scores WHERE name_key='prenom nom';` sur la base (clé en minuscules, sans accents).
- **Aucun tiers.** Polices servies par l’application, aucune mesure d’audience. Le cookie et le stockage local sont strictement nécessaires au jeu et ne demandent pas de bandeau de consentement.

Ce qui reste à la charge de l’organisateur avant l’ouverture :

1. Renseigner dans `deploy/spy-rush.service` le responsable du traitement (`PRIVACY_CONTROLLER`), le contact pour l’exercice des droits (`PRIVACY_CONTACT`) et la base légale (`PRIVACY_LEGAL_BASIS`). Ces valeurs s’affichent sur la page Données ; elles ne figurent pas dans le dépôt pour que le nom de l’entreprise n’y apparaisse pas. Sans elles, la page indique « l’organisateur du jeu ».
2. Faire valider la base légale et la durée de conservation par le DPO, et inscrire le traitement au registre.
3. Décider qui peut voir le classement. Il affiche des prénoms et des noms à toute personne qui connaît l’URL : `noindex` n’est pas une restriction d’accès. Si le jeu est réservé aux salariés, restreindre l’accès au niveau du réseau ou de Nginx.
4. Régler la conservation des journaux Nginx, qui contiennent des adresses IP.
5. **À la fermeture du jeu, le 3 décembre 2026**, supprimer les données : c’est l’engagement affiché en pied de page. `RETENTION_DAYS` n’est qu’un filet de sécurité et ne le fait pas à cette date. Arrêter le service puis supprimer la base : `sudo systemctl disable --now spy-rush && sudo rm /var/lib/spy-rush/spy-rush.sqlite3*`, ainsi que ses sauvegardes.

Les parties de l’ancienne table `attempts` (pseudos, scores non vérifiés) ne sont plus affichées. Elles restent soumises à la durée de conservation et à l’effacement. Pour les supprimer tout de suite : `DROP TABLE attempts;`.

## Déployer sur un VPS Linux

Architecture : **HTTPS / Nginx → Gunicorn → API Python → SQLite sur disque local**. La même application sert les fichiers publics et `/api/*`. Le fichier SQLite, le code serveur et les fichiers de déploiement ne sont pas exposés par HTTP.

1. Copier le projet dans `/opt/spy-rush` sur le VPS (sans `.git`, `.venv`, `__pycache__`, ni base de test).
2. Installer Python, son module venv et Nginx avec le gestionnaire de paquets du VPS. Créer un utilisateur système dédié et l’environnement Python :

```sh
sudo useradd --system --home /opt/spy-rush --shell /usr/sbin/nologin spy-rush
cd /opt/spy-rush
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

3. Adapter `deploy/spy-rush.service` : remplacer `https://jeu.example.com` par l’origine HTTPS exacte du jeu (sans slash final), avec un nom de domaine sans mention explicite de l’entreprise. Copier et démarrer le service :

```sh
sudo cp deploy/spy-rush.service /etc/systemd/system/spy-rush.service
sudo systemctl daemon-reload
sudo systemctl enable --now spy-rush
```

Systemd crée `/var/lib/spy-rush`, réservé au service, et la base y est conservée indépendamment des mises à jour du code. Le serveur n’écoute que sur `127.0.0.1:8000`. Les deux processus et leurs quatre threads partagent le même fichier SQLite.

4. Dans le bloc HTTPS Nginx de votre domaine, ajouter le contenu de `deploy/nginx.conf`. Configurer le certificat TLS selon votre installation, puis valider et recharger Nginx :

```sh
sudo nginx -t
sudo systemctl reload nginx
```

Le jeu doit être servi à la racine du domaine. Ne pas exposer directement le port 8000, et ne pas configurer Nginx pour servir tout le dossier du projet. Pour diagnostiquer : `sudo journalctl -u spy-rush -f`.

### Concurrence et sauvegardes

SQLite utilise le mode WAL et une connexion par requête, avec un délai d’attente de verrou de 10 secondes. Les transactions d’écriture sont courtes. Les lectures peuvent coexister avec une écriture ; SQLite sérialise les écritures. Cela convient à plusieurs joueurs sur **un VPS**. Garder la base sur un disque local, pas sur NFS ni répartie entre plusieurs serveurs. Voir la [documentation SQLite WAL](https://www.sqlite.org/wal.html) et les [réglages Gunicorn](https://docs.gunicorn.org/en/stable/settings.html).

Sauvegarder avec l’API de sauvegarde SQLite, pas avec une copie isolée du fichier ouvert :

```sh
sudo -u spy-rush python3 -c "import sqlite3; src=sqlite3.connect('/var/lib/spy-rush/spy-rush.sqlite3'); dst=sqlite3.connect('/var/lib/spy-rush/backup.sqlite3'); src.backup(dst); dst.close(); src.close()"
```

Copier ensuite cette sauvegarde vers votre stockage de sauvegarde. Pour restaurer : arrêter le service, mettre de côté les fichiers actuels de base et journaux, restaurer la sauvegarde avec les droits du compte `spy-rush`, puis redémarrer.

Le classement est recalculé à chaque affichage à partir de toutes les parties conservées. Pour des centaines de milliers de parties, prévoir un chargement progressif et mesurer la charge. Aucun débit maximal n’est garanti sans test sur votre VPS.

## API

- `POST /api/session` avec `{}` : crée ou retrouve l’identité du navigateur.
- `POST /api/games` avec `{}` : lance une partie. Cookie requis. Renvoie `{ "game_id": "UUID", "targets": [[apparition_ms, durée_ms, type], …] }`.
- `POST /api/scores` avec `{ "name": "Prénom Nom", "game_id": "UUID", "hits": [[cible, instant_ms], …] }` : enregistre la partie. Renvoie `score`, `good`, `errors`, `best`, `new_best`, `rank`, `players` et `gap` (écart avec la place au-dessus, `null` pour le premier). Renvoyer la même partie renvoie le résultat existant ; sous un autre nom, 409.
- `GET /api/scores` : le classement, `[{ "name", "score", "is_mine" }]`, meilleur score de chaque joueur.
- `DELETE /api/scores` : efface les parties et l’identifiant du navigateur.
- `GET /api/privacy` : responsable, contact, base légale et durée de conservation affichés sur la page Données.

Les requêtes utilisent la même origine ; `POST` et `DELETE` vérifient l’en-tête `Origin`. Le serveur valide le JSON, la taille des requêtes (4 ko) et le nom : prénom et nom, 3 à 40 caractères, lettres séparées par une espace, un tiret ou une apostrophe.

## Jeu et vérifications

Badge, porte fermée et téléphone d’urgence : +100 ; sans badge et porte ouverte : −150 ; voleur : −200. Tous les 4 bons clics d’affilée, le multiplicateur monte d’un cran, jusqu’à ×5 ; une erreur le ramène à ×1. Une cible ignorée ne coûte rien et n’interrompt pas la série. Chaque partie commence par un décompte de trois temps.

En jeu, le plateau occupe tout l’écran : 3 × 4 cases sur téléphone, 4 × 3 sur ordinateur, 6 × 2 sur téléphone en paysage. Les cibles réagissent dès le contact du doigt. Le son se coupe depuis la barre du haut.

Réglages dans `DIFFICULTY` en haut de `game.js`, à reporter dans `server.py`. `?debug=1` active les traces toutes les 5 secondes et les fonctions de diagnostic. Le chrono ne se met pas en pause quand l’onglet est masqué.

```sh
python3 -m unittest discover -s tests -p 'test_*.py' -v
node tests/logic.cjs
```

Les tests couvrent les règles et le combo des deux côtés, le recalcul du score et le refus des parties impossibles, le meilleur score par joueur, les réessais et 64 enregistrements concurrents, l’effacement, la durée de conservation, la validation des noms et l’inaccessibilité des fichiers privés.

## Identité visuelle

Monogramme OA générique dans `assets/oa-logo.svg`, sans nom ni logo du groupe sur les pages publiques. Palette monochrome, avec deux couleurs fonctionnelles : vert clair (`--accent-good`) pour le détail qui rend une cible sûre (badge, cadenas, étiquette d’urgence) et pour les gains, rouge pour les erreurs. Les six cibles sont dessinées en SVG dans `sprites.js`.

Les polices Barlow Condensed et DM Sans (licence SIL OFL, voir `assets/fonts/OFL.txt`) sont servies par l’application depuis `assets/fonts/`. Aucune ressource n’est chargée depuis un service tiers : l’adresse IP des joueurs n’est transmise à personne d’autre que le serveur du jeu.

## Préparation à la validation cybersécurité

- `index.html`, `classement.html` et `confidentialite.html` contiennent `<meta name="robots" content="noindex, nofollow">` immédiatement après `<head>`.
- `robots.txt` est à la racine du projet, avec le contenu fourni :

```text
User-agent: *
Disallow: /
```

Le serveur Python expose ce fichier à `/robots.txt`, également via le proxy Nginx existant. Il n’y a pas de dossier `www/` dans cette architecture : la racine HTTP est servie par l’application. Si un hébergement statique avec un dossier `www/` est utilisé, copier `robots.txt` à la racine de ce dossier.

- Toutes les réponses de l’application, y compris celles de l’API, portent aussi l’en-tête `X-Robots-Tag: noindex, nofollow`.
- Les directives anti-indexation sont des consignes pour les moteurs de recherche, pas une restriction d’accès. Le site reste accessible à toute personne qui connaît son URL.

Après déploiement, vérifier `/robots.txt` et l’en-tête HTTP, puis suivre les étapes externes :

1. Installer un domaine sans mention explicite de l’entreprise et configurer son DNS, son certificat TLS et `PUBLIC_ORIGIN`.
2. Refaire la demande d’accès au site dans My Services avec l’URL finale.
3. Faire réaliser le scan de vulnérabilités par la cybersécurité et traiter ses éventuels résultats avant l’ouverture officielle.
4. Coordonner la coupure temporaire du service jusqu’à sa mise à disposition officielle, selon la décision de l’équipe responsable.

Ces démarches nécessitent les accès au domaine, au serveur ou aux services internes. Les changements du dépôt ne déploient pas l’application et ne réalisent ni la demande My Services, ni le scan, ni l’arrêt du service.
