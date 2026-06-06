# 🤖 Crypto Bot Binance

Bot de trading intelligent avec confirmation manuelle avant chaque ordre.

---

## 🚀 Déploiement sur Railway (GRATUIT)

### Étape 1 — Préparer les fichiers
1. Téléchargez ce dossier complet
2. Créez un compte GitHub sur https://github.com (gratuit)
3. Créez un nouveau repository et uploadez tous les fichiers

### Étape 2 — Déployer sur Railway
1. Allez sur https://railway.app
2. Créez un compte gratuit avec GitHub
3. Cliquez "New Project" → "Deploy from GitHub repo"
4. Choisissez votre repository
5. Railway va déployer automatiquement ✅

### Étape 3 — Ajouter vos clés API
Dans Railway, allez dans votre projet :
1. Cliquez sur "Variables"
2. Ajoutez ces 2 variables :
   - `BINANCE_API_KEY` = votre clé API Binance
   - `BINANCE_API_SECRET` = votre clé secrète Binance
3. Railway redémarre automatiquement

### Étape 4 — Accéder au bot
Railway vous donne une URL du type :
`https://votre-bot.railway.app`

Ouvrez cette URL sur votre téléphone ou PC — votre bot est prêt ! 🎉

---

## ⚙️ Fonctionnement

- Le bot analyse le marché toutes les **30 secondes**
- Il utilise le **RSI**, **MA7**, **MA25** pour détecter les signaux
- Avant chaque achat ou vente, il vous demande votre **confirmation**
- Le **Stop Loss automatique** protège votre capital

---

## 🚨 Règles de sécurité

- ❌ Ne jamais activer "Retrait" sur votre clé API Binance
- ❌ Ne jamais partager vos clés avec personne
- ✅ Commencer avec un petit budget (10-20$)
- ✅ Toujours confirmer avant d'agir

---

## ⚠️ Avertissement

Ce bot est un outil éducatif. Le trading comporte des risques.
N'investissez jamais de l'argent que vous ne pouvez pas vous permettre de perdre.
