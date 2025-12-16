/* eslint-disable no-console */
/**
 * FINANCE BOT – ULTIMATE FINAL – ONE FILE (Level B / Engineer)
 * Gia đình anh Kinh – spec:
 * - 2 người dùng Telegram (vợ + chồng)
 * - 5 tài khoản:
 *    1) Tài khoản thẻ Chồng (NHẬN LƯƠNG CHUNG cho cả 2)
 *    2) Tài khoản thẻ Vợ (RIÊNG_VỢ)
 *    3) TK thẻ ăn (CHUNG)
 *    4) Tài khoản Mẹ (VN_CHUNG – nhận tiền gửi về)
 *    5) Tài khoản mua online tại VN (VN_CHUNG – chi bên VN)
 * - Quỹ: CHUNG / RIÊNG_VỢ / VN_CHUNG
 * - Gửi VN là TRANSFER (không tính chi sinh hoạt, nhưng ảnh hưởng số dư)
 * - Đầu tư là CHUNG
 * - Nợ có nhắc hạn
 * - FX tự lấy theo Naver (cache theo ngày) và “đóng băng” theo giao dịch
 * - Menu ẩn góc phải (Telegram command menu) + inline buttons
 * - OCR/Chart/PDF/Excel: có adapter & hook, anh điền key/cài lib sau
 *
 * Node.js 18+
 */

import TelegramBot from "node-telegram-bot-api";
import { google } from "googleapis";
import axios from "axios";
import dayjs from "dayjs";
import cron from "node-cron";
import fs from "fs";
import path from "path";
import os from "os";

/* =========================
 * SECTION 0 — ENV & GUARDS
 * ========================= */
const ENV = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  GOOGLE_SHEET_ID: process.env.GOOGLE_SHEET_ID,
  GOOGLE_KEY_FILE: process.env.GOOGLE_KEY_FILE || "service-account.json",
  ALLOWED_USER_IDS: (process.env.ALLOWED_USER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  OCR_PROVIDER: process.env.OCR_PROVIDER || "none", // none|google_vision|naver_clova|custom
  OCR_API_KEY: process.env.OCR_API_KEY || "",
  TZ: process.env.TZ || "Asia/Seoul",
};

if (!ENV.BOT_TOKEN) throw new Error("Missing BOT_TOKEN");
if (!ENV.GOOGLE_SHEET_ID) throw new Error("Missing GOOGLE_SHEET_ID");
if (!fs.existsSync(ENV.GOOGLE_KEY_FILE)) {
  throw new Error(`Missing GOOGLE_KEY_FILE: ${ENV.GOOGLE_KEY_FILE}`);
}

/* =========================
 * SECTION 1 — DOMAIN CONFIG
 * ========================= */
const ACCOUNTS = Object.freeze({
  CHONG: "Tài khoản thẻ Chồng",
  VO: "Tài khoản thẻ Vợ",
  AN: "TK thẻ ăn",
  ME: "Tài khoản Mẹ",
  VN: "Tài khoản mua online tại VN",
});

const FUNDS = Object.freeze({
  CHUNG: "CHUNG",
  RIENG_VO: "RIÊNG_VỢ",
  VN: "VN_CHUNG",
});

const TX_TYPES = Object.freeze({
  IN: "IN",
  OUT: "OUT",
  TRANSFER: "TRANSFER",
  INVEST: "INVEST",
  DEBT_NEW: "DEBT_NEW",
  DEBT_PAY: "DEBT_PAY",
});

const INVEST_TYPES = Object.freeze({
  LAND: "BĐS/Đất",
  GOLD: "Vàng",
  DIGITAL: "Kỹ thuật số",
  OTHER: "Khác",
});

const KEYWORDS = Object.freeze({
  // income
  CK: ["ck", "chồng", "luong chong", "lương chồng"],
  VK: ["vk", "vợ", "vo", "luong vo", "lương vợ"],
  INCOME: ["lương", "thưởng", "nhận", "+", "salary", "bonus"],
  // spending categories
  FOOD: ["ăn", "đồ ăn", "com", "cơm", "food", "mart", "마트", "siêu thị", "market"],
  BILL: ["điện", "nước", "đt", "điện thoại", "gas", "관리비", "전기", "수도"],
  GAS: ["xăng", "đổ xăng", "gasoline", "주유"],
  SHOP: ["mua", "shopping", "coupang", "쿠팡", "shopee", "lazada", "tiki"],
  HEALTH: ["thuốc", "bệnh", "viện", "y tế", "health", "병원", "약"],
  GIFT: ["mừng", "hiếu", "cưới", "sinh nhật", "gift", "축의금"],
  CONTRIB: ["đóng góp", "góp", "contribution"],
  INSURANCE: ["bảo hiểm", "bh", "insurance"],
  CHILD: ["con", "sữa", "bỉm", "học", "đàn"],
  // transfer vn
  TRANSFER_VN: ["gửi vn", "gui vn", "chuyển vn", "chuyen vn", "chuyển mẹ", "chuyen me", "gửi mẹ"],
  // invest
  INVEST: ["đầu tư", "dautu", "đất", "mua đất", "vàng", "mua vàng", "coin", "crypto", "btc", "eth"],
  // debt
  DEBT: ["nợ", "vay", "cho vay"],
  PAY: ["trả", "tra", "pay", "hoàn", "hoan"],
});

const DEFAULTS = Object.freeze({
  DEFAULT_CURRENCY: "KRW",
  DEFAULT_FX_FALLBACK: 19, // 1 KRW ≈ 19 VND fallback
  PERIOD_MODE: "MONTH", // MONTH | 15TO15 (supported in reports)
});

/* =========================
 * SECTION 2 — UTILITIES
 * ========================= */
function nowKST() {
  return dayjs().format("YYYY-MM-DD HH:mm:ss");
}

function isAllowedUser(msgOrCb) {
  if (!ENV.ALLOWED_USER_IDS.length) return true;
  const id =
    "from" in msgOrCb && msgOrCb.from
      ? String(msgOrCb.from.id)
      : msgOrCb.message?.from?.id
      ? String(msgOrCb.message.from.id)
      : "";
  return ENV.ALLOWED_USER_IDS.includes(id);
}

