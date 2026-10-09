# Comptes privés

Application web (installable sur GSM) pour suivre les dépenses courantes, remplaçant le
classeur Excel « Comptes privés ». Hébergée sur **GitHub Pages**, données dans **Supabase**.

## Fonctionnalités

| Écran | Contenu |
|---|---|
| **Accueil** | Le mois en un coup d'œil : dépenses courantes et prévision de fin de mois, solde, épargne vs réserve « imprévus », dépenses annuelles vs plafond, alertes (budget dépassé, échéances à venir, solde négatif…). |
| **Saisie** | Étape par étape, comme demandé : mois → catégorie → article (recherche, ou création) → magasin, date, quantité/€/kg/promo (Légumes), montant → « un autre article ? » → que consulter ? Le magasin et la date sont gardés d'un article à l'autre (un ticket = un magasin). Le montant accepte `2*2,15`. |
| **Courses** | Liste de courses proposée d'après les habitudes d'achat (articles réguliers dont le délai habituel est atteint), dans la limite du budget restant, avec le magasin le moins cher récemment. Horizon semaine / fin de mois, tri par catégorie ou par magasin, cases à cocher. |
| **Détail** | Les blocs par catégorie du « Détail mois », colonne « Magasin + date », ajout/modification/suppression de lignes. |
| **Global** | Rentrées, solde du mois précédent (automatique ou forcé), dépenses fixes (recopiées d'un mois à l'autre, modifiables), totaux par catégorie, solde de fin de mois. Onglets **Essence** (pleins, Δ km, l/100 km, trajets extra), **Annuels** (provisions, paiements, plafond annuel), **Épargne** (mouvements et solde). |
| **Analyses** | 12 derniers mois par catégorie, moyennes 3/6 mois et tendances, budgets mensuels (avec suggestion), prévision sur 12 mois. |
| **Inflation** | Pour les catégories suivies (Légumes et Divers par défaut) : évolution du prix de chaque article par magasin (€/kg ou prix forfaitaire, hors promo). |
| **Article** | Graphique d'évolution du prix d'un produit, par magasin, avec les prix relevés et l'historique complet. |

Corrections par rapport à l'Excel :
- La formule des Légumes `(D*E/1000)-(F*E)` soustrayait `promo × €/kg` au lieu d'appliquer un pourcentage. L'application calcule **montant = quantité (kg) × €/kg × (1 − promo %)**.
- Les totaux Légumes d'octobre valaient 0 € dans l'Excel (la formule visait la colonne vide), alors que le vrai total est 40,03 €.

## Mise en place (une seule fois)

### 1. Supabase

Projet utilisé : `wzrcrszfubjsfoaxatvo` (« checkmydev »). Il est **partagé avec d'autres
applications**, chacune dans son propre schéma. Tout ce qui concerne les comptes est dans le schéma
**`comptes`** : ne rien créer dans `public`.

1. **SQL Editor** → New query → coller le contenu de [`supabase/schema.sql`](supabase/schema.sql) → **Run**
   (crée le schéma `comptes`).
2. **Project Settings → Data API → Exposed schemas** : ajouter `comptes`, sans retirer les autres.
3. **Authentication → Users → Add user** : créer le compte de Papa (e-mail + mot de passe, cocher « Auto confirm »).
   Ne **pas** désactiver les inscriptions : l'authentification est commune aux autres applications.
   Un compte qui n'est pas celui de Papa ne voit aucune de ses données (RLS).
