const axios = require('axios');
const { google } = require('googleapis');
const cron = require('node-cron');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const SPREADSHEET_ID = '1_j7ZR95Q6sChI95R_HJ2WZ-l_jhc8IcPvWGt7zIiZog';
const MAX_PER_DAY = 5;

// Each entry: { state, sheetName, cities }
const STATES = [
  {
    state: 'Punjab',
    sheetName: 'Leads Punjab',
    cities: ['Ludhiana', 'Amritsar', 'Jalandhar', 'Patiala', 'Bathinda', 'Mohali']
  },
  {
    state: 'Haryana',
    sheetName: 'Leads Haryana',
    cities: ['Gurugram', 'Faridabad', 'Panipat', 'Ambala', 'Karnal', 'Hisar', 'Rohtak']
  },
  {
    state: 'Gujarat',
    sheetName: 'Leads Gujarat',
    cities: ['Ahmedabad', 'Surat', 'Vadodara', 'Rajkot', 'Gandhinagar', 'Bhavnagar']
  },
  {
    state: 'Maharashtra',
    sheetName: 'Leads Maharastra',
    cities: ['Mumbai', 'Pune', 'Nagpur', 'Nashik', 'Aurangabad', 'Solapur', 'Kolhapur']
  },
  {
    state: 'Madhya Pradesh',
    sheetName: 'Leads MP',
    cities: ['Bhopal', 'Indore', 'Gwalior', 'Jabalpur', 'Ujjain', 'Sagar']
  },
  {
    state: 'Kerala',
    sheetName: 'Leads Kerala',
    cities: ['Kochi', 'Thiruvananthapuram', 'Kozhikode', 'Thrissur', 'Kollam', 'Kannur']
  },
  {
    state: 'Tamil Nadu',
    sheetName: 'Leads Chennai',
    cities: ['Chennai', 'Coimbatore', 'Madurai', 'Tiruchirappalli', 'Salem', 'Tiruppur']
  },
  {
    state: 'West Bengal',
    sheetName: 'Leads West Bengal',
    cities: ['Kolkata', 'Howrah', 'Durgapur', 'Asansol', 'Siliguri', 'Bardhaman']
  },
  {
    state: 'Karnataka',
    sheetName: 'Leads Karnataka',
    cities: ['Bengaluru', 'Mysuru', 'Mangaluru', 'Hubli', 'Belagavi', 'Davangere']
  },
  {
    state: 'Andhra Pradesh',
    sheetName: 'Leads Andhra',
    cities: ['Vijayawada', 'Visakhapatnam', 'Tirupati', 'Guntur', 'Nellore', 'Kurnool']
  },
  {
    state: 'Telangana',
    sheetName: 'Leads Telangana',
    cities: ['Hyderabad', 'Warangal', 'Nizamabad', 'Karimnagar', 'Khammam']
  }
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
        requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] }
      });
      console.log(`Created sheet: ${sheetName}`);
    }
  } catch (e) {
    console.error('ensureSheetExists error:', e.message);
  }
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
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] },
    });
  }
}

async function readMasterSheet(sheets) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'master!A:B',
    });
    return res.data.values || [];
  } catch (e) {
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

// ─── STATE ROTATION ───────────────────────────────────────────────────────────
async function getStateIndex(sheets) {
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

async function saveStateIndex(sheets, index) {
  await ensureSheetExists(sheets, 'config');
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: 'config!A1',
    valueInputOption: 'RAW',
    requestBody: { values: [['stateIndex'], [index]] },
  });
}

// ─── CITY ROTATION WITHIN STATE ───────────────────────────────────────────────
async function getCityIndex(sheets, stateName) {
  try {
    const key = `cityIndex_${stateName.replace(/\s/g, '_')}`;
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'config!C:D',
    });
    const rows = res.data.values || [];
    const row = rows.find(r => r[0] === key);
    return row ? (parseInt(row[1]) || 0) : 0;
  } catch (e) {
    return 0;
  }
}

async function saveCityIndex(sheets, stateName, index) {
  const key = `cityIndex_${stateName.replace(/\s/g, '_')}`;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'config!C:D',
    });
    const rows = res.data.values || [];
    const rowIndex = rows.findIndex(r => r[0] === key);
    if (rowIndex >= 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `config!D${rowIndex + 1}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[index]] },
      });
    } else {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: 'config!C:D',
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [[key, index]] },
      });
    }
  } catch (e) {
    console.error('saveCityIndex error:', e.message);
  }
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

async function searchTravelAgents(city) {
  const query = encodeURIComponent(`travel agents in ${city}`);
  const baseUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${query}&type=travel_agency&region=in&key=${GOOGLE_PLACES_API_KEY}`;

  let placeIds = [];
  let url = baseUrl;

  for (let page = 1; page <= 3; page++) {
    console.log(`    Page ${page} for ${city}...`);
    const res = await axios.get(url, { timeout: 30000 });
    const data = res.data;

    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      console.error(`    Places API error: ${data.status}`);
      break;
    }

    for (const r of (data.results || [])) {
      if (r.place_id) placeIds.push({ place_id: r.place_id, city });
    }

    if (!data.next_page_token) break;
    await sleep(2000);
    url = `https://maps.googleapis.com/maps/api/place/textsearch/json?pagetoken=${data.next_page_token}&key=${GOOGLE_PLACES_API_KEY}`;
  }

  return placeIds;
}