function safeJson(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return String(obj);
  }
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function normalizeSpaces(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function stripDiacriticsVietnamese(s) {
  // minimal (enough for keyword matching)
  return (s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function lowerFold(s) {
  return stripDiacriticsVietnamese(String(s || "")).toLowerCase();
}

function hasAny(text, arr) {
  const t = lowerFold(text);
  return arr.some((k) => t.includes(lowerFold(k)));
}

function formatMoney(amount, currency) {
  const n = Number(amount || 0);
  const s = n.toLocaleString("en-US");
  return currency === "KRW" ? `₩${s}` : `${s} VND`;
}

function parseDateVN(s) {
  // Accept: dd/mm, dd-mm, dd/mm/yyyy, yyyy-mm-dd
  const t = normalizeSpaces(s);
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return dayjs(t).format("YYYY-MM-DD");
  const m = t.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/);
  if (!m) return null;
  const dd = String(m[1]).padStart(2, "0");
  const mm = String(m[2]).padStart(2, "0");
  let yy = m[3] ? m[3] : String(dayjs().year());
  if (yy.length === 2) yy = "20" + yy;
  return `${yy}-${mm}-${dd}`;
}

function parseDueFromText(text) {
  // Examples: "hẹn 25/12", "hen 2025-12-25", "due 2025-12-25"
  const t = lowerFold(text);
  const m1 = t.match(/(?:hẹn|hen|due)\s+(\d{4}-\d{2}-\d{2})/);
  if (m1) return m1[1];
  const m2 = t.match(/(?:hẹn|hen|due)\s+(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)/);
  if (m2) return parseDateVN(m2[1]);
  return null;
}

/* =========================
 * SECTION 3 — FX RATE (NAVER)
 * ========================= */
const FX_CACHE = { rate: null, date: null, raw: "" };

async function fetchFxRateNaverKRWtoVND() {
  // Naver calculator endpoint (can change; we keep robust fallback)
  // If breaks, fallback remains safe.
  const url =
    "https://m.search.naver.com/p/csearch/content/qapirender.nhn?where=nexearch&key=calculator&pkid=141&q=%ED%99%98%EC%9C%A8&value=1&unit=KRW&target=VND";
  const res = await axios.get(url, { timeout: 12000 });
  return res.data;
}

function parseFxFromNaverPayload(payload) {
  // Try multiple patterns
  const s = String(payload || "");
  let m = s.match(/"value":"([\d.]+)"/);
  if (m) return parseFloat(m[1]);
  m = s.match(/"exchangeRate"\s*:\s*"([\d.]+)"/i);
  if (m) return parseFloat(m[1]);
  m = s.match(/([\d.]+)\s*VND/i);
  if (m) return parseFloat(m[1]);
  return null;
}

async function getFxRateKRWtoVND() {
  const today = dayjs().format("YYYY-MM-DD");
  if (FX_CACHE.date === today && FX_CACHE.rate) return FX_CACHE.rate;
  try {
    const payload = await fetchFxRateNaverKRWtoVND();
    const rate = parseFxFromNaverPayload(payload);
    if (!rate || !Number.isFinite(rate) || rate <= 0) throw new Error("Bad FX parse");
    FX_CACHE.rate = rate;
    FX_CACHE.date = today;
    FX_CACHE.raw = String(payload).slice(0, 500);
    return rate;
  } catch (e) {
    FX_CACHE.rate = DEFAULTS.DEFAULT_FX_FALLBACK;
    FX_CACHE.date = today;
    FX_CACHE.raw = `fallback: ${String(e?.message || e)}`;
    return DEFAULTS.DEFAULT_FX_FALLBACK;
  }
}

/* =========================
 * SECTION 4 — GOOGLE SHEETS LAYER
 * ========================= */
const SHEETS = Object.freeze({
  TX: "TX",
  INVEST: "INVEST",
  DEBT: "DEBT",
  FX: "FX_RATE",
  SETTINGS: "SETTINGS",
  BUDGETS: "BUDGETS",
  AUDIT: "AUDIT",
});

const HEADERS = Object.freeze({
  TX: [
    "id",
    "time",
    "telegram_user_id",
    "person_name",
    "type",
    "fund",
    "account",
    "category",
    "subcategory",
    "merchant",
    "amount",
    "currency",
    "krw_equiv",
    "fx_rate",
    "note",
    "raw",
    "period_key",
  ],
  INVEST: ["id", "time", "person_name", "asset_type", "amount", "currency", "krw_equiv", "fx_rate", "note", "raw"],
  DEBT: [
    "id",
    "time",
    "person_name",
    "counterparty",
    "role", // OWE | LEND
    "amount",
    "currency",
    "krw_equiv",
    "fx_rate",
    "due_date",
    "status", // OPEN | CLOSED
    "note",
    "raw",
  ],
  FX: ["date", "krw_to_vnd", "source", "raw"],
  SETTINGS: ["key", "value"],
  BUDGETS: ["fund", "category", "currency", "monthly_limit"],
  AUDIT: ["time", "telegram_user_id", "event", "payload"],
});

async function sheetGetMeta() {
  const res = await sheetsApi().spreadsheets.get({ spreadsheetId: ENV.GOOGLE_SHEET_ID });
  return res.data;
}

function sheetsApi() {
  return google.sheets({ version: "v4", auth: gAuth });
}

const gAuth = new google.auth.GoogleAuth({
  keyFile: ENV.GOOGLE_KEY_FILE,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

async function ensureSheetsExist() {
  const api = sheetsApi();
  const meta = await sheetGetMeta();
  const existing = new Set((meta.sheets || []).map((s) => s.properties?.title).filter(Boolean));

  const requests = [];
  for (const [_, title] of Object.entries(SHEETS)) {
    if (!existing.has(title)) {
      requests.push({ addSheet: { properties: { title } } });
    }
  }

  if (requests.length) {
    await api.spreadsheets.batchUpdate({
      spreadsheetId: ENV.GOOGLE_SHEET_ID,
      requestBody: { requests },
    });
  }

  // Ensure headers
  await ensureHeaderRow(SHEETS.TX, HEADERS.TX);
  await ensureHeaderRow(SHEETS.INVEST, HEADERS.INVEST);
  await ensureHeaderRow(SHEETS.DEBT, HEADERS.DEBT);
  await ensureHeaderRow(SHEETS.FX, HEADERS.FX);
  await ensureHeaderRow(SHEETS.SETTINGS, HEADERS.SETTINGS);
  await ensureHeaderRow(SHEETS.BUDGETS, HEADERS.BUDGETS);
  await ensureHeaderRow(SHEETS.AUDIT, HEADERS.AUDIT);

  // Seed SETTINGS defaults
  await setSettingIfMissing("PERIOD_MODE", DEFAULTS.PERIOD_MODE);
  await setSettingIfMissing("REPORT_DEFAULT_FUND", FUNDS.CHUNG);

  // Seed accounts mapping in SETTINGS (human-readable)
  await setSettingIfMissing("ACCOUNT_CHONG", ACCOUNTS.CHONG);
  await setSettingIfMissing("ACCOUNT_VO", ACCOUNTS.VO);
  await setSettingIfMissing("ACCOUNT_AN", ACCOUNTS.AN);
  await setSettingIfMissing("ACCOUNT_ME", ACCOUNTS.ME);
  await setSettingIfMissing("ACCOUNT_VN", ACCOUNTS.VN);
}

async function ensureHeaderRow(sheetName, headers) {
  const api = sheetsApi();
  const range = `${sheetName}!A1:Z1`;
  const res = await api.spreadsheets.values.get({
    spreadsheetId: ENV.GOOGLE_SHEET_ID,
    range,
  });
  const firstRow = res.data.values?.[0] || [];
  const same = headers.length <= firstRow.length && headers.every((h, i) => firstRow[i] === h);

  if (!same) {
    await api.spreadsheets.values.update({
      spreadsheetId: ENV.GOOGLE_SHEET_ID,
      range: `${sheetName}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [headers] },
    });
  }
}

async function appendRow(sheetName, values) {
  const api = sheetsApi();
  await api.spreadsheets.values.append({
    spreadsheetId: ENV.GOOGLE_SHEET_ID,
    range: `${sheetName}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [values] },
  });
}

async function getAllRows(sheetName, maxRows = 5000) {
  const api = sheetsApi();
  const res = await api.spreadsheets.values.get({
    spreadsheetId: ENV.GOOGLE_SHEET_ID,
    range: `${sheetName}!A1:Z${maxRows}`,
  });
  const values = res.data.values || [];
  const header = values[0] || [];
  const rows = values.slice(1).map((r) => {
    const obj = {};
    header.forEach((h, idx) => (obj[h] = r[idx] ?? ""));
    return obj;
  });
  return rows;
}

async function logAudit(userId, event, payload) {
  await appendRow(SHEETS.AUDIT, [nowKST(), String(userId || ""), event, safeJson(payload)]);
}

async function getSetting(key) {
  const rows = await getAllRows(SHEETS.SETTINGS, 2000);
  const found = rows.find((r) => r.key === key);
  return found ? found.value : null;
}

async function setSettingIfMissing(key, value) {
  const cur = await getSetting(key);
  if (cur === null || cur === undefined || cur === "") {
    await appendRow(SHEETS.SETTINGS, [key, String(value)]);
  }
}

/* =========================
 * SECTION 5 — PERIOD KEY
 * ========================= */
function periodKeyFor(dateStr, mode) {
  const d = dayjs(dateStr);
  if (mode === "15TO15") {
    // Period runs 15 -> 14 next month.
    // If day >= 15 => period starts current month 15, ends next month 14.
    // Else => period started previous month 15.
    const day = d.date();
    let start = d;
    if (day < 15) start = d.subtract(1, "month");
    return `${start.format("YYYY-MM")}-15to${start.add(1, "month").format("YYYY-MM")}-14`;
  }
  return d.format("YYYY-MM");
}

/* =========================
 * SECTION 6 — PARSER / RULE ENGINE
 * ========================= */
function detectCurrency(raw) {
  const t = lowerFold(raw);
  if (t.includes("vnd") || t.includes("vnđ") || t.includes("đ")) return "VND";
  if (t.includes("krw") || t.includes("won") || t.includes("₩")) return "KRW";
  // k/tr in Vietnamese usually indicates VND (but user also uses k for won sometimes).
  // Rule: if has 'tr' => VND. If has 'k' alone => default VND ONLY when also has 'vn' keywords.
  if (t.includes("tr")) return "VND";
  return DEFAULTS.DEFAULT_CURRENCY;
}

function parseNumberToken(token) {
  // Remove commas and currency signs
  const clean = token.replace(/[,\s₩]/g, "");
  const m = clean.match(/^(\d+(?:\.\d+)?)(k|tr)?$/i);
  if (!m) return null;
  const base = parseFloat(m[1]);
  const suffix = (m[2] || "").toLowerCase();
  if (!Number.isFinite(base)) return null;

  if (suffix === "tr") return base * 1_000_000;
  if (suffix === "k") return base * 1_000;
  // if no suffix: user wants minimal typing; default "12" => 12k KRW.
  return base * 1_000;
}

function extractFirstAmount(raw) {
  // find patterns like: 57,240  | 60tr | 3800k | ₩57,240 | 2.5tr
  const t = normalizeSpaces(raw);
  const candidates = [];

  // ₩57,240 or 57,240
  const re = /₩?\s*([\d]{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(\s*(k|tr))?/gi;
  let m;
  while ((m = re.exec(t))) {
    const full = (m[1] || "") + (m[3] ? m[3] : "");
    const amount = parseNumberToken(full.replace(/,/g, "")) ?? null;
    // if matched comma form without suffix => treat as exact amount, not *1000
    if (!m[3] && m[1] && m[1].includes(",")) {
      const exact = parseInt(m[1].replace(/,/g, ""), 10);
      if (Number.isFinite(exact)) candidates.push({ amount: exact, raw: m[0], exact: true });
      continue;
    }
    if (amount !== null) candidates.push({ amount, raw: m[0], exact: false });
  }

  if (!candidates.length) return null;
  // Prefer exact comma amount first (₩57,240), else first candidate.
  const exact = candidates.find((c) => c.exact);
  return exact || candidates[0];
}

function categorize(text) {
  const t = text || "";
  if (hasAny(t, KEYWORDS.FOOD)) return { category: "Ăn uống", subcategory: "Siêu thị/Ăn" };
  if (hasAny(t, KEYWORDS.GAS)) return { category: "Đi lại", subcategory: "Xăng" };
  if (hasAny(t, KEYWORDS.BILL)) return { category: "Sinh hoạt", subcategory: "Hóa đơn" };
  if (hasAny(t, KEYWORDS.HEALTH)) return { category: "Sức khỏe", subcategory: "Y tế" };
  if (hasAny(t, KEYWORDS.INSURANCE)) return { category: "Bảo hiểm", subcategory: "Bảo hiểm" };
  if (hasAny(t, KEYWORDS.GIFT)) return { category: "Hiếu hỉ", subcategory: "Quà/Mừng" };
  if (hasAny(t, KEYWORDS.CONTRIB)) return { category: "Đóng góp", subcategory: "Góp" };
  if (hasAny(t, KEYWORDS.CHILD)) return { category: "Con cái", subcategory: "Chi cho con" };
  if (hasAny(t, KEYWORDS.SHOP)) return { category: "Mua sắm", subcategory: "Online/Shop" };
  return { category: "Khác", subcategory: "" };
}

function detectInvestType(text) {
  const t = lowerFold(text);
  if (t.includes("đất") || t.includes("dat") || t.includes("nhà") || t.includes("nha")) return INVEST_TYPES.LAND;
  if (t.includes("vàng") || t.includes("vang") || t.includes("gold")) return INVEST_TYPES.GOLD;
  if (t.includes("coin") || t.includes("crypto") || t.includes("btc") || t.includes("eth")) return INVEST_TYPES.DIGITAL;
  return INVEST_TYPES.OTHER;
}

function detectTransferVN(text) {
  return hasAny(text, KEYWORDS.TRANSFER_VN);
}

function detectDebtRole(text) {
  // "nợ A" => OWE
  // "cho B vay" => LEND
  const t = lowerFold(text);
  if (t.includes("cho") && t.includes("vay")) return "LEND";
  if (t.includes("nợ") || t.includes("vay")) return "OWE";
  return "OWE";
}

function inferAccountFundType({ text, userName }) {
  const t = text || "";

  // INCOME
  if (hasAny(t, KEYWORDS.INCOME) || hasAny(t, KEYWORDS.CK) || hasAny(t, KEYWORDS.VK)) {
    return {
      type: TX_TYPES.IN,
      fund: FUNDS.CHUNG,
      account: ACCOUNTS.CHONG, // lương chung về tài khoản thẻ Chồng
      forced: true,
    };
  }

  // TRANSFER VN
  if (detectTransferVN(t)) {
    return {
      type: TX_TYPES.TRANSFER,
      fund: FUNDS.VN,
      account: ACCOUNTS.ME,
      forced: true,
    };
  }

  // INVEST
  if (hasAny(t, KEYWORDS.INVEST)) {
    return {
      type: TX_TYPES.INVEST,
      fund: FUNDS.CHUNG,
      account: ACCOUNTS.CHONG,
      forced: true,
    };
  }

  // DEBT
  if (hasAny(t, KEYWORDS.DEBT)) {
    // could be new debt or repayment
    if (hasAny(t, KEYWORDS.PAY)) {
      return { type: TX_TYPES.DEBT_PAY, fund: FUNDS.CHUNG, account: ACCOUNTS.CHONG, forced: true };
    }
    return { type: TX_TYPES.DEBT_NEW, fund: FUNDS.CHUNG, account: ACCOUNTS.CHONG, forced: true };
  }

  // If starts with "vk" and not income => riêng vợ
  if (lowerFold(t).startsWith("vk ")) {
    return { type: TX_TYPES.OUT, fund: FUNDS.RIENG_VO, account: ACCOUNTS.VO, forced: true };
  }

  // Food defaults to TK thẻ ăn CHUNG
  if (hasAny(t, KEYWORDS.FOOD)) {
    return { type: TX_TYPES.OUT, fund: FUNDS.CHUNG, account: ACCOUNTS.AN, forced: true };
  }

  // Child defaults: if mentions VN / con and VN context => VN account
  if (hasAny(t, KEYWORDS.CHILD) && detectCurrency(t) === "VND") {
    return { type: TX_TYPES.OUT, fund: FUNDS.VN, account: ACCOUNTS.VN, forced: true };
  }

  // Default spending from chung (account: TK thẻ ăn for convenience)
  return { type: TX_TYPES.OUT, fund: FUNDS.CHUNG, account: ACCOUNTS.AN, forced: false };
}

/* =========================
 * SECTION 7 — TELEGRAM STATE MACHINE
 * ========================= */
const pending = new Map(); // key: `${chatId}:${userId}` => { kind, data, createdAt }

function stateKey(chatId, userId) {
  return `${chatId}:${userId}`;
}

function setPending(chatId, userId, kind, data) {
  pending.set(stateKey(chatId, userId), { kind, data, createdAt: Date.now() });
}

function getPending(chatId, userId) {
  const p = pending.get(stateKey(chatId, userId));
  if (!p) return null;
  // expire after 10 minutes
  if (Date.now() - p.createdAt > 10 * 60 * 1000) {
    pending.delete(stateKey(chatId, userId));
    return null;
  }
  return p;
}

function clearPending(chatId, userId) {
  pending.delete(stateKey(chatId, userId));
}

/* =========================
 * SECTION 8 — OCR ADAPTER (HOOK)
 * ========================= */
async function ocrExtractTransactionsFromImage({ fileUrl }) {
  // Return unified format:
  // [{ time: '2025-12-15 20:57:45', merchant: '도화우리마트', amount: 57240, currency:'KRW', raw:'...' }, ...]
  // Provider-specific code to be implemented by adding API key.
  if (ENV.OCR_PROVIDER === "none") {
    return { ok: false, reason: "OCR_PROVIDER=none", items: [] };
  }
  if (!ENV.OCR_API_KEY) {
    return { ok: false, reason: "Missing OCR_API_KEY", items: [] };
  }

  // Placeholder – You will plug actual OCR here.
  // Strategy recommended:
  // 1) OCR to text lines
  // 2) parse merchant + -KRW + timestamp
  // 3) normalize to list
  return { ok: false, reason: "OCR adapter not implemented yet (key ok, need provider code)", items: [] };
}

/* =========================
 * SECTION 9 — OPTIONAL MODULES (Excel/PDF/Charts)
 * ========================= */
let ExcelJS = null;
let PDFKit = null;
let ChartJSNodeCanvas = null;

try {
  const mod = await import("exceljs");
  ExcelJS = mod.default || mod;
} catch {}
try {
  const mod = await import("pdfkit");
  PDFKit = mod.default || mod;
} catch {}
try {
  const mod = await import("chartjs-node-canvas");
  ChartJSNodeCanvas = mod.ChartJSNodeCanvas || mod.default || mod;
} catch {}

async function exportExcelReport(rows, filename) {
  if (!ExcelJS) return { ok: false, reason: "exceljs not installed" };
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("TX");

  ws.columns = Object.keys(rows[0] || {}).map((k) => ({ header: k, key: k, width: 18 }));
  for (const r of rows) ws.addRow(r);

  await wb.xlsx.writeFile(filename);
  return { ok: true, path: filename };
}

async function exportPdfSummary(summary, filename) {
  if (!PDFKit) return { ok: false, reason: "pdfkit not installed" };
  const doc = new PDFKit({ margin: 36 });
  const out = fs.createWriteStream(filename);
  doc.pipe(out);

  doc.fontSize(18).text("Báo cáo tài chính gia đình", { align: "center" });
  doc.moveDown();
  doc.fontSize(12);

  for (const [k, v] of Object.entries(summary)) {
    doc.text(`${k}: ${v}`);
  }

  doc.end();

  await new Promise((resolve, reject) => {
    out.on("finish", resolve);
    out.on("error", reject);
  });

  return { ok: true, path: filename };
}

async function renderChartPng({ title, labels, values }, filename) {
  if (!ChartJSNodeCanvas) return { ok: false, reason: "chartjs-node-canvas not installed" };

  const width = 900;
  const height = 600;
  const chartCanvas = new ChartJSNodeCanvas({ width, height, backgroundColour: "white" });

  const config = {
    type: "pie",
    data: { labels, datasets: [{ data: values }] },
    options: { plugins: { title: { display: true, text: title } } },
  };

  const buffer = await chartCanvas.renderToBuffer(config);
  fs.writeFileSync(filename, buffer);
  return { ok: true, path: filename };
}

/* =========================
 * SECTION 10 — REPORT / AGGREGATIONS
 * ========================= */
function sumRows(rows, filterFn, currency) {
  let sum = 0;
  for (const r of rows) {
    if (!filterFn(r)) continue;
    if (currency === "KRW") sum += Number(r.krw_equiv || 0);
    else sum += Number(r.amount || 0);
  }
  return sum;
}

function buildSummary(rows) {
  // All numbers in KRW (equiv) for global comparability
  const income = sumRows(rows, (r) => r.type === TX_TYPES.IN, "KRW");
  const spendChung = sumRows(rows, (r) => r.type === TX_TYPES.OUT && r.fund === FUNDS.CHUNG, "KRW");
  const spendVo = sumRows(rows, (r) => r.type === TX_TYPES.OUT && r.fund === FUNDS.RIENG_VO, "KRW");
  const transferVN = sumRows(rows, (r) => r.type === TX_TYPES.TRANSFER, "KRW");
  const invest = sumRows(rows, (r) => r.type === TX_TYPES.INVEST, "KRW");
  // Debt: net open principal (approx) should come from DEBT sheet; this summary uses TX only.
  const net = income - spendChung - spendVo - transferVN - invest;

  return {
    "Tổng thu (KRW quy đổi)": formatMoney(income, "KRW"),
    "Chi CHUNG (KRW quy đổi)": formatMoney(spendChung, "KRW"),
    "Chi RIÊNG VỢ (KRW quy đổi)": formatMoney(spendVo, "KRW"),
    "Gửi VN (KRW quy đổi)": formatMoney(transferVN, "KRW"),
    "Đầu tư (KRW quy đổi)": formatMoney(invest, "KRW"),
    "Còn lại (ước tính) (KRW)": formatMoney(net, "KRW"),
  };
}

function groupByCategory(rows, fundFilter) {
  const map = new Map();
  for (const r of rows) {
    if (r.type !== TX_TYPES.OUT) continue;
    if (fundFilter && r.fund !== fundFilter) continue;
    const key = r.category || "Khác";
    map.set(key, (map.get(key) || 0) + Number(r.krw_equiv || 0));
  }
  const arr = [...map.entries()].sort((a, b) => b[1] - a[1]);
  return arr;
}

/* =========================
 * SECTION 11 — BUDGETS & ALERTS
 * ========================= */
async function getBudgets() {
  const rows = await getAllRows(SHEETS.BUDGETS, 2000);
  return rows
    .filter((r) => r.fund && r.category && r.currency && r.monthly_limit)
    .map((r) => ({
      fund: r.fund,
      category: r.category,
      currency: r.currency,
      limit: Number(r.monthly_limit || 0),
    }));
}

async function computeBudgetAlerts(periodKey) {
  const tx = await getAllRows(SHEETS.TX, 5000);
  const budgets = await getBudgets();

  const alerts = [];
  for (const b of budgets) {
    const spent = tx
      .filter(
        (r) =>
          r.period_key === periodKey &&
          r.type === TX_TYPES.OUT &&
          r.fund === b.fund &&
          (r.category || "") === b.category &&
          r.currency === b.currency
      )
      .reduce((acc, r) => acc + Number(r.amount || 0), 0);

    if (b.limit > 0) {
      const pct = (spent / b.limit) * 100;
      if (pct >= 90) {
        alerts.push({ ...b, spent, pct: Math.round(pct) });
      }
    }
  }
  return alerts;
}

/* =========================
 * SECTION 12 — DEBT SCHEDULER
 * ========================= */
async function getOpenDebts() {
  const rows = await getAllRows(SHEETS.DEBT, 5000);
  return rows.filter((r) => (r.status || "OPEN") === "OPEN");
}

function debtDueStatus(dueDate) {
  if (!dueDate) return { kind: "NO_DUE", days: null };
  const d = dayjs(dueDate);
  const today = dayjs().startOf("day");
  const diff = d.diff(today, "day"); // due - today
  if (diff < 0) return { kind: "OVERDUE", days: -diff };
  if (diff === 0) return { kind: "DUE_TODAY", days: 0 };
  if (diff <= 3) return { kind: "DUE_SOON", days: diff };
  return { kind: "OK", days: diff };
}

async function sendDebtReminders() {
  // send reminders to chats that have used the bot before (stored in SETTINGS CHAT_IDS)
  const chatIdsStr = (await getSetting("CHAT_IDS")) || "";
  const chatIds = chatIdsStr
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!chatIds.length) return;

  const open = await getOpenDebts();
  const msgs = [];

  for (const d of open) {
    const st = debtDueStatus(d.due_date);
    if (st.kind === "OVERDUE" || st.kind === "DUE_TODAY" || st.kind === "DUE_SOON") {
      msgs.push(
        `• ${d.role === "OWE" ? "Nợ" : "Cho vay"}: ${d.counterparty} — ${formatMoney(d.amount, d.currency)} — ${
          d.due_date ? `hẹn ${d.due_date}` : "chưa có hẹn"
        } — ${st.kind === "OVERDUE" ? `QUÁ HẠN ${st.days} ngày` : st.kind === "DUE_TODAY" ? "ĐẾN HẠN HÔM NAY" : `CÒN ${st.days} ngày`}`
      );
    }
  }

  if (!msgs.length) return;

  const text = `🧾 NHẮC NỢ\n${msgs.join("\n")}`;
  for (const chatId of chatIds) {
    try {
      await bot.sendMessage(chatId, text);
    } catch (e) {
      console.error("sendDebtReminders error", e?.message || e);
    }
  }
}

/* =========================
 * SECTION 13 — TELEGRAM BOT UI
 * ========================= */
const bot = new TelegramBot(ENV.BOT_TOKEN, { polling: true });

async function rememberChatId(chatId) {
  const cur = (await getSetting("CHAT_IDS")) || "";
  const set = new Set(cur.split(",").map((s) => s.trim()).filter(Boolean));
  set.add(String(chatId));
  // naive append: write new setting row (avoid update complexity in one-file)
  // We'll keep latest key value at bottom: the reader gets first match; so we store only once with ifMissing earlier.
  // For chat ids, we store in a second key that is always appended, and we read last match by scanning.
  await appendRow(SHEETS.SETTINGS, ["CHAT_IDS_LATEST", [...set].join(",")]);
}

// Read setting with last occurrence (for CHAT_IDS_LATEST)
async function getSettingLatest(keyPrefix) {
  const rows = await getAllRows(SHEETS.SETTINGS, 5000);
  const matches = rows.filter((r) => r.key === keyPrefix);
  if (!matches.length) return null;
  return matches[matches.length - 1].value;
}

// override getSetting for CHAT_IDS
async function getChatIdsSetting() {
  const v = await getSettingLatest("CHAT_IDS_LATEST");
  const legacy = await getSetting("CHAT_IDS");
  return v || legacy || "";
}

bot.setMyCommands([
  { command: "start", description: "Bắt đầu" },
  { command: "menu", description: "☰ Menu" },
  { command: "ghi", description: "➕ Ghi giao dịch" },
  { command: "anh", description: "📷 Nhập từ ảnh" },
  { command: "thongke", description: "📊 Thống kê" },
  { command: "bieudo", description: "📈 Biểu đồ" },
  { command: "dautu", description: "💰 Đầu tư" },
  { command: "no", description: "🧾 Nợ & cho vay" },
  { command: "canhbao", description: "⚠️ Cảnh báo & ngân sách" },
  { command: "xuat", description: "🧾 Xuất PDF/Excel" },
  { command: "caidat", description: "⚙️ Cài đặt" },
  { command: "undo", description: "↩️ Hoàn tác (tạm: ghi log)" },
]);

function menuText() {
  return (
    "☰ MENU\n" +
    "1) /ghi – ghi siêu nhanh (vd: ck 3800k, ăn 12, gửi vn 60tr)\n" +
    "2) /anh – gửi ảnh giao dịch (OCR)\n" +
    "3) /thongke – hôm nay/tuần/tháng/kỳ\n" +
    "4) /bieudo – biểu đồ (nếu cài chart)\n" +
    "5) /dautu – ghi & xem đầu tư\n" +
    "6) /no – ghi & xem nợ (nhắc hạn)\n" +
    "7) /canhbao – ngân sách & cảnh báo\n" +
    "8) /xuat – xuất Excel/PDF (nếu cài lib)\n" +
    "9) /caidat – cấu hình\n"
  );
}

function inlineYesNo(prefix, payload) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ OK", callback_data: `${prefix}:OK:${payload}` },
          { text: "✏️ Sửa", callback_data: `${prefix}:EDIT:${payload}` },
          { text: "🗑️ Huỷ", callback_data: `${prefix}:CANCEL:${payload}` },
        ],
      ],
    },
  };
}

