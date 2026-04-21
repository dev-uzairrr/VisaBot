import "dotenv/config";
import Database from "better-sqlite3";
import { logger } from "./logger.js";

const DB_PATH = process.env.DB_PATH || "./data.db";
const db = new Database(DB_PATH);

function nowIso() {
  return new Date().toISOString();
}

export function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      api_key TEXT NOT NULL,
      headless TEXT NOT NULL DEFAULT 'false',
      proxy_server TEXT,
      website_url TEXT NOT NULL,
      login_email TEXT NOT NULL,
      login_password TEXT NOT NULL,
      category_name TEXT NOT NULL DEFAULT 'Schengen VISA',
      category_wait_ms INTEGER NOT NULL DEFAULT 120000,
      category_poll_ms INTEGER NOT NULL DEFAULT 2000,
      available_view_wait_ms INTEGER NOT NULL DEFAULT 60000,
      available_view_poll_ms INTEGER NOT NULL DEFAULT 1500,
      slot_wait_ms INTEGER NOT NULL DEFAULT 120000,
      slot_poll_ms INTEGER NOT NULL DEFAULT 1500,
      post_form_wait_ms INTEGER NOT NULL DEFAULT 90000,
      post_form_poll_ms INTEGER NOT NULL DEFAULT 1500,
      user_full_name TEXT NOT NULL,
      user_phone TEXT NOT NULL,
      user_mobile TEXT NOT NULL,
      user_region_employment_in_greece TEXT NOT NULL,
      user_am TEXT NOT NULL,
      user_apofasi_year TEXT NOT NULL,
      user_apofasi_number TEXT NOT NULL,
      user_greek_employer_name TEXT NOT NULL,
      user_passport_number TEXT NOT NULL,
      user_declare_informative TEXT NOT NULL DEFAULT 'true',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS booking_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      appointment_booked INTEGER NOT NULL DEFAULT 0,
      appointment_reference TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );
  `);
}

function envAccount() {
  if (!process.env.LOGIN_EMAIL || !process.env.LOGIN_PASSWORD || !process.env.WEBSITE_URL) {
    return null;
  }
  return {
    label: "env-primary",
    active: 1,
    api_key: process.env.API_KEY || "",
    headless: process.env.HEADLESS || "false",
    proxy_server: process.env.PROXY_SERVER || null,
    website_url: process.env.WEBSITE_URL,
    login_email: process.env.LOGIN_EMAIL,
    login_password: process.env.LOGIN_PASSWORD,
    category_name: process.env.CATEGORY_NAME || "Schengen VISA",
    category_wait_ms: Number(process.env.CATEGORY_WAIT_MS || 120000),
    category_poll_ms: Number(process.env.CATEGORY_POLL_MS || 2000),
    available_view_wait_ms: Number(process.env.AVAILABLE_VIEW_WAIT_MS || 60000),
    available_view_poll_ms: Number(process.env.AVAILABLE_VIEW_POLL_MS || 1500),
    slot_wait_ms: Number(process.env.SLOT_WAIT_MS || 120000),
    slot_poll_ms: Number(process.env.SLOT_POLL_MS || 1500),
    post_form_wait_ms: Number(process.env.POST_FORM_WAIT_MS || 90000),
    post_form_poll_ms: Number(process.env.POST_FORM_POLL_MS || 1500),
    user_full_name: process.env.USER_FULL_NAME || "Test User",
    user_phone: process.env.USER_PHONE || "03001234567",
    user_mobile: process.env.USER_MOBILE || "03111234567",
    user_region_employment_in_greece: process.env.USER_REGION_EMPLOYMENT_IN_GREECE || "ΑΘΗΝΑ",
    user_am: process.env.USER_AM || "1000",
    user_apofasi_year: process.env.USER_APOFASI_YEAR || "2025",
    user_apofasi_number: process.env.USER_APOFASI_NUMBER || "9999",
    user_greek_employer_name: process.env.USER_GREEK_EMPLOYER_NAME || "EMPLOYER",
    user_passport_number: process.env.USER_PASSPORT_NUMBER || "AB123456",
    user_declare_informative: process.env.USER_DECLARE_INFORMATIVE || "true",
  };
}

function dummyAccount(index) {
  return {
    label: `dummy-${index}`,
    active: 1,
    api_key: process.env.API_KEY || "dummy_api_key",
    headless: "false",
    proxy_server: null,
    website_url:
      process.env.WEBSITE_URL || "https://schedule.cf-grcon-isl-pakistan.com/schedule/grcon-isl-pakistan",
    login_email: `dummy${index}@example.com`,
    login_password: `dummyPass${index}123`,
    category_name: process.env.CATEGORY_NAME || "Schengen VISA",
    category_wait_ms: 120000,
    category_poll_ms: 2000,
    available_view_wait_ms: 60000,
    available_view_poll_ms: 1500,
    slot_wait_ms: 120000,
    slot_poll_ms: 1500,
    post_form_wait_ms: 90000,
    post_form_poll_ms: 1500,
    user_full_name: `Dummy User ${index}`,
    user_phone: `0300000000${index}`,
    user_mobile: `0311000000${index}`,
    user_region_employment_in_greece: "ΑΘΗΝΑ",
    user_am: `${3000 + index}`,
    user_apofasi_year: "2025",
    user_apofasi_number: `${16000 + index}`,
    user_greek_employer_name: `DUMMY EMPLOYER ${index}`,
    user_passport_number: `DU${index}12345`,
    user_declare_informative: "true",
  };
}

function insertAccount(account) {
  const stmt = db.prepare(`
    INSERT INTO accounts (
      label, active, api_key, headless, proxy_server, website_url, login_email, login_password,
      category_name, category_wait_ms, category_poll_ms, available_view_wait_ms, available_view_poll_ms,
      slot_wait_ms, slot_poll_ms, post_form_wait_ms, post_form_poll_ms,
      user_full_name, user_phone, user_mobile, user_region_employment_in_greece, user_am,
      user_apofasi_year, user_apofasi_number, user_greek_employer_name, user_passport_number,
      user_declare_informative, created_at, updated_at
    ) VALUES (
      @label, @active, @api_key, @headless, @proxy_server, @website_url, @login_email, @login_password,
      @category_name, @category_wait_ms, @category_poll_ms, @available_view_wait_ms, @available_view_poll_ms,
      @slot_wait_ms, @slot_poll_ms, @post_form_wait_ms, @post_form_poll_ms,
      @user_full_name, @user_phone, @user_mobile, @user_region_employment_in_greece, @user_am,
      @user_apofasi_year, @user_apofasi_number, @user_greek_employer_name, @user_passport_number,
      @user_declare_informative, @created_at, @updated_at
    )
  `);
  const ts = nowIso();
  stmt.run({ ...account, created_at: ts, updated_at: ts });
}

export function seedAccountsIfEmpty() {
  const total = db.prepare("SELECT COUNT(*) AS total FROM accounts").get().total;
  if (total > 0) return;

  const fromEnv = envAccount();
  if (fromEnv) insertAccount(fromEnv);
  for (let i = 1; i <= 5; i += 1) insertAccount(dummyAccount(i));
  logger.info("Seeded accounts table with .env account and 5 dummy accounts");
}

export function getActiveAccounts() {
  return db
    .prepare("SELECT * FROM accounts WHERE active = 1 ORDER BY id ASC")
    .all();
}

export function listAccounts() {
  return db
    .prepare("SELECT id, label, active, login_email, website_url, created_at, updated_at FROM accounts ORDER BY id ASC")
    .all();
}

export function addAccount(record) {
  insertAccount({ ...record, active: record.active ?? 1 });
}

export function updateAccount(id, patch) {
  const columns = Object.keys(patch || {});
  if (columns.length === 0) return;
  const setClause = columns.map((c) => `${c} = @${c}`).join(", ");
  db.prepare(`UPDATE accounts SET ${setClause}, updated_at = @updated_at WHERE id = @id`).run({
    id,
    ...patch,
    updated_at: nowIso(),
  });
}

export function deleteAccount(id) {
  db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
}

export function closeDb() {
  db.close();
}
