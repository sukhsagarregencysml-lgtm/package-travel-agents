const axios = require('axios');
const { google } = require('googleapis');
const cron = require('node-cron');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const SPREADSHEET_ID = '1_j7ZR95Q6sChI95R_HJ2WZ-l_jhc8IcPvWGt7zIiZog';
const MAX_PER_DAY = 20;

const CITIES = [
  // Punjab
  'Ludhiana', 'Amritsar', 'Jalandhar', 'Patiala', 'Bathinda', 'Mohali', 'Phagwara',
  // Haryana
  'Gurugram', 'Faridabad', 'Panipat', 'Ambala', 'Karnal', 'Hisar', 'Rohtak',
  // Gujarat
  'Ahmedabad', 'Surat', 'Vadodara', 'Rajkot', 'Gandhinagar', 'Bhavnagar', 'Jamnagar',
  // Maharashtra
  'Mumbai', 'Pune', 'Nagpur', 'Nashik', 'Aurangabad', 'Solapur', 'Kolhapur',
  // Madhya Pradesh
  'Bhopal', 'Indore', 'Gwalior', 'Jabalpur', 'Ujjain', 'Sagar', 'Dewas',
  // South India
  'Bengaluru', 'Chennai', 'Hyderabad', 'Kochi', 'Thiruvananthapuram', 'Mysuru',
  'Coimbatore', 'Madurai', 'Vijayawada', 'Visakhapatnam', 'Mangaluru', 'Kozhikode',
  'Tirupati', 'Warangal', 'Hubli'
];

// ─── GOOGLE SHEETS AUTH ───────────────────────────────────────────────────────
function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

// ─── SHEET HELPERS ────────────────────────────────────────────────────────────
async function ensureSheetExists(sheets, sheetName) {
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const exists = meta.data.sheets.some(s => s.properties.title === sheetName);
    if (!exists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          requests: [{ addSheet: { properties: { title: sheetName } } }]
        }
      });
      console.log(`Created sheet: ${sheetName}`);
    }
  } catch (e) {
    console.error('ensureSheetExists error:', e.message);
  }
}

async function getMonthlySheetName() {
  const now = new Date();
  const month = now.toLocaleString('en-IN', { month: 'long' });
  const year = now.getFullYear();
  return `${month} ${year}`;
}

async function readMasterSheet(sheets) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'master!A:B',
    });
    return res.data.values || [];
  } catch (e) {
    console.log('Master sheet empty or not found, starting fresh');
    return [];
  }
}

async function appendToSheet(sheets, sheetName, rows) {
  if (!rows.length) return;
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
}

async function ensureHeaders(sheets, sheetName, headers) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A1:Z1`,
    });
    const existing = res.data.values?.[0] || [];
    if (existing.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${sheetName}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [headers] },
      });
    }
  } catch (e) {
    // sheet might be empty, write headers
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] },
    });
  }
}

// ─── CITY ROTATION ────────────────────────────────────────────────────────────
async function getCityIndex(sheets) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'config!A2',
    });
    const val = parseInt(res.data.values?.[0]?.[0] || '0');
    return isNaN(val) ? 0 : val;
  } catch (e) {
    return 0;
  }
}

async function saveCityIndex(sheets, index) {
  await ensureSheetExists(sheets, 'config');
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: 'config!A1',
    valueInputOption: 'RAW',
    requestBody: { values: [['cityIndex'], [index]] },
  });
}

// ─── PHONE NORMALIZER ─────────────────────────────────────────────────────────
function normalizePhone(raw) {
  if (!raw) return null;
  let s = String(raw).replace(/[^\d+]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  const digits = s.replace(/\D/g, '');
  if (/^\+91[6-9][0-9]{9}$/.test(s)) return s;
  if (/^0?[6-9][0-9]{9}$/.test(digits)) return '+91' + digits.replace(/^0/, '');
  if (digits.length === 10) return '+91' + digits;
  return null;
}

// ─── GOOGLE PLACES API ────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchPlacesPage(url) {
  const res = await axios.get(url, { timeout: 30000 });
  return res.data;
}

async function searchTravelAgents(city) {
  const query = encodeURIComponent(`travel agents in ${city}`);
  const baseUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${query}&type=travel_agency&region=in&key=${GOOGLE_PLACES_API_KEY}`;

  let placeIds = [];
  let url = baseUrl;

  for (let page = 1; page <= 3; page++) {
    console.log(`  Fetching page ${page} for ${city}...`);
    const data = await fetchPlacesPage(url);

    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      console.error(`  Places API error: ${data.status}`);
      break;
    }

    const results = data.results || [];
    for (const r of results) {
      if (r.place_id) placeIds.push({ place_id: r.place_id, city });
    }

    if (!data.next_page_token) break;

    // Must wait 2 seconds before using next_page_token
    await sleep(2000);
    url = `https://maps.googleapis.com/maps/api/place/textsearch/json?pagetoken=${data.next_page_token}&key=${GOOGLE_PLACES_API_KEY}`;
  }

  return placeIds;
}