function inlinePickFund(prefix, payload) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "👨‍👩‍👧 CHUNG", callback_data: `${prefix}:FUND:${FUNDS.CHUNG}:${payload}` },
          { text: "👩 RIÊNG VỢ", callback_data: `${prefix}:FUND:${FUNDS.RIENG_VO}:${payload}` },
          { text: "🇻🇳 VN", callback_data: `${prefix}:FUND:${FUNDS.VN}:${payload}` },
        ],
        [{ text: "🗑️ Huỷ", callback_data: `${prefix}:CANCEL:${payload}` }],
      ],
    },
  };
}

function inlinePickAccount(prefix, payload) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: ACCOUNTS.CHONG, callback_data: `${prefix}:ACC:CHONG:${payload}` }],
        [{ text: ACCOUNTS.VO, callback_data: `${prefix}:ACC:VO:${payload}` }],
        [{ text: ACCOUNTS.AN, callback_data: `${prefix}:ACC:AN:${payload}` }],
        [{ text: ACCOUNTS.ME, callback_data: `${prefix}:ACC:ME:${payload}` }],
        [{ text: ACCOUNTS.VN, callback_data: `${prefix}:ACC:VN:${payload}` }],
        [{ text: "🗑️ Huỷ", callback_data: `${prefix}:CANCEL:${payload}` }],
      ],
    },
  };
}

