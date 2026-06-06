require("dotenv").config();
const axios = require('axios');
const { google } = require('googleapis');
const cron = require('node-cron');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const SPREADSHEET_ID = '1_j7ZR95Q6sChI95R_HJ2WZ-l_jhc8IcPvWGt7zIiZog';
const MAX_PER_STATE = 5;

const STATES = [
  { state: 'Punjab', sheetName: 'Leads Punjab', cities: ['Ludhiana', 'Amritsar', 'Jalandhar', 'Patiala', 'Bathinda', 'Mohali'] },
  { state: 'Haryana', sheetName: 'Leads Haryana', cities: ['Gurugram', 'Faridabad', 'Panipat', 'Ambala', 'Karnal', 'Hisar', 'Rohtak'] },
  { state: 'Gujarat', sheetName: 'Leads Gujarat', cities: ['Ahmedabad', 'Surat', 'Vadodara', 'Rajkot', 'Gandhinagar', 'Bhavnagar'] },
  { state: 'Maharashtra', sheetName: 'Leads Maharastra', cities: ['Mumbai', 'Pune', 'Nagpur', 'Nashik', 'Aurangabad', 'Solapur', 'Kolhapur'] },
  { state: 'Madhya Pradesh', sheetName: 'Leads MP', cities: ['Bhopal', 'Indore', 'Gwalior', 'Jabalpur', 'Ujjain', 'Sagar'] },
  { state: 'Kerala', sheetName: 'Leads Kerala', cities: ['Kochi', 'Thiruvananthapuram', 'Kozhikode', 'Thrissur', 'Kollam', 'Kannur'] },
  { state: 'Tamil Nadu', sheetName: 'Leads Chennai', cities: ['Chennai', 'Coimbatore', 'Madurai', 'Tiruchirappalli', 'Salem', 'Tiruppur'] },
  { state: 'West Bengal', sheetName: 'Leads West Bengal', cities: ['Kolkata', 'Howrah', 'Durgapur', 'Asansol', 'Siliguri', 'Bardhaman'] },
  { state: 'Karnataka', sheetName: 'Leads Karnataka', cities: ['Bengaluru', 'Mysuru', 'Mangaluru', 'Hubli', 'Belagavi', 'Davangere'] },
  { state: 'Andhra Pradesh', sheetName: 'Leads Andhra', cities: ['Vijayawada', 'Visakhapatnam', 'Tirupati', 'Guntur', 'Nellore', 'Kurnool'] },
  { state: 'Telangana', sheetName: 'Leads Telangana', cities: ['Hyderabad', 'Warangal', 'Nizamabad', 'Karimnagar', 'Khammam'] }
];

// ─── GOOGLE SHEETS AUTH ───────────────────────────────────────────────────────
function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
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
  } catch (e) { console.error('ensureSheetExists error:', e.message); }
}