async function fetchPlaceDetails(placeId, city) {
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=name,formatted_address,formatted_phone_number,international_phone_number,url,place_id&key=${GOOGLE_PLACES_API_KEY}`;
  const res = await axios.get(url, { timeout: 30000 });
  const r = res.data.result || {};
  return { ...r, city };
}

// ─── MAIN JOB ─────────────────────────────────────────────────────────────────
async function runJob() {
  console.log(`\n========== Travel Agent Cron Started: ${new Date().toISOString()} ==========`);

  const sheets = getSheetsClient();

  // Ensure sheets exist
  await ensureSheetExists(sheets, 'master');
  await ensureSheetExists(sheets, 'Leads');
  const monthlySheet = await getMonthlySheetName();
  await ensureSheetExists(sheets, monthlySheet);

  // Write headers if needed
  await ensureHeaders(sheets, 'master', ['Phone', 'PlaceID', 'name']);
  await ensureHeaders(sheets, 'Leads', ['date', 'city', 'name', 'phone', 'address', 'mapsUrl', 'place_id', 'dailyCount']);
  await ensureHeaders(sheets, monthlySheet, ['date', 'city', 'name', 'phone', 'address', 'mapsUrl', 'place_id']);

  // Get current city
  const cityIndex = await getCityIndex(sheets);
  const city = CITIES[cityIndex % CITIES.length];
  const nextIndex = (cityIndex + 1) % CITIES.length;
  console.log(`City for today: ${city} (index ${cityIndex})`);

  // Read master for dedup
  const masterRows = await readMasterSheet(sheets);
  const seenPhones = new Set();
  const seenPlaceIds = new Set();
  for (const row of masterRows) {
    if (row[0]) seenPhones.add(String(row[0]).trim());
    if (row[1]) seenPlaceIds.add(String(row[1]).trim());
  }
  console.log(`Master has ${seenPhones.size} existing phones, ${seenPlaceIds.size} place IDs`);

  // Search Google Places
  const placeIds = await searchTravelAgents(city);
  console.log(`Found ${placeIds.length} place IDs for ${city}`);

  // Fetch details and filter
  let dailyCount = 0;
  const leadsRows = [];
  const monthlyRows = [];
  const masterNewRows = [];
  const today = new Date().toISOString().slice(0, 10);

  for (const { place_id, city: c } of placeIds) {
    if (dailyCount >= MAX_PER_DAY) break;
    if (seenPlaceIds.has(place_id)) {
      console.log(`  Skip (dup place_id): ${place_id}`);
      continue;
    }

    let details;
    try {
      details = await fetchPlaceDetails(place_id, c);
    } catch (e) {
      console.error(`  Error fetching details for ${place_id}:`, e.message);
      continue;
    }

    const phone = normalizePhone(details.international_phone_number || details.formatted_phone_number);
    if (!phone) {
      console.log(`  Skip (no valid phone): ${details.name}`);
      continue;
    }
    if (seenPhones.has(phone)) {
      console.log(`  Skip (dup phone): ${phone}`);
      continue;
    }

    // New unique lead!
    dailyCount++;
    seenPhones.add(phone);
    seenPlaceIds.add(place_id);

    console.log(`  ✅ [${dailyCount}] ${details.name} | ${phone} | ${c}`);

    const leadRow = [today, c, details.name || '', phone, details.formatted_address || '', details.url || '', place_id, dailyCount];
    const monthlyRow = [today, c, details.name || '', phone, details.formatted_address || '', details.url || '', place_id];
    const masterRow = [phone, place_id, details.name || ''];

    leadsRows.push(leadRow);
    monthlyRows.push(monthlyRow);
    masterNewRows.push(masterRow);
  }

  // Append to sheets
  if (leadsRows.length) {
    await appendToSheet(sheets, 'Leads', leadsRows);
    await appendToSheet(sheets, monthlySheet, monthlyRows);
    await appendToSheet(sheets, 'master', masterNewRows);
    console.log(`\n✅ Appended ${leadsRows.length} new leads to Leads, ${monthlySheet}, and master`);
  } else {
    console.log('\n⚠️ No new leads found for today');
  }

  // Advance city index
  await saveCityIndex(sheets, nextIndex);
  console.log(`Next city index saved: ${nextIndex} (${CITIES[nextIndex]})`);
  console.log(`========== Job Complete ==========\n`);
}

// ─── SCHEDULE: 7PM IST = 13:30 UTC ───────────────────────────────────────────
cron.schedule('30 13 * * *', () => {
  runJob().catch(err => console.error('Job failed:', err));
});

console.log('✅ Travel Agent Cron Service started. Runs daily at 7PM IST.');

// Run immediately on start if env var set (for testing)
if (process.env.RUN_NOW === 'true') {
  runJob().catch(err => console.error('Job failed:', err));
}