/* =========================
 * SECTION 14 — TX WRITE HELPERS
 * ========================= */
function genId(prefix = "TX") {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
}

async function writeFXIfNeeded() {
  const rate = await getFxRateKRWtoVND();
  const today = dayjs().format("YYYY-MM-DD");
  // append daily record (idempotent not required; duplicates ok, last wins logically)
  await appendRow(SHEETS.FX, [today, rate, "naver", FX_CACHE.raw]);
  return rate;
}

async function commitTransaction({ userId, personName, rawText, tx }) {
  const fx = await getFxRateKRWtoVND();
  const fxUsed = fx;

  let krwEquiv = 0;
  if (tx.currency === "KRW") krwEquiv = Number(tx.amount || 0);
  else krwEquiv = Math.round(Number(tx.amount || 0) / fxUsed);

  const time = nowKST();
  const periodMode = (await getSetting("PERIOD_MODE")) || DEFAULTS.PERIOD_MODE;
  const pKey = periodKeyFor(time.slice(0, 10), periodMode);

  const row = [
    tx.id,
    time,
    String(userId),
    personName,
    tx.type,
    tx.fund,
    tx.account,
    tx.category,
    tx.subcategory || "",
    tx.merchant || "",
    Number(tx.amount || 0),
    tx.currency,
    krwEquiv,
    fxUsed,
    tx.note || "",
    rawText,
    pKey,
  ];

  await appendRow(SHEETS.TX, row);
  await logAudit(userId, "TX_COMMIT", { row });
}