async function ensureHeaders(sheets, sheetName, headers) {
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${sheetName}!A1:Z1` });
    if (!(res.data.values?.[0]?.length)) throw new Error('no headers');
  } catch (e) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID, range: `${sheetName}!A1`,
      valueInputOption: 'RAW', requestBody: { values: [headers] }
    });
  }
}

async function readMasterSheet(sheets) {
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'master!A:B' });
    return res.data.values || [];
  } catch (e) { return []; }
}

async function appendToSheet(sheets, sheetName, rows) {
  if (!rows.length) return;
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID, range: `${sheetName}!A1`,
    valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows }
  });
}

async function getCityIndex(sheets, stateName) {
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'config!C:D' });
    const rows = res.data.values || [];
    const key = `city_${stateName.replace(/\s/g, '_')}`;
    const row = rows.find(r => r[0] === key);
    return row ? (parseInt(row[1]) || 0) : 0;
  } catch (e) { return 0; }
}

async function saveCityIndexes(sheets, updates) {
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'config!C:D' });
    const rows = res.data.values || [];
    for (const { stateName, index } of updates) {
      const key = `city_${stateName.replace(/\s/g, '_')}`;
      const rowIndex = rows.findIndex(r => r[0] === key);
      if (rowIndex >= 0) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID, range: `config!D${rowIndex + 1}`,
          valueInputOption: 'RAW', requestBody: { values: [[index]] }
        });
      } else {
        await sheets.spreadsheets.values.append({
          spreadsheetId: SPREADSHEET_ID, range: 'config!C:D',
          valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
          requestBody: { values: [[key, index]] }
        });
      }
    }
  } catch (e) { console.error('saveCityIndexes error:', e.message); }
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function searchTravelAgents(city) {
  const query = encodeURIComponent(`travel agents in ${city}`);
  const baseUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${query}&type=travel_agency&region=in&key=${GOOGLE_PLACES_API_KEY}`;
  let placeIds = [];
  let url = baseUrl;
  for (let page = 1; page <= 3; page++) {
    const res = await axios.get(url, { timeout: 30000 });
    const data = res.data;
    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') break;
    for (const r of (data.results || [])) { if (r.place_id) placeIds.push({ place_id: r.place_id, city }); }
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

// ─── PROCESS ONE STATE ────────────────────────────────────────────────────────
async function processState(sheets, stateObj, seenPhones, seenPlaceIds, today) {
  console.log(`\n--- Processing: ${stateObj.state} ---`);

  const cityIndex = await getCityIndex(sheets, stateObj.state);
  const city = stateObj.cities[cityIndex % stateObj.cities.length];
  const nextCityIndex = (cityIndex + 1) % stateObj.cities.length;
  console.log(`  City: ${city}`);

  const placeIds = await searchTravelAgents(city);
  console.log(`  Found ${placeIds.length} place IDs`);

  let count = 0;
  const stateRows = [];
  const leadsRows = [];
  const masterRows = [];

  for (const { place_id, city: c } of placeIds) {
    if (count >= MAX_PER_STATE) break;
    if (seenPlaceIds.has(place_id)) continue;

    let details;
    try { details = await fetchPlaceDetails(place_id, c); }
    catch (e) { console.error(`  Error: ${e.message}`); continue; }

    const phone = normalizePhone(details.international_phone_number || details.formatted_phone_number);
    if (!phone || seenPhones.has(phone)) continue;

    count++;
    seenPhones.add(phone);
    seenPlaceIds.add(place_id);

    console.log(`  ✅ [${count}] ${details.name} | ${phone}`);

    stateRows.push([today, c, details.name || '', phone, details.formatted_address || '', details.url || '', place_id]);
    leadsRows.push([today, c, stateObj.state, details.name || '', phone, details.formatted_address || '', details.url || '', place_id]);
    masterRows.push([phone, place_id, details.name || '', stateObj.state]);
  }

  if (stateRows.length) {
    await appendToSheet(sheets, stateObj.sheetName, stateRows);
    await appendToSheet(sheets, 'Leads', leadsRows);
    await appendToSheet(sheets, 'master', masterRows);
    console.log(`  ✅ Added ${stateRows.length} leads to ${stateObj.sheetName}`);
  } else {
    console.log(`  ⚠️ No new leads for ${stateObj.state}`);
  }

  return { stateName: stateObj.state, index: nextCityIndex };
}

// ─── MAIN JOB ─────────────────────────────────────────────────────────────────
async function runJob() {
  console.log(`\n========== Travel Agent Cron: ${new Date().toISOString()} ==========`);
  const sheets = getSheetsClient();

  // Ensure base sheets
  await ensureSheetExists(sheets, 'master');
  await ensureSheetExists(sheets, 'config');
  await ensureHeaders(sheets, 'master', ['Phone', 'PlaceID', 'name', 'state']);
  await ensureHeaders(sheets, 'Leads', ['date', 'city', 'state', 'name', 'phone', 'address', 'mapsUrl', 'place_id']);

  // Ensure all state sheets exist
  for (const s of STATES) {
    await ensureSheetExists(sheets, s.sheetName);
    await ensureHeaders(sheets, s.sheetName, ['date', 'city', 'name', 'phone', 'address', 'mapsUrl', 'place_id']);
  }

  // Read master for global dedup
  const masterRows = await readMasterSheet(sheets);
  const seenPhones = new Set();
  const seenPlaceIds = new Set();
  for (const row of masterRows) {
    if (row[0]) seenPhones.add(String(row[0]).trim());
    if (row[1]) seenPlaceIds.add(String(row[1]).trim());
  }
  console.log(`Master: ${seenPhones.size} phones, ${seenPlaceIds.size} place IDs`);

  const today = new Date().toISOString().slice(0, 10);
  const cityIndexUpdates = [];

  // Process all states
  for (const stateObj of STATES) {
    try {
      const update = await processState(sheets, stateObj, seenPhones, seenPlaceIds, today);
      cityIndexUpdates.push(update);
      await sleep(1000); // small pause between states
    } catch (e) {
      console.error(`Error processing ${stateObj.state}:`, e.message);
    }
  }

  // Save all city indexes
  await saveCityIndexes(sheets, cityIndexUpdates);
  console.log(`\n========== Done: ${new Date().toISOString()} ==========\n`);
}

// ─── SCHEDULE: 7PM IST = 13:30 UTC ───────────────────────────────────────────
cron.schedule('30 13 * * *', () => {
  runJob().catch(err => console.error('Job failed:', err));
});

console.log('✅ Travel Agent Cron started. Runs daily at 7PM IST (all states, 5 leads each).');

if (process.env.RUN_NOW === 'true') {
  runJob().catch(err => console.error('Job failed:', err));
}