4. Reprendre les données de l'Excel :
   ```bash
   npm install
   npm run import-excel -- "Documents/Comptes privés 2025.xlsx" adresse-de-papa@exemple.be
   ```
   Le script affiche un contrôle des totaux par bloc et génère `supabase/seed.sql`
   (868 achats de février à octobre 2026, 519 articles, 54 magasins, le Global d'octobre,
   les provisions annuelles et l'épargne). L'exécuter **une fois** dans le SQL Editor.

### 2. GitHub Pages

1. Créer le dépôt sur GitHub et y pousser ce dossier (branche `main`).
2. **Settings → Pages → Source : GitHub Actions**.
3. **Settings → Secrets and variables → Actions → onglet Variables** : ajouter
   - `VITE_SUPABASE_URL` : l'URL du projet (Supabase → Project Settings → API)
   - `VITE_SUPABASE_ANON_KEY` : la clé « anon public »
4. Chaque `git push` sur `main` redéploie l'application (workflow `deploy.yml`).

> Le dépôt est public (GitHub Pages gratuit) : `Documents/`, `supabase/seed.sql` et `.env.local`
> sont exclus par `.gitignore` et ne doivent jamais être ajoutés. La clé `anon` n'est pas un
> secret. Les données sont protégées par les règles RLS : chaque compte ne voit que ses
> propres lignes.

### 3. Installer sur le GSM

Ouvrir l'adresse GitHub Pages sur le téléphone :
- **Android (Chrome)** : le bandeau « Installer l'application » apparaît sur l'accueil.
  Sinon, menu ⋮ → « Installer l'application ».
- **iPhone (Safari)** : bouton Partager → « Sur l'écran d'accueil ». Le bandeau l'explique.

## Keep-alive Supabase

Un projet Supabase gratuit est mis en pause après 7 jours sans activité. Deux mécanismes
écrivent une ligne dans la table `keep_alive`, qui n'a aucun lien avec les comptes :
- l'application, à chaque ouverture ;
- le workflow [`keep-alive.yml`](.github/workflows/keep-alive.yml), tous les 3 jours, même si
  l'application n'est pas utilisée. On peut le lancer à la main : Actions → Keep-alive → Run workflow.

GitHub désactive les workflows planifiés d'un dépôt sans aucun commit pendant 60 jours :
il envoie alors un e-mail, et il suffit de cliquer sur « Enable workflow ».

## Prix relevés (recherche de prix sur le PC)

La recherche de prix se fait sur le PC, à la demande. Les résultats sont ensuite poussés
dans l'application, où ils apparaissent sur la page de chaque article (cercles creux sur le
graphique, comparaison avec le dernier prix payé) et servent à la liste de courses.

```bash
# .env.local doit contenir VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, SUPABASE_EMAIL, SUPABASE_PASSWORD
npm run push-prices -- --list              # articles suivis + dernier prix payé (liste de travail)
npm run push-prices -- prix.json --dry     # simulation
npm run push-prices -- prix.json           # envoi
```

Format de `prix.json` :
```json
[
  { "article": "Bananes", "categorie": "Légumes", "enseigne": "Lidl", "prix": 1.29, "unite": "kg",
    "promo": false, "date": "2026-10-09", "libelle": "Bananes 1 kg", "source": "https://…" }
]
```
`unite` : `kg`, `piece` ou `l`. Les articles inconnus sont signalés. `--create` les crée
(la catégorie est alors obligatoire).

## Développement

```bash
cp .env.example .env.local   # puis compléter
npm install
npm run dev                  # http://localhost:5173
npm run build                # vérification TypeScript + build de production
```

Structure :
- `src/pages/` : un fichier par écran.
- `src/lib/` : accès aux données (`api.ts`), calculs de soldes et projections (`budget.ts`),
  prix et inflation (`prices.ts`), liste de courses (`shopping.ts`).
- `supabase/schema.sql` : tables, vue des totaux, règles RLS, fonction keep-alive.
- `scripts/` : import Excel, envoi des prix relevés, génération des icônes.

## À vérifier avec Papa

- **Solde fin septembre** : vide dans l'Excel, donc repris à 0 € (octobre affiche un solde de
  fin de mois négatif). À saisir dans Global → « Solde fin septembre 2026 ».
- **Mois de février à septembre** : seuls les achats (Détail) ont été repris, pas les lignes du
  Global (retraite, loyer…). Le Global de ces mois est donc incomplet, mais les analyses et
  l'inflation utilisent bien tout l'historique.
- **Mois d'échéance des dépenses annuelles** (Global → Annuels) : à compléter pour être
  prévenu à l'avance sur l'accueil.
- **Budgets mensuels** par catégorie (Analyses) et **réserve « imprévus »** (Paramètres) :
  à fixer ensemble. L'application propose des montants à partir des moyennes.
- Les noms d'articles de l'Excel sont parfois variables (« Haché promo 1+1 », « 2 bananes »…).
  On peut les renommer ou les changer de catégorie dans Paramètres → Articles.
- Le bloc « Plusieurs mois… » (pour info, non repris dans le Global) n'a pas été importé.