async function fetchPlaceDetails(placeId, city) {
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=name,formatted_address,formatted_phone_number,international_phone_number,url,place_id&key=${GOOGLE_PLACES_API_KEY}`;
  const res = await axios.get(url, { timeout: 30000 });
  return { ...(res.data.result || {}), city };
}

// ─── MAIN JOB ─────────────────────────────────────────────────────────────────
async function runJob() {
  console.log(`\n========== Travel Agent Cron: ${new Date().toISOString()} ==========`);

  const sheets = getSheetsClient();

  // Ensure master + config sheets
  await ensureSheetExists(sheets, 'master');
  await ensureSheetExists(sheets, 'config');
  await ensureHeaders(sheets, 'master', ['Phone', 'PlaceID', 'name', 'state']);

  // Get today's state
  const stateIndex = await getStateIndex(sheets);
  const stateObj = STATES[stateIndex % STATES.length];
  const nextStateIndex = (stateIndex + 1) % STATES.length;
  console.log(`State today: ${stateObj.state} → sheet: "${stateObj.sheetName}"`);

  // Ensure state sheet exists with headers
  await ensureSheetExists(sheets, stateObj.sheetName);
  await ensureHeaders(sheets, stateObj.sheetName, ['date', 'city', 'name', 'phone', 'address', 'mapsUrl', 'place_id']);
  await ensureHeaders(sheets, 'Leads', ['date', 'city', 'state', 'name', 'phone', 'address', 'mapsUrl', 'place_id']);

  // Read master for dedup
  const masterRows = await readMasterSheet(sheets);
  const seenPhones = new Set();
  const seenPlaceIds = new Set();
  for (const row of masterRows) {
    if (row[0]) seenPhones.add(String(row[0]).trim());
    if (row[1]) seenPlaceIds.add(String(row[1]).trim());
  }
  console.log(`Master: ${seenPhones.size} phones, ${seenPlaceIds.size} place IDs`);

  // Get city to search today within this state
  const cityIndex = await getCityIndex(sheets, stateObj.state);
  const city = stateObj.cities[cityIndex % stateObj.cities.length];
  const nextCityIndex = (cityIndex + 1) % stateObj.cities.length;
  console.log(`City: ${city} (index ${cityIndex})`);

  // Search Places
  const placeIds = await searchTravelAgents(city);
  console.log(`Found ${placeIds.length} place IDs`);

  // Fetch details, dedup, gate 20
  let dailyCount = 0;
  const stateRows = [];
  const leadsRows = [];
  const masterNewRows = [];
  const today = new Date().toISOString().slice(0, 10);

  for (const { place_id, city: c } of placeIds) {
    if (dailyCount >= MAX_PER_DAY) break;
    if (seenPlaceIds.has(place_id)) { console.log(`  Skip dup placeId: ${place_id}`); continue; }

    let details;
    try {
      details = await fetchPlaceDetails(place_id, c);
    } catch (e) {
      console.error(`  Error fetching ${place_id}:`, e.message);
      continue;
    }

    const phone = normalizePhone(details.international_phone_number || details.formatted_phone_number);
    if (!phone) { console.log(`  Skip no phone: ${details.name}`); continue; }
    if (seenPhones.has(phone)) { console.log(`  Skip dup phone: ${phone}`); continue; }

    dailyCount++;
    seenPhones.add(phone);
    seenPlaceIds.add(place_id);

    console.log(`  ✅ [${dailyCount}] ${details.name} | ${phone} | ${c}`);

    stateRows.push([today, c, details.name || '', phone, details.formatted_address || '', details.url || '', place_id]);
    leadsRows.push([today, c, stateObj.state, details.name || '', phone, details.formatted_address || '', details.url || '', place_id]);
    masterNewRows.push([phone, place_id, details.name || '', stateObj.state]);
  }

  // Write to sheets
  if (stateRows.length) {
    await appendToSheet(sheets, stateObj.sheetName, stateRows);
    await appendToSheet(sheets, 'Leads', leadsRows);
    await appendToSheet(sheets, 'master', masterNewRows);
    console.log(`\n✅ Added ${stateRows.length} leads to "${stateObj.sheetName}" and Leads`);
  } else {
    console.log('\n⚠️ No new leads found');
  }

  // Advance indexes
  await saveStateIndex(sheets, nextStateIndex);
  await saveCityIndex(sheets, stateObj.state, nextCityIndex);
  console.log(`Next state: ${STATES[nextStateIndex].state}, next city in ${stateObj.state}: ${stateObj.cities[nextCityIndex]}`);
  console.log(`========== Done ==========\n`);
}

// ─── SCHEDULE: 7PM IST = 13:30 UTC ───────────────────────────────────────────
cron.schedule('30 13 * * *', () => {
  runJob().catch(err => console.error('Job failed:', err));
});

console.log('✅ Travel Agent Cron started. Runs daily at 7PM IST.');

if (process.env.RUN_NOW === 'true') {
  runJob().catch(err => console.error('Job failed:', err));
}
