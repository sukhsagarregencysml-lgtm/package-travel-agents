# Travel Agent Cron

Daily cron job that searches Google Places for travel agents across Indian cities and saves new leads to Google Sheets.

## What it does
- Runs every day at **7PM IST**
- Rotates through cities: Punjab → Gujarat → Maharashtra → MP → Haryana → South India
- Fetches up to 3 pages (60 results) from Google Places Text Search
- Fetches full details (phone, address, Maps URL) for each result
- De-duplicates against master sheet (by phone + place_id)
- Saves max **20 new unique leads per day**
- Appends to: `Leads` tab, current month tab, `master` tab

## Google Sheet
Sheet ID: `1_j7ZR95Q6sChI95R_HJ2WZ-l_jhc8IcPvWGt7zIiZog`

Tabs used:
- `master` — all-time seen phones + place IDs (for dedup)
- `Leads` — all leads ever
- `June 2025`, `July 2025` etc — monthly tabs
- `config` — stores city rotation index

## Deploy on Render

### 1. Push to GitHub
```
git init
git add .
git commit -m "initial"
git remote add origin https://github.com/YOUR_USERNAME/travel-agent-cron.git
git push -u origin main
```

### 2. Create Render Web Service
- Go to render.com → New → Web Service
- Connect your GitHub repo
- **Build Command:** `npm install`
- **Start Command:** `node index.js`
- **Instance Type:** Free (or Starter)

### 3. Set Environment Variables on Render
| Key | Value |
|-----|-------|
| `GOOGLE_PLACES_API_KEY` | `AIzaSyCZbJjKgySFBC2hGvFvXkZTvnWZvwQz4pE` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | *(paste the full contents of your service account JSON)* |

### 4. Keep it alive (Render Free tier sleeps)
- Add UptimeRobot to ping your service URL every 5 minutes
- Or upgrade to Starter ($7/month) — stays always on

### Test immediately
Set env var `RUN_NOW=true` on Render → it will run once on startup, then you can remove it.