async function commitInvestment({ userId, personName, rawText, inv }) {
  const fx = await getFxRateKRWtoVND();
  const fxUsed = fx;
  const krwEquiv = inv.currency === "KRW" ? Number(inv.amount || 0) : Math.round(Number(inv.amount || 0) / fxUsed);

  const row = [
    inv.id,
    nowKST(),
    personName,
    inv.asset_type,
    Number(inv.amount || 0),
    inv.currency,
    krwEquiv,
    fxUsed,
    inv.note || "",
    rawText,
  ];
  await appendRow(SHEETS.INVEST, row);
  await logAudit(userId, "INVEST_COMMIT", { row });
}

async function commitDebt({ userId, personName, rawText, debt }) {
  const fx = await getFxRateKRWtoVND();
  const fxUsed = fx;
  const krwEquiv = debt.currency === "KRW" ? Number(debt.amount || 0) : Math.round(Number(debt.amount || 0) / fxUsed);

  const row = [
    debt.id,
    nowKST(),
    personName,
    debt.counterparty,
    debt.role,
    Number(debt.amount || 0),
    debt.currency,
    krwEquiv,
    fxUsed,
    debt.due_date || "",
    debt.status || "OPEN",
    debt.note || "",
    rawText,
  ];
  await appendRow(SHEETS.DEBT, row);
  await logAudit(userId, "DEBT_COMMIT", { row });
}

/* =========================
 * SECTION 15 — MESSAGE → TX OBJECT (with ambiguity handling)
 * ========================= */
function buildTxFromText({ text, userName }) {
  const raw = normalizeSpaces(text);
  const amountToken = extractFirstAmount(raw);
  const due = parseDueFromText(raw);

  const base = inferAccountFundType({ text: raw, userName });

  // Determine currency
  let currency = detectCurrency(raw);
  if (amountToken?.exact && raw.includes("₩")) currency = "KRW";
  if (amountToken?.raw?.toLowerCase().includes("tr")) currency = "VND";

  const { category, subcategory } = categorize(raw);

  // If transfer VN -> currency likely VND if has 'tr' else could be KRW; we keep detection, later ask if missing.
  // Amount required
  if (!amountToken) {
    return { ok: false, reason: "NO_AMOUNT", needs: ["amount"], draft: { ...base, category, subcategory, currency } };
  }

  let amount = amountToken.amount;
  // If user wrote VND explicitly without suffix, do not multiply by 1000
  if (currency === "VND" && amountToken.exact) {
    // already exact number, keep
  }

  // Special rules:
  // - If message starts with "ck" or "vk" and includes only number: treat as income KRW.
  const tLow = lowerFold(raw);
  if (tLow.startsWith("ck") || tLow.startsWith("vk")) {
    currency = "KRW";
  }

  // For VN child spending: if mentions con + VND => force VN account
  if (hasAny(raw, KEYWORDS.CHILD) && currency === "VND") {
    base.fund = FUNDS.VN;
    base.account = ACCOUNTS.VN;
  }

  // For TRANSFER: if not VND and has "tr" then VND; else accept KRW but will be recorded with currency KRW
  // - For transfer, many prefer VND, but user may type KRW equivalent; we accept.

  // Create draft tx
  const tx = {
    id: genId("TX"),
    type: base.type,
    fund: base.fund,
    account: base.account,
    category:
      base.type === TX_TYPES.IN ? "Thu nhập" : base.type === TX_TYPES.TRANSFER ? "Gửi VN" : base.type === TX_TYPES.INVEST ? "Đầu tư" : category,
    subcategory:
      base.type === TX_TYPES.IN ? "" : base.type === TX_TYPES.TRANSFER ? "" : base.type === TX_TYPES.INVEST ? detectInvestType(raw) : subcategory,
    merchant: "",
    amount,
    currency,
    note: "",
    due_date: due || "",
    forced: base.forced,
    raw,
  };

  // Ambiguity checks:
  const needs = [];
  // If OUT but not forced and not clear if chung/riêng vợ (example: "mua mỹ phẩm 50" from wife might be ok; we still keep defaults)
  // If user types without any keyword and does not start with vk, keep CHUNG by default; no need ask.
  // If currency unknown: we already default to KRW; ok.
  // If transfer VN and currency=KRW but includes "tr" missing? already handled.

  return { ok: true, tx, needs };
}

/* =========================
 * SECTION 16 — COMMAND HANDLERS
 * ========================= */
async function handleStart(msg) {
  await rememberChatId(msg.chat.id);
  await logAudit(msg.from.id, "START", { chat: msg.chat.id });

  const text =
    "Chào anh/chị 👋\n" +
    "Bot tài chính gia đình đã sẵn sàng.\n\n" +
    "✅ Gõ siêu nhanh:\n" +
    "• ck 3800k  (lương chồng – CHUNG)\n" +
    "• vk 2860k  (lương vợ – CHUNG về TK thẻ Chồng)\n" +
    "• ăn 12     (chi ăn uống – ₩12,000 – TK thẻ ăn)\n" +
    "• gửi vn 60tr (TRANSFER về Tài khoản Mẹ)\n" +
    "• đất 300tr / vàng 5tr / coin 20tr (đầu tư – CHUNG)\n" +
    "• nợ A 10tr hẹn 25/12\n\n" +
    "Gõ /menu để xem đầy đủ.";
  await bot.sendMessage(msg.chat.id, text);
}

async function handleThongKe(msg, args) {
  const mode = (args[0] || "thang").toLowerCase(); // homnay|tuan|thang|ky
  const fund = (args[1] || "").toUpperCase(); // CHUNG|RIÊNG_VỢ|VN_CHUNG
  const periodMode = (await getSetting("PERIOD_MODE")) || DEFAULTS.PERIOD_MODE;

  const tx = await getAllRows(SHEETS.TX, 5000);

  // Determine period key
  const today = dayjs().format("YYYY-MM-DD");
  let pKey = periodKeyFor(today, mode === "ky" ? "15TO15" : periodMode);

  // Filtering by time range if needed
  let rows = tx.filter((r) => r.period_key === pKey);

  if (mode === "homnay") {
    rows = tx.filter((r) => String(r.time || "").startsWith(today));
    pKey = today;
  } else if (mode === "tuan") {
    const start = dayjs().subtract(6, "day").format("YYYY-MM-DD");
    rows = tx.filter((r) => {
      const d = String(r.time || "").slice(0, 10);
      return d >= start && d <= today;
    });
    pKey = `${start}..${today}`;
  }

  if (fund) rows = rows.filter((r) => r.fund === fund);

  const summary = buildSummary(rows);
  const lines = Object.entries(summary).map(([k, v]) => `• ${k}: ${v}`).join("\n");

  await bot.sendMessage(msg.chat.id, `📊 THỐNG KÊ (${pKey})\n${lines}`);
}

async function handleDauTu(msg) {
  const rows = await getAllRows(SHEETS.INVEST, 5000);
  if (!rows.length) return bot.sendMessage(msg.chat.id, "Chưa có dữ liệu đầu tư.");
  const byType = new Map();
  for (const r of rows) {
    const k = r.asset_type || INVEST_TYPES.OTHER;
    byType.set(k, (byType.get(k) || 0) + Number(r.krw_equiv || 0));
  }
  const top = [...byType.entries()].sort((a, b) => b[1] - a[1]);
  const text =
    "💰 ĐẦU TƯ (KRW quy đổi)\n" +
    top.map(([k, v]) => `• ${k}: ${formatMoney(v, "KRW")}`).join("\n");
  await bot.sendMessage(msg.chat.id, text);
}

