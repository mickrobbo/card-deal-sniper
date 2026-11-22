# Card Deal Sniper

A personal deal-alert app for Australian trading cards, built to run on Netlify for free. It does three things:

- **eBay AU sniper:** polls the official Browse API for new Buy It Now listings from Australian sellers. For each one it works out the landed price (item + postage) and compares it with a sold comp. If the profit after fees clears your bar, it alerts your phone.
- **Auto-comps:** gets sold prices from eBay Marketplace Insights (once eBay approves you) and optional price-tracker sites. Your own comps list is the fallback. Whichever comp is fresher wins.
- **Retail watch:** checks Kmart, Big W, Target, EB Games, JB Hi-Fi and Amazon AU for restocks and price drops. It does this politely: it obeys robots.txt, sends an honest user agent, keeps to a daily cap and backs off when a site blocks it.

Every alert leads with the **landed** price. The app only sends alerts. It never buys anything.

## What runs where

| Piece | What it does |
|---|---|
| `public/index.html` | Dashboard. It's served at your Netlify URL, and you can also save it to your desktop and open it there. |
| `netlify/functions/ebay-poll.mjs` | Runs every 5 min. Each search term is polled every 10 min by default. |
| `netlify/functions/retail-poll.mjs` | Runs every 5 min. Each watch is checked every 30 min plus a random 0-10 min, or every 5 min inside a drop window. |
| `netlify/functions/hourly.mjs` | Sends the rate-limit summary. Also sends the 7am heartbeat in your time zone (handles AEST/AEDT). |
| `netlify/functions/api.mjs` | The dashboard's API. It's locked with `ADMIN_KEY`. |
| `lib/` | All the logic: maths, comps, eBay client, retailer adapters, politeness layer. |
| `tests/` | 29 unit tests. Netlify runs them on every deploy, and a failing test blocks the deploy. |

Storage is **Netlify Blobs**, so there's no database to set up.

## Setup (about 15 minutes)

The Netlify site **card-deal-sniper** has already been created, and `ADMIN_KEY` and `NTFY_TOPIC` are already set on it.

### 1. Put the code on GitHub

1. On your computer, unzip `card-deal-sniper.zip`.
2. On github.com, create a new repository called `card-deal-sniper`. Set it to private.
3. On the empty repo's page, click **uploading an existing file**. Drag in everything inside the unzipped folder, including the `lib`, `netlify`, `public` and `tests` folders, then commit. The desktop browser keeps the folder structure; GitHub's mobile upload can't.

### 2. Link it to Netlify

1. Go to app.netlify.com, open **card-deal-sniper**, then **Site configuration → Build & deploy → Link repository**.
2. Choose GitHub and pick `card-deal-sniper`. The settings come from `netlify.toml`, so just deploy.
3. If a later commit doesn't trigger a rebuild, use **Deploys → Trigger deploy → Clear cache and deploy site**.

### 3. Phone alerts (ntfy)

1. Install **ntfy** from the App Store or Google Play. It's free and needs no account.
2. Tap **+** and subscribe to the topic in your `NTFY_TOPIC` value. You'll find it in Netlify under **Site configuration → Environment variables**.
3. Treat the topic like a password: anyone who knows it can read your alerts.
4. In the topic's settings, let it override Do Not Disturb. Drop alerts are sent as *urgent*.
5. Open the dashboard and tap **Home → Test phone alert**.

### 4. eBay keys

1. Sign up at https://developer.ebay.com and create an app keyset.
2. Copy the **Production** App ID and Cert ID.
3. In Netlify, add them as environment variables `EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET`, then redeploy.
4. In the dashboard, tap **Home → Test eBay**.
   - If it lists results, you're done.
   - If it says access is denied, apply for the **Application Growth Check** in the developer portal. Describe the app honestly as personal deal alerts. Apply for **Marketplace Insights** in the same application.

### 5. Dashboard

Open `https://card-deal-sniper.netlify.app` and enter your `ADMIN_KEY`. Then edit your searches, comps and watches. Run **eBay dry run** and **Retail dry run** to see what would alert, without sending anything.

## Retailer endpoints (one-off job, about 2 minutes per site)

Retailers change their sites, so every endpoint lives in config: **Settings → Advanced**. You can fix one there without touching code.

- **Kmart, Target, EB Games:** these read the schema.org product data that sites embed for Google. If a dry run says "page had no product data", that site renders its results with JavaScript. Use the JSON route below instead.
- **Big W:** search runs on Algolia. Fill in `app_id`, `api_key` and `index`, which are currently marked `VERIFY`:
  1. On a computer, open bigw.com.au and press F12 to open DevTools.
  2. Go to the **Network** tab and search for something on the site.
  3. Click the request to `…algolia.net/1/indexes/…`. Its headers show `X-Algolia-Application-Id` and the search-only `X-Algolia-API-Key`, and its URL shows the index name.
- **JB Hi-Fi:** uses Shopify's public `search/suggest.json` endpoint, which is pre-filled.
- **Amazon AU:** experimental. Amazon blocks hard, and robots.txt may forbid search pages. The app obeys robots.txt unless you set `ignore_robots: true` for that site.

The same DevTools method finds the JSON endpoint for any site. Watch the Network tab while searching, look for a request that returns JSON with product names and prices, then copy its URL into that site's `json` block.

## Honest limits

- **eBay production access** may need the Growth Check. Approval isn't guaranteed and takes days, so test on day one.
- **No open sold-price API exists.** Marketplace Insights needs eBay's approval. The tracker sites are off until you confirm their search URLs work. Your comps list always works, and the heartbeat warns you when comps go stale.
- **Retail checks are best-effort.**
  - Netlify's functions run from US data-centre IP addresses. Akamai-protected AU retailers block those more readily than a home connection.
  - There's no headless-browser fallback, because Netlify functions can't run one.
  - Expect some sites to block you. You'll get at most one notice per site per day.
- **No auto add-to-cart or checkout.** The app gets you to the product page fast: urgent alert, one-tap Open button, 5-minute drop windows. Checking out is up to you.
- **Scheduled functions only run on the published production deploy.** Deploy Previews don't poll.

## Changes from the original brief

- **Platform:** Python/Docker/SQLite became Netlify Functions and Blobs, plus a phone-friendly dashboard. Config is edited in the dashboard instead of a YAML file.
- **Comp tracker sites ship turned off** until their search URLs are verified, so the app doesn't send pointless requests to them.
- **Retailer targets are compared against landed price**, not shelf price, to match the landed-first rule.
- **Heartbeat stats use your local days** (Australia/Sydney time). The eBay call cap still resets at midnight UTC, as eBay's limit does.

## Added on top of the brief

- **Exclude keywords:** listings with words like proxy, fake, empty, box only or code card in the title are skipped. You can add extra words per search.
- **Seller feedback filter:** sellers below a minimum feedback percentage are skipped (default 95%). Alerts show the seller's rating.
- **Best Offer flag:** listings that accept Best Offer say so in the alert.
- **Alert buttons:** each ntfy alert has an **Open** button for one tap to the listing.
- **Drop windows:** for a known release, a watch can check every 5 minutes. Drop alerts are urgent.
- **"Add comp" from misses:** a listing that was skipped for having no comp becomes a new comp entry in one tap.
- **Price-history sparkline** and stock status for each watched product.
- **Pause / Resume** button, and an option to send low-priority WAIT alerts.
- **Safe test runs:** dry runs, a test button for each watch, and a "Clear" button for sites the app is backing off from.

## Local tests

```
npm test
```
