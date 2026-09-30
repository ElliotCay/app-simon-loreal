# Spy Rush — serveur autonome

Jeu HTML/CSS/JS sans compilation, API Python et base SQLite sur le même serveur. Aucun compte Supabase, aucune clé API. Tous les navigateurs utilisent la même base du VPS.

## Démarrer en local

Python 3.10 ou plus récent :

```sh
python3 server.py
```

Ouvrir http://127.0.0.1:8000. **Remplace l’ancien `python3 -m http.server`**, qui ne fournit pas l’API. Le serveur crée automatiquement `data/spy-rush.sqlite3`. `HOST`, `PORT` et `SPY_DB_PATH` permettent de changer l’écoute ou le fichier de base.

## Parties, identité et classement

- Seul un pseudo est demandé avant de jouer et mémorisé dans le navigateur. Si le joueur choisit son identité réelle, elle doit se limiter au prénom et au nom. Aucun e-mail, matricule, équipe ou autre champ personnel n’est demandé ; les champs supplémentaires envoyés à l’API de scores sont refusés.
- Chaque partie terminée est enregistrée automatiquement dans SQLite, même si le score est inférieur au record ou négatif.
- Les classements de fin de partie et de la page `classement.html` affichent **toutes les tentatives**, triées par score décroissant, puis date et identifiant croissants. Aucun regroupement par pseudo, aucune limite de 10.
- La page Classement se rafraîchit toutes les 15 secondes, au retour sur la page et avec « Actualiser ». La fin de partie rafraîchit son classement après l’enregistrement.
- Les lignes du joueur sont surlignées et portent « Vous ». L’identité est un jeton aléatoire dans un cookie HttpOnly, SameSite=Lax, conservé pendant un an et Secure sous HTTPS ; la base conserve uniquement son empreinte. Le pseudo ne sert pas d’identifiant : deux joueurs homonymes restent distincts.
- L’identité est propre au navigateur. Effacer le cookie ou changer d’appareil crée une nouvelle identité ; les anciennes tentatives restent visibles. Pour partager des identités entre appareils, il faudrait ajouter des comptes.
- Chaque partie a un identifiant unique. Réessayer l’envoi du même résultat ne crée pas de doublon, même avec plusieurs requêtes simultanées. Si l’API échoue, le formulaire de fin permet de réessayer ; les scores ne sont jamais présentés comme enregistrés lorsqu’ils ne le sont pas.
- Les anciens scores localStorage/Supabase ne sont pas importés automatiquement. Les fichiers de configuration Supabase ont été retirés ; les données précédentes n’ont pas été effacées de ces stockages.

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

L’affichage exhaustif charge l’historique complet. Pour des centaines de milliers de tentatives, prévoir un chargement progressif et mesurer la charge. Aucun débit maximal n’est garanti sans test sur votre VPS.

## API

- `POST /api/session` avec `{}` : crée ou retrouve l’identité du navigateur.
- `POST /api/attempts` avec `{ "name": "Agent", "score": 300, "attempt_id": "UUID de la partie" }` : ajoute une tentative. Cookie requis. Réessayer avec le même UUID et les mêmes valeurs renvoie la tentative existante ; des valeurs différentes renvoient 409.
- `GET /api/attempts` : toutes les tentatives avec `id`, `name`, `score`, `created_at`, `is_mine`. Aucun jeton joueur exposé.

Les requêtes utilisent la même origine. Le serveur valide le JSON, la taille des requêtes, un pseudo de 1 à 16 caractères et un score entier entre −10 000 et 20 000. Les scores restent calculés côté client : ce contrôle ne remplace pas un anti-triche serveur ni une protection contre le spam à grande échelle.

## Jeu et vérifications

Badge, porte fermée et téléphone d’urgence : +100 ; sans badge et porte ouverte : −150 ; voleur : −200. Une cible ignorée ne coûte rien. Réglages dans `DIFFICULTY` en haut de `game.js`. `?debug=1` active les traces toutes les 5 secondes et les fonctions de diagnostic. Le chrono ne se met pas en pause quand l’onglet est masqué.

```sh
python3 -m unittest discover -s tests -p 'test_*.py' -v
node tests/logic.cjs
```

Les tests couvrent les règles du jeu, la sauvegarde automatique, les réessais, 64 enregistrements concurrents depuis 8 identités, la persistance après réouverture, les homonymes, l’absence de limite de 10, la validation et l’inaccessibilité des fichiers privés.

## Identité visuelle

Monogramme OA générique dans `assets/oa-logo.svg`, sans nom ni logo du groupe sur les pages publiques. Palette monochrome ; rouge pour les erreurs. Les polices Google sont facultatives, avec repli sur les polices système.

## Préparation à la validation cybersécurité

- `index.html` et `classement.html` contiennent `<meta name="robots" content="noindex, nofollow">` immédiatement après `<head>`.
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