async function handleNo(msg) {
  const rows = await getOpenDebts();
  if (!rows.length) return bot.sendMessage(msg.chat.id, "✅ Không có khoản nợ/cho vay OPEN.");

  const lines = rows.slice(0, 20).map((d) => {
    const st = debtDueStatus(d.due_date);
    const flag = st.kind === "OVERDUE" ? "🔴" : st.kind === "DUE_TODAY" ? "🟠" : st.kind === "DUE_SOON" ? "🟡" : "🟢";
    return `${flag} ${d.role === "OWE" ? "Nợ" : "Cho vay"} ${d.counterparty}: ${formatMoney(d.amount, d.currency)} ${
      d.due_date ? `(hẹn ${d.due_date})` : ""
    }`;
  });

  await bot.sendMessage(msg.chat.id, `🧾 NỢ & CHO VAY (OPEN)\n${lines.join("\n")}`);
}

async function handleCanhBao(msg) {
  const periodMode = (await getSetting("PERIOD_MODE")) || DEFAULTS.PERIOD_MODE;
  const today = dayjs().format("YYYY-MM-DD");
  const pKey = periodKeyFor(today, periodMode);

  const alerts = await computeBudgetAlerts(pKey);
  if (!alerts.length) {
    return bot.sendMessage(msg.chat.id, `✅ Không có cảnh báo ngân sách trong kỳ ${pKey}.`);
  }
  const text =
    `⚠️ CẢNH BÁO NGÂN SÁCH (${pKey})\n` +
    alerts
      .map((a) => `• ${a.fund} | ${a.category} (${a.currency}): ${formatMoney(a.spent, a.currency)} / ${formatMoney(a.limit, a.currency)} = ${a.pct}%`)
      .join("\n");
  await bot.sendMessage(msg.chat.id, text);
}

async function handleBieuDo(msg) {
  const periodMode = (await getSetting("PERIOD_MODE")) || DEFAULTS.PERIOD_MODE;
  const pKey = periodKeyFor(dayjs().format("YYYY-MM-DD"), periodMode);
  const tx = await getAllRows(SHEETS.TX, 5000);
  const rows = tx.filter((r) => r.period_key === pKey);

  const grouped = groupByCategory(rows, FUNDS.CHUNG).slice(0, 8);
  if (!grouped.length) return bot.sendMessage(msg.chat.id, "Chưa có dữ liệu chi CHUNG để vẽ biểu đồ.");

  const labels = grouped.map(([k]) => k);
  const values = grouped.map(([_, v]) => v);

  const tmp = path.join(os.tmpdir(), `chart_${Date.now()}.png`);
  const out = await renderChartPng({ title: `Chi CHUNG theo danh mục (${pKey})`, labels, values }, tmp);

  if (!out.ok) {
    return bot.sendMessage(
      msg.chat.id,
      `📈 Biểu đồ chưa bật (lý do: ${out.reason}).\nCài thêm: npm i chartjs-node-canvas\nHoặc xem thống kê: /thongke`
    );
  }
  await bot.sendPhoto(msg.chat.id, tmp, { caption: `📈 Chi CHUNG theo danh mục (${pKey})` });
}

async function handleXuat(msg, args) {
  const kind = (args[0] || "thang").toLowerCase(); // thang|tuan|homnay|ky
  const format = (args[1] || "all").toLowerCase(); // all|excel|pdf

  const periodMode = (await getSetting("PERIOD_MODE")) || DEFAULTS.PERIOD_MODE;
  const today = dayjs().format("YYYY-MM-DD");

  let rows = await getAllRows(SHEETS.TX, 5000);
  let label = "";

  if (kind === "homnay") {
    rows = rows.filter((r) => String(r.time || "").startsWith(today));
    label = today;
  } else if (kind === "tuan") {
    const start = dayjs().subtract(6, "day").format("YYYY-MM-DD");
    rows = rows.filter((r) => {
      const d = String(r.time || "").slice(0, 10);
      return d >= start && d <= today;
    });
    label = `${start}_${today}`;
  } else if (kind === "ky") {
    const pKey = periodKeyFor(today, "15TO15");
    rows = rows.filter((r) => r.period_key === pKey);
    label = pKey;
  } else {
    const pKey = periodKeyFor(today, periodMode);
    rows = rows.filter((r) => r.period_key === pKey);
    label = pKey;
  }

  if (!rows.length) return bot.sendMessage(msg.chat.id, "Không có dữ liệu để xuất.");

  const tmpDir = os.tmpdir();
  const excelPath = path.join(tmpDir, `TX_${label}.xlsx`);
  const pdfPath = path.join(tmpDir, `Summary_${label}.pdf`);

  let excelRes = { ok: false, reason: "" };
  let pdfRes = { ok: false, reason: "" };

  if (format === "all" || format === "excel") {
    excelRes = await exportExcelReport(rows, excelPath);
  }
  if (format === "all" || format === "pdf") {
    const summary = buildSummary(rows);
    pdfRes = await exportPdfSummary(summary, pdfPath);
  }

  if ((format === "all" || format === "excel") && !excelRes.ok) {
    await bot.sendMessage(msg.chat.id, `❌ Xuất Excel chưa bật: ${excelRes.reason}\nCài: npm i exceljs`);
  } else if (excelRes.ok) {
    await bot.sendDocument(msg.chat.id, excelPath, { caption: "🧾 Excel giao dịch" });
  }

  if ((format === "all" || format === "pdf") && !pdfRes.ok) {
    await bot.sendMessage(msg.chat.id, `❌ Xuất PDF chưa bật: ${pdfRes.reason}\nCài: npm i pdfkit`);
  } else if (pdfRes.ok) {
    await bot.sendDocument(msg.chat.id, pdfPath, { caption: "📄 PDF tóm tắt" });
  }
}

async function handleCaiDat(msg) {
  const periodMode = (await getSetting("PERIOD_MODE")) || DEFAULTS.PERIOD_MODE;
  const fx = await getFxRateKRWtoVND();
  const chatIds = await getChatIdsSetting();

  const text =
    "⚙️ CÀI ĐẶT\n" +
    `• PERIOD_MODE: ${periodMode} (MONTH hoặc 15TO15)\n` +
    `• FX hôm nay (Naver): 1 KRW = ${fx} VND\n` +
    `• OCR_PROVIDER: ${ENV.OCR_PROVIDER}\n` +
    `• ChatIds nhắc nợ: ${chatIds || "(chưa lưu)"}\n\n` +
    "Muốn đổi PERIOD_MODE: nhắn `set period 15` hoặc `set period month`";
  await bot.sendMessage(msg.chat.id, text);
}

/* =========================
 * SECTION 17 — MAIN MESSAGE ROUTER
 * ========================= */
async function onTextMessage(msg) {
  if (!isAllowedUser(msg)) return;

  await rememberChatId(msg.chat.id);
  await logAudit(msg.from.id, "TEXT_IN", { text: msg.text });

  const text = normalizeSpaces(msg.text || "");
  const t = lowerFold(text);

  // quick settings
  if (t.startsWith("set period")) {
    if (t.includes("15")) {
      await appendRow(SHEETS.SETTINGS, ["PERIOD_MODE", "15TO15"]);
      return bot.sendMessage(msg.chat.id, "✅ Đã đặt PERIOD_MODE = 15TO15");
    }
    await appendRow(SHEETS.SETTINGS, ["PERIOD_MODE", "MONTH"]);
    return bot.sendMessage(msg.chat.id, "✅ Đã đặt PERIOD_MODE = MONTH");
  }

  // Commands handled by onText too if user types them (besides Telegram /command)
  if (t === "menu") return bot.sendMessage(msg.chat.id, menuText());
  if (t === "/menu") return bot.sendMessage(msg.chat.id, menuText());

  // If pending edit flow
  const pend = getPending(msg.chat.id, msg.from.id);
  if (pend && pend.kind === "EDIT_AMOUNT") {
    const amt = extractFirstAmount(text);
    if (!amt) return bot.sendMessage(msg.chat.id, "❌ Anh/chị nhập số tiền (vd: 12, 120k, 2tr).");
    pend.data.tx.amount = amt.amount;
    clearPending(msg.chat.id, msg.from.id);
    await commitAndReply(msg, pend.data.tx, pend.data.rawText);
    return;
  }

  // Parse as finance entry
  const built = buildTxFromText({ text, userName: msg.from.first_name });
  if (!built.ok) {
    if (built.reason === "NO_AMOUNT") {
      // ask for amount with state
      const draft = built.draft;
      const tx = {
        id: genId("TX"),
        type: draft.type,
        fund: draft.fund,
        account: draft.account,
        category: draft.category || "Khác",
        subcategory: draft.subcategory || "",
        merchant: "",
        amount: 0,
        currency: draft.currency || "KRW",
        note: "",
        raw: draft.raw || text,
      };
      setPending(msg.chat.id, msg.from.id, "EDIT_AMOUNT", { tx, rawText: text });
      return bot.sendMessage(msg.chat.id, "💰 Anh/chị chưa ghi số tiền. Nhập số tiền giúp em (vd: 12, 120k, 2tr).");
    }
    return bot.sendMessage(msg.chat.id, "❌ Em chưa hiểu. Ví dụ: `ck 3800k`, `ăn 12`, `gửi vn 60tr`, `đất 300tr`, `nợ A 10tr hẹn 25/12`");
  }

  // If DEBT or INVEST special handling
  if (built.tx.type === TX_TYPES.INVEST) {
    const inv = {
      id: genId("INV"),
      asset_type: detectInvestType(text),
      amount: built.tx.amount,
      currency: built.tx.currency,
      note: "",
    };
    await commitInvestment({ userId: msg.from.id, personName: msg.from.first_name, rawText: text, inv });
    return bot.sendMessage(msg.chat.id, `✅ Đã ghi ĐẦU TƯ: ${inv.asset_type} – ${formatMoney(inv.amount, inv.currency)} (CHUNG)`);
  }

  if (built.tx.type === TX_TYPES.DEBT_NEW) {
    const counterpartyMatch = normalizeSpaces(text).match(/(?:nợ|vay|cho vay)\s+([^\d]+)\s+/i);
    const counterparty = counterpartyMatch ? normalizeSpaces(counterpartyMatch[1]) : "Chưa rõ";
    const role = detectDebtRole(text);
    const due = parseDueFromText(text);

    const debt = {
      id: genId("DEBT"),
      counterparty,
      role,
      amount: built.tx.amount,
      currency: built.tx.currency,
      due_date: due || "",
      status: "OPEN",
      note: "",
    };
    await commitDebt({ userId: msg.from.id, personName: msg.from.first_name, rawText: text, debt });
    return bot.sendMessage(
      msg.chat.id,
      `✅ Đã ghi ${role === "OWE" ? "NỢ" : "CHO VAY"}: ${counterparty} – ${formatMoney(debt.amount, debt.currency)}${debt.due_date ? ` (hẹn ${debt.due_date})` : ""}`
    );
  }

  // Normal transaction confirmation (inline)
  setPending(msg.chat.id, msg.from.id, "CONFIRM_TX", { tx: built.tx, rawText: text });
  const preview =
    `🧾 Em hiểu như sau:\n` +
    `• Loại: ${built.tx.type}\n` +
    `• Quỹ: ${built.tx.fund}\n` +
    `• TK: ${built.tx.account}\n` +
    `• Danh mục: ${built.tx.category}\n` +
    `• Số tiền: ${formatMoney(built.tx.amount, built.tx.currency)}\n` +
    `${built.tx.subcategory ? `• Nhóm nhỏ: ${built.tx.subcategory}\n` : ""}` +
    `\nXác nhận giúp em?`;
  await bot.sendMessage(msg.chat.id, preview, inlineYesNo("TXCONF", built.tx.id));
}

