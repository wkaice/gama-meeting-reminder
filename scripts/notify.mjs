// scripts/notify.mjs
//
// 你沒有 gamawork 這個會議室系統的管理權限，所以這版改成「完全不碰 gamawork
// 的東西」：只用會議室網頁本來就會用到的公開唯讀金鑰（anon key）去讀取
// Supabase 的 bookings 資料，不寫入、不改欄位、不需要 service_role 金鑰。
//
// 「已經通知過」的紀錄改成存在這個 repo 自己的 data/state.json，
// 每次執行完由 workflow 自動 commit 回去，取代原本寫回 Supabase 的做法。
//
// 只會通知「我是主辦人或與會者」的會議（用 MY_NAME 比對），
// 避免整個公司的每一場會議都推播給你。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(__dirname, '..', 'data', 'state.json');

// 這兩個是會議室網頁原本就公開內嵌在 index.html 裡的唯讀金鑰，任何人打開網頁
// 原始碼都看得到，所以直接寫死在這裡是安全的（受 Supabase RLS 保護，只能讀）。
const SUPABASE_URL = 'https://vicvccudnqluufsgyznk.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZpY3ZjY3VkbnFsdXVmc2d5em5rIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTUxMzkyMDMsImV4cCI6MjA3MDcxNTIwM30.55ZG0B_L6UVJOUteqZ7sPXGHm8DG6K5Qk4xcQ9lF01U';

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  MY_NAME, // 你在會議室系統裡登記用的名字，例如 'Faust'（要跟系統裡的拼法完全一致）
  TZ_OFFSET = '+08:00',
} = process.env;

for (const [name, val] of Object.entries({ TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, MY_NAME })) {
  if (!val) throw new Error(`Missing required env var: ${name}`);
}

const WINDOWS = [
  { key: '1d', label: '1 天後', targetMs: 24 * 60 * 60 * 1000, toleranceMs: 8 * 60 * 1000 },
  { key: '1h', label: '1 小時後', targetMs: 60 * 60 * 1000, toleranceMs: 8 * 60 * 1000 },
];

// 常見的欄位命名方式，程式會自動挑第一個存在的欄位使用。
// 如果完全抓不到會議，去 Supabase Table Editor 對一下 bookings 表的真實欄位名稱，
// 把正確名稱加進對應陣列即可。
const FIELD_CANDIDATES = {
  id: ['id'],
  date: ['date', 'meeting_date', 'meetingDate'],
  startTime: ['start_time', 'startTime', 'start'],
  endTime: ['end_time', 'endTime', 'end'],
  startAt: ['start_at', 'starts_at', 'start_datetime', 'startDateTime'],
  room: ['room', 'location', 'meeting_room', 'meetingRoom'],
  subject: ['subject', 'title', 'meeting_title', 'meetingTitle'],
  organizer: ['organizer', 'organizer_name'],
  attendees: ['attendees'],
};

function pick(row, key) {
  for (const c of FIELD_CANDIDATES[key]) {
    if (row[c] !== undefined && row[c] !== null && row[c] !== '') return row[c];
  }
  return undefined;
}

function getStartDate(row) {
  const combined = pick(row, 'startAt');
  if (combined) return new Date(combined);

  const date = pick(row, 'date');
  const startTime = pick(row, 'startTime');
  if (!date || !startTime) return null;

  const time = String(startTime).length === 5 ? `${startTime}:00` : startTime;
  const d = new Date(`${String(date).slice(0, 10)}T${time}${TZ_OFFSET}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isRelevantToMe(row) {
  const organizer = String(pick(row, 'organizer') || '').trim();
  if (organizer === MY_NAME) return true;

  const attendees = String(pick(row, 'attendees') || '');
  return attendees
    .split(/[,，、]+/)
    .map((s) => s.trim())
    .includes(MY_NAME);
}

async function supabaseFetch(qs) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/bookings?${qs}`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase GET failed: ${res.status} ${text}`);
  }
  return res.json();
}

async function sendTelegram(text) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Telegram sendMessage failed: ${res.status} ${t}`);
  }
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

async function main() {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + 26 * 60 * 60 * 1000);
  const dateFrom = now.toISOString().slice(0, 10);
  const dateTo = windowEnd.toISOString().slice(0, 10);
  const dateField = FIELD_CANDIDATES.date[0];

  const rows = await supabaseFetch(
    `select=*&${dateField}=gte.${dateFrom}&${dateField}=lte.${dateTo}`
  );

  const state = loadState();
  let sent = 0;

  for (const row of rows) {
    if (!isRelevantToMe(row)) continue;

    const start = getStartDate(row);
    if (!start) continue;

    const diffMs = start.getTime() - now.getTime();
    if (diffMs < 0) continue;

    const id = pick(row, 'id');
    state[id] ||= {};

    for (const w of WINDOWS) {
      if (state[id][w.key]) continue;
      if (Math.abs(diffMs - w.targetMs) > w.toleranceMs) continue;

      const subject = pick(row, 'subject') || '(未命名會議)';
      const room = pick(row, 'room') || '';
      const organizer = pick(row, 'organizer') || '';
      const startTime = pick(row, 'startTime') || start.toTimeString().slice(0, 5);
      const endTime = pick(row, 'endTime') || '';
      const dateStr = pick(row, 'date') || start.toISOString().slice(0, 10);

      const text =
        `🔔 會議提醒（${w.label}）\n` +
        `${subject}\n` +
        `📅 ${dateStr} ${startTime}${endTime ? '–' + endTime : ''}\n` +
        `📍 ${room}\n` +
        `👤 ${organizer}`;

      await sendTelegram(text);
      state[id][w.key] = true;
      sent += 1;
    }
  }

  saveState(state);
  console.log(`Done. Sent ${sent} notification(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
