import "dotenv/config";
import { addAccount, closeDb, deleteAccount, initDb, listAccounts, seedAccountsIfEmpty, updateAccount } from "./db.js";

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, ...rest] = arg.slice(2).split("=");
    args[key] = rest.join("=");
  }
  return args;
}

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

initDb();
seedAccountsIfEmpty();

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

if (cmd === "list") {
  console.table(listAccounts());
  closeDb();
  process.exit(0);
}

if (cmd === "delete") {
  const id = toInt(args.id, NaN);
  if (!Number.isFinite(id)) {
    throw new Error("Usage: npm run db:delete -- --id=2");
  }
  deleteAccount(id);
  console.log(`Deleted account id=${id}`);
  closeDb();
  process.exit(0);
}

if (cmd === "add") {
  addAccount({
    label: args.label || "manual-account",
    active: toInt(args.active, 1),
    api_key: args.api_key || process.env.API_KEY || "dummy_api_key",
    headless: args.headless || "false",
    proxy_server: args.proxy_server || null,
    website_url: args.website_url || process.env.WEBSITE_URL || "",
    login_email: args.login_email || "",
    login_password: args.login_password || "",
    category_name: args.category_name || process.env.CATEGORY_NAME || "Schengen VISA",
    category_wait_ms: toInt(args.category_wait_ms, 120000),
    category_poll_ms: toInt(args.category_poll_ms, 2000),
    available_view_wait_ms: toInt(args.available_view_wait_ms, 60000),
    available_view_poll_ms: toInt(args.available_view_poll_ms, 1500),
    slot_wait_ms: toInt(args.slot_wait_ms, 120000),
    slot_poll_ms: toInt(args.slot_poll_ms, 1500),
    post_form_wait_ms: toInt(args.post_form_wait_ms, 90000),
    post_form_poll_ms: toInt(args.post_form_poll_ms, 1500),
    user_full_name: args.user_full_name || "Manual User",
    user_phone: args.user_phone || "03000000000",
    user_mobile: args.user_mobile || "03110000000",
    user_region_employment_in_greece: args.user_region_employment_in_greece || "ΑΘΗΝΑ",
    user_am: args.user_am || "3001",
    user_apofasi_year: args.user_apofasi_year || "2025",
    user_apofasi_number: args.user_apofasi_number || "16001",
    user_greek_employer_name: args.user_greek_employer_name || "MANUAL EMPLOYER",
    user_passport_number: args.user_passport_number || "MN123456",
    user_declare_informative: args.user_declare_informative || "true",
  });
  console.log("Account added");
  closeDb();
  process.exit(0);
}

if (cmd === "update") {
  const id = toInt(args.id, NaN);
  if (!Number.isFinite(id)) {
    throw new Error("Usage: npm run db:update -- --id=2 --active=0");
  }
  const patch = { ...args };
  delete patch.id;
  const intFields = [
    "active",
    "category_wait_ms",
    "category_poll_ms",
    "available_view_wait_ms",
    "available_view_poll_ms",
    "slot_wait_ms",
    "slot_poll_ms",
    "post_form_wait_ms",
    "post_form_poll_ms",
  ];
  for (const f of intFields) {
    if (patch[f] !== undefined) patch[f] = toInt(patch[f], patch[f]);
  }
  updateAccount(id, patch);
  console.log(`Account updated id=${id}`);
  closeDb();
  process.exit(0);
}

console.log(`
Usage:
  npm run db:list
  npm run db:add -- --label=acc1 --login_email=user@example.com --login_password=secret --website_url=https://...
  npm run db:update -- --id=1 --active=0 --category_name="Schengen VISA"
  npm run db:delete -- --id=1
`);
closeDb();