async function commitAndReply(msg, tx, rawText) {
  // Commit TX
  await commitTransaction({
    userId: msg.from.id,
    personName: msg.from.first_name,
    rawText,
    tx,
  });

  // Also store FX row daily (non-blocking best effort)
  try {
    await writeFXIfNeeded();
  } catch {}

  const fx = await getFxRateKRWtoVND();
  const krwEquiv = tx.currency === "KRW" ? tx.amount : Math.round(tx.amount / fx);

  await bot.sendMessage(
    msg.chat.id,
    `✅ Đã ghi:\n• ${tx.category}${tx.subcategory ? ` (${tx.subcategory})` : ""}\n• ${formatMoney(tx.amount, tx.currency)}\n• Quỹ: ${tx.fund}\n• TK: ${tx.account}\n• KRW quy đổi: ${formatMoney(krwEquiv, "KRW")}`
  );
}

/* =========================
 * SECTION 18 — CALLBACK ROUTER (INLINE BUTTONS)
 * ========================= */
bot.on("callback_query", async (cb) => {
  if (!isAllowedUser(cb)) return;

  const chatId = cb.message.chat.id;
  const userId = cb.from.id;
  const data = cb.data || "";

  await logAudit(userId, "CALLBACK", { data });

  const [prefix, action, p1, p2] = data.split(":");

  if (prefix === "TXCONF") {
    const pend = getPending(chatId, userId);
    if (!pend || pend.kind !== "CONFIRM_TX") {
      await bot.answerCallbackQuery(cb.id, { text: "Hết phiên xác nhận. Gửi lại nội dung giúp em." });
      return;
    }

    if (action === "OK") {
      clearPending(chatId, userId);
      await bot.answerCallbackQuery(cb.id, { text: "OK" });
      await commitAndReply(cb.message, pend.data.tx, pend.data.rawText);
      return;
    }

    if (action === "EDIT") {
      // Choose what to edit: fund/account/amount quickly
      setPending(chatId, userId, "EDIT_MENU", pend.data);
      await bot.answerCallbackQuery(cb.id, { text: "Chọn mục sửa" });
      await bot.sendMessage(
        chatId,
        "✏️ Anh/chị muốn sửa gì?",
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "💰 Số tiền", callback_data: `TXEDIT:AMOUNT:${pend.data.tx.id}` },
                { text: "👛 Quỹ", callback_data: `TXEDIT:FUND:${pend.data.tx.id}` },
                { text: "🏦 Tài khoản", callback_data: `TXEDIT:ACC:${pend.data.tx.id}` },
              ],
              [{ text: "↩️ Quay lại", callback_data: `TXEDIT:BACK:${pend.data.tx.id}` }],
              [{ text: "🗑️ Huỷ", callback_data: `TXEDIT:CANCEL:${pend.data.tx.id}` }],
            ],
          },
        }
      );
      return;
    }

    if (action === "CANCEL") {
      clearPending(chatId, userId);
      await bot.answerCallbackQuery(cb.id, { text: "Đã huỷ" });
      await bot.sendMessage(chatId, "🗑️ Đã huỷ.");
      return;
    }
  }

  if (prefix === "TXEDIT") {
    const pend = getPending(chatId, userId);
    if (!pend || (pend.kind !== "EDIT_MENU" && pend.kind !== "CONFIRM_TX")) {
      await bot.answerCallbackQuery(cb.id, { text: "Hết phiên sửa. Gửi lại nội dung giúp em." });
      return;
    }

    if (action === "AMOUNT") {
      // switch to amount input
      setPending(chatId, userId, "EDIT_AMOUNT", pend.data);
      await bot.answerCallbackQuery(cb.id, { text: "Nhập số tiền mới" });
      await bot.sendMessage(chatId, "💰 Nhập số tiền mới (vd: 12, 120k, 2tr):");
      return;
    }

    if (action === "FUND") {
      setPending(chatId, userId, "EDIT_FUND", pend.data);
      await bot.answerCallbackQuery(cb.id, { text: "Chọn quỹ" });
      await bot.sendMessage(chatId, "👛 Chọn quỹ:", inlinePickFund("TXFUND", pend.data.tx.id));
      return;
    }

    if (action === "ACC") {
      setPending(chatId, userId, "EDIT_ACC", pend.data);
      await bot.answerCallbackQuery(cb.id, { text: "Chọn tài khoản" });
      await bot.sendMessage(chatId, "🏦 Chọn tài khoản:", inlinePickAccount("TXACC", pend.data.tx.id));
      return;
    }

    if (action === "BACK") {
      await bot.answerCallbackQuery(cb.id, { text: "Quay lại" });
      // Re-show confirmation
      setPending(chatId, userId, "CONFIRM_TX", pend.data);
      const tx = pend.data.tx;
      const preview =
        `🧾 Em hiểu như sau:\n` +
        `• Loại: ${tx.type}\n• Quỹ: ${tx.fund}\n• TK: ${tx.account}\n• Danh mục: ${tx.category}\n• Số tiền: ${formatMoney(tx.amount, tx.currency)}\n\nXác nhận giúp em?`;
      await bot.sendMessage(chatId, preview, inlineYesNo("TXCONF", tx.id));
      return;
    }

    if (action === "CANCEL") {
      clearPending(chatId, userId);
      await bot.answerCallbackQuery(cb.id, { text: "Đã huỷ" });
      await bot.sendMessage(chatId, "🗑️ Đã huỷ.");
      return;
    }
  }

  if (prefix === "TXFUND") {
    const pend = getPending(chatId, userId);
    if (!pend || pend.kind !== "EDIT_FUND") {
      await bot.answerCallbackQuery(cb.id, { text: "Hết phiên sửa." });
      return;
    }
    if (action === "FUND") {
      const fund = p1;
      pend.data.tx.fund = fund;
      // auto account suggestion when VN fund
      if (fund === FUNDS.VN && pend.data.tx.type === TX_TYPES.OUT) pend.data.tx.account = ACCOUNTS.VN;
      await bot.answerCallbackQuery(cb.id, { text: `Quỹ: ${fund}` });
      // back to confirm
      setPending(chatId, userId, "CONFIRM_TX", pend.data);
      const tx = pend.data.tx;
      const preview =
        `🧾 Đã sửa quỹ.\n• Quỹ: ${tx.fund}\n• TK: ${tx.account}\n• Số tiền: ${formatMoney(tx.amount, tx.currency)}\n\nXác nhận giúp em?`;
      await bot.sendMessage(chatId, preview, inlineYesNo("TXCONF", tx.id));
      return;
    }
    if (action === "CANCEL") {
      clearPending(chatId, userId);
      await bot.answerCallbackQuery(cb.id, { text: "Huỷ" });
      return;
    }
  }

  if (prefix === "TXACC") {
    const pend = getPending(chatId, userId);
    if (!pend || pend.kind !== "EDIT_ACC") {
      await bot.answerCallbackQuery(cb.id, { text: "Hết phiên sửa." });
      return;
    }
    if (action === "ACC") {
      const which = p1;
      const map = { CHONG: ACCOUNTS.CHONG, VO: ACCOUNTS.VO, AN: ACCOUNTS.AN, ME: ACCOUNTS.ME, VN: ACCOUNTS.VN };
      pend.data.tx.account = map[which] || pend.data.tx.account;
      await bot.answerCallbackQuery(cb.id, { text: `TK: ${pend.data.tx.account}` });
      // If choose VO account, default fund to RIÊNG_VỢ unless transfer/income
      if (pend.data.tx.account === ACCOUNTS.VO && pend.data.tx.type === TX_TYPES.OUT) pend.data.tx.fund = FUNDS.RIENG_VO;
      setPending(chatId, userId, "CONFIRM_TX", pend.data);
      const tx = pend.data.tx;
      const preview =
        `🧾 Đã sửa tài khoản.\n• Quỹ: ${tx.fund}\n• TK: ${tx.account}\n• Số tiền: ${formatMoney(tx.amount, tx.currency)}\n\nXác nhận giúp em?`;
      await bot.sendMessage(chatId, preview, inlineYesNo("TXCONF", tx.id));
      return;
    }
    if (action === "CANCEL") {
      clearPending(chatId, userId);
      await bot.answerCallbackQuery(cb.id, { text: "Huỷ" });
      return;
    }
  }

  await bot.answerCallbackQuery(cb.id, { text: "OK" });
});

/* =========================
 * SECTION 19 — PHOTO HANDLER (OCR FLOW)
 * ========================= */
bot.on("photo", async (msg) => {
  if (!isAllowedUser(msg)) return;
  await rememberChatId(msg.chat.id);
  await logAudit(msg.from.id, "PHOTO_IN", { sizes: msg.photo?.length || 0 });

  const largest = msg.photo?.[msg.photo.length - 1];
  if (!largest) return;

  const fileLink = await bot.getFileLink(largest.file_id);
  const ocr = await ocrExtractTransactionsFromImage({ fileUrl: fileLink });

  if (!ocr.ok) {
    const why =
      ocr.reason === "OCR_PROVIDER=none"
        ? "OCR đang tắt (OCR_PROVIDER=none)."
        : ocr.reason === "Missing OCR_API_KEY"
        ? "Thiếu OCR_API_KEY."
        : ocr.reason;
    await bot.sendMessage(msg.chat.id, `📷 Đã nhận ảnh.\nOCR chưa chạy: ${why}\nKhi anh gắn key + bật provider, bot sẽ tự tách giao dịch từ ảnh.`);
    return;
  }

  // If got items, propose batch confirm
  const items = ocr.items || [];
  if (!items.length) {
    await bot.sendMessage(msg.chat.id, "📷 OCR chạy nhưng chưa trích được giao dịch nào từ ảnh này.");
    return;
  }

  // Store pending batch
  const batchId = genId("OCR");
  setPending(msg.chat.id, msg.from.id, "OCR_BATCH", { batchId, items });

  const preview = items
    .slice(0, 10)
    .map((it, idx) => `${idx + 1}) ${it.time || ""} ${it.merchant || ""} ${formatMoney(it.amount, it.currency || "KRW")}`)
    .join("\n");

  await bot.sendMessage(
    msg.chat.id,
    `🤖 OCR đọc được ${items.length} giao dịch:\n${preview}\n\nAnh/chị muốn ghi tất cả không?`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Ghi tất cả", callback_data: `OCR:ALL:${batchId}` }],
          [{ text: "🗑️ Huỷ", callback_data: `OCR:CANCEL:${batchId}` }],
        ],
      },
    }
  );
});

bot.on("callback_query", async (cb) => {
  const data = cb.data || "";
  const [prefix, action, batchId] = data.split(":");
  if (prefix !== "OCR") return;

  if (!isAllowedUser(cb)) return;

  const chatId = cb.message.chat.id;
  const userId = cb.from.id;

  const pend = getPending(chatId, userId);
  if (!pend || pend.kind !== "OCR_BATCH" || pend.data.batchId !== batchId) {
    await bot.answerCallbackQuery(cb.id, { text: "Hết phiên OCR. Gửi ảnh lại giúp em." });
    return;
  }

  if (action === "CANCEL") {
    clearPending(chatId, userId);
    await bot.answerCallbackQuery(cb.id, { text: "Đã huỷ" });
    await bot.sendMessage(chatId, "🗑️ Đã huỷ ghi từ OCR.");
    return;
  }

  if (action === "ALL") {
    await bot.answerCallbackQuery(cb.id, { text: "Đang ghi..." });

    for (const it of pend.data.items) {
      const base = inferAccountFundType({ text: it.raw || it.merchant || "", userName: cb.from.first_name });
      const { category, subcategory } = categorize(it.raw || it.merchant || "");

      const tx = {
        id: genId("TX"),
        type: TX_TYPES.OUT,
        fund: base.fund,
        account: base.account,
        category,
        subcategory,
        merchant: it.merchant || "",
        amount: Number(it.amount || 0),
        currency: it.currency || "KRW",
        note: "From OCR",
      };

      await commitTransaction({
        userId,
        personName: cb.from.first_name,
        rawText: it.raw || "OCR",
        tx,
      });
    }

    clearPending(chatId, userId);
    await bot.sendMessage(chatId, `✅ Đã ghi ${pend.data.items.length} giao dịch từ OCR.`);
    return;
  }
});

/* =========================
 * SECTION 20 — COMMAND ROUTER
 * ========================= */
bot.onText(/^\/start$/, async (msg) => handleStart(msg));
bot.onText(/^\/menu$/, async (msg) => bot.sendMessage(msg.chat.id, menuText()));
bot.onText(/^\/ghi(?:\s+(.+))?$/, async (msg, match) => {
  // If user provides inline content after /ghi, parse it; else show hints
  const content = normalizeSpaces(match?.[1] || "");
  if (!content) {
    return bot.sendMessage(
      msg.chat.id,
      "➕ Ghi giao dịch:\nVí dụ:\n• ck 3800k\n• vk 2860k\n• ăn 12\n• gửi vn 60tr\n• đất 300tr\n• nợ A 10tr hẹn 25/12"
    );
  }
  // simulate normal text flow
  msg.text = content;
  return onTextMessage(msg);
});

bot.onText(/^\/anh$/, async (msg) => {
  await bot.sendMessage(msg.chat.id, "📷 Gửi ảnh giao dịch vào đây. (OCR sẽ chạy khi anh bật OCR_PROVIDER + OCR_API_KEY)");
});

bot.onText(/^\/thongke(?:\s+(.+))?$/, async (msg, match) => {
  const args = normalizeSpaces(match?.[1] || "").split(" ").filter(Boolean);
  await handleThongKe(msg, args);
});

bot.onText(/^\/bieudo$/, async (msg) => handleBieuDo(msg));
bot.onText(/^\/dautu$/, async (msg) => handleDauTu(msg));
bot.onText(/^\/no$/, async (msg) => handleNo(msg));
bot.onText(/^\/canhbao$/, async (msg) => handleCanhBao(msg));
bot.onText(/^\/xuat(?:\s+(.+))?$/, async (msg, match) => {
  const args = normalizeSpaces(match?.[1] || "").split(" ").filter(Boolean);
  await handleXuat(msg, args);
});
bot.onText(/^\/caidat$/, async (msg) => handleCaiDat(msg));

/* Any other text goes here */
bot.on("message", async (msg) => {
  // skip commands already handled by onText
  if (!msg.text) return;
  if (msg.text.startsWith("/")) return;
  await onTextMessage(msg);
});

/* =========================
 * SECTION 21 — SCHEDULERS
 * ========================= */
// Daily 08:00 KST: store FX
cron.schedule("0 8 * * *", async () => {
  try {
    const rate = await getFxRateKRWtoVND();
    await appendRow(SHEETS.FX, [dayjs().format("YYYY-MM-DD"), rate, "naver", FX_CACHE.raw]);
    console.log("FX updated", rate);
  } catch (e) {
    console.error("FX cron error", e?.message || e);
  }
}, { timezone: ENV.TZ });

// Daily 09:00 KST: debt reminders
cron.schedule("0 9 * * *", async () => {
  try {
    // Use latest chat ids
    const chatIdsStr = await getChatIdsSetting();
    if (!chatIdsStr) return;
    await sendDebtReminders();
  } catch (e) {
    console.error("Debt cron error", e?.message || e);
  }
}, { timezone: ENV.TZ });

/* =========================
 * SECTION 22 — BOOTSTRAP
 * ========================= */
(async () => {
  try {
    await ensureSheetsExist();
    // write initial FX
    await writeFXIfNeeded();

    // save first CHAT_IDS key if missing
    await setSettingIfMissing("CHAT_IDS", "");

    console.log("✅ FINANCE BOT ULTIMATE – READY");
    console.log(`Sheets: ${ENV.GOOGLE_SHEET_ID}`);
    console.log(`OCR_PROVIDER: ${ENV.OCR_PROVIDER}`);
    console.log(`TZ: ${ENV.TZ}`);
  } catch (e) {
    console.error("BOOT ERROR", e?.message || e);
    process.exit(1);
  }
})();
