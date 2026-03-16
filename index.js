require("dotenv").config();
const express     = require("express");
const cors        = require("cors");
const TelegramBot = require("node-telegram-bot-api");
const ExcelJS     = require("exceljs");
const path        = require("path");
const fs          = require("fs");

// ─── Config ───────────────────────────────────────────────────────────────────
const TOKEN        = process.env.TELEGRAM_TOKEN;
const ADMIN_PHONE  = process.env.ADMIN_PHONE;
const PORT         = process.env.PORT || 3001;
const DATA_DIR     = path.join(__dirname, "data");
const EXCEL_PATH   = path.join(DATA_DIR, "clients.xlsx");
const USERS_PATH   = path.join(DATA_DIR, "users.json");
const CLIENTS_PATH = path.join(DATA_DIR, "clients.json");

if (!TOKEN)       { console.error("❌  TELEGRAM_TOKEN missing"); process.exit(1); }
if (!ADMIN_PHONE) { console.error("❌  ADMIN_PHONE missing");    process.exit(1); }
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── Helpers: date ────────────────────────────────────────────────────────────
function nowIST() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}
function todayIST() {
  return new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
}

// ─── Client store (JSON as primary, Excel as export) ──────────────────────────
// Client shape:
// { id, name, number, product, price, status, notes: [{text, by, at}],
//   addedBy, addedOn, followUpDate, followUpNote }

function loadClients() {
  if (!fs.existsSync(CLIENTS_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(CLIENTS_PATH, "utf8")); }
  catch { return []; }
}
function saveClients(list) {
  fs.writeFileSync(CLIENTS_PATH, JSON.stringify(list, null, 2));
}
function nextId() {
  const list = loadClients();
  return list.length ? Math.max(...list.map(c => c.id)) + 1 : 1;
}
function findClient(id) {
  return loadClients().find(c => c.id === Number(id));
}

// ─── User store ───────────────────────────────────────────────────────────────
function loadUsers() {
  if (!fs.existsSync(USERS_PATH)) return { approved: {}, pending: {} };
  try { return JSON.parse(fs.readFileSync(USERS_PATH, "utf8")); }
  catch { return { approved: {}, pending: {} }; }
}
function saveUsers(u) { fs.writeFileSync(USERS_PATH, JSON.stringify(u, null, 2)); }
function normalizePhone(p) { return String(p).replace(/\D/g, ""); }
function isAdmin(phone)    { return normalizePhone(phone) === normalizePhone(ADMIN_PHONE); }
function getApprovedByChatId(chatId) {
  const users = loadUsers();
  return Object.values(users.approved).find(u => Number(u.chatId) === Number(chatId));
}
function approveUser(phone, name, chatId) {
  const u = loadUsers(), p = normalizePhone(phone);
  u.approved[p] = { name, chatId, phone: p, addedAt: new Date().toISOString() };
  delete u.pending[p];
  saveUsers(u);
}
function removeUser(phone) {
  const u = loadUsers(), p = normalizePhone(phone);
  delete u.approved[p];
  saveUsers(u);
}
function addPending(phone, name, chatId) {
  const u = loadUsers(), p = normalizePhone(phone);
  if (u.approved[p]) return "already_approved";
  u.pending[p] = { name, chatId, phone: p, requestedAt: new Date().toISOString() };
  saveUsers(u);
  return "added";
}

// ─── Excel export ─────────────────────────────────────────────────────────────
async function rebuildExcel() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Clients");
  ws.columns = [
    { header: "ID",          key: "id",          width: 6  },
    { header: "Name",        key: "name",        width: 22 },
    { header: "Number",      key: "number",      width: 16 },
    { header: "Product",     key: "product",     width: 22 },
    { header: "Price (₹)",   key: "price",       width: 14 },
    { header: "Status",      key: "status",      width: 12 },
    { header: "Last Note",   key: "lastNote",    width: 38 },
    { header: "Follow Up",   key: "followUpDate",width: 14 },
    { header: "Added By",    key: "addedBy",     width: 16 },
    { header: "Added On",    key: "addedOn",     width: 22 },
  ];
  ws.getRow(1).eachCell(cell => {
    cell.font      = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill      = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2563EB" } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
  });
  ws.getRow(1).height = 22;

  const statusColors = { Hot: "FFFEE2E2", Warm: "FFFFF7ED", Cold: "FFEFF6FF", Closed: "FFF0FDF4" };
  loadClients().forEach((c, i) => {
    const lastNote = c.notes?.length ? c.notes[c.notes.length - 1].text : "";
    const row = ws.addRow({
      id: c.id, name: c.name, number: c.number, product: c.product,
      price: c.price, status: c.status || "Warm",
      lastNote, followUpDate: c.followUpDate || "",
      addedBy: c.addedBy, addedOn: c.addedOn,
    });
    const bg = statusColors[c.status] || (i % 2 === 0 ? "FFEFF6FF" : "FFFFFFFF");
    row.eachCell(cell => {
      cell.fill      = { type: "pattern", pattern: "solid", fgColor: { argb: bg } };
      cell.alignment = { vertical: "middle", wrapText: true };
    });
    row.height = 20;
  });
  await wb.xlsx.writeFile(EXCEL_PATH);
}

// ─── Smart parser — FLEXIBLE FORMAT ──────────────────────────────────────────
// Supports 3 formats:
//
// 1. Quick (1 line):   Rahul Sharma 9876543210 CRM 45000
// 2. Slash separated:  Rahul Sharma / 9876543210 / CRM / 45000
// 3. Key-value:        Name: Rahul\nNumber: 98765\nProduct: CRM\nPrice: 45000
//
// Only Name, Number, Product are required. Price + notes are optional.

function smartParse(text) {
const fields = { status: "Hot" };
  const t = text.trim();

  // ── Key-value format (has ":" lines) ──
  if (t.includes(":") && t.includes("\n")) {
    for (const line of t.split("\n")) {
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      const k = line.slice(0, idx).trim().toLowerCase();
      const v = line.slice(idx + 1).trim();
      if (!v) continue;
      if (["name"].includes(k))                                     fields.name    = v;
      else if (["number","phone","mob","mobile"].includes(k))        fields.number  = v;
      else if (["product","service","item","p"].includes(k))         fields.product = v;
      else if (["price","amount","amt","cost"].includes(k))          fields.price   = v;
      else if (["note","notes","talk","last talk","remark"].includes(k)) fields.note = v;
      else if (["status","stage"].includes(k))                       fields.status  = capitalize(v);
      else if (["followup","follow up","follow-up","reminder"].includes(k)) fields.followUpDate = v;
    }
    const missing = ["name","number","product"].filter(f => !fields[f]);
    return { fields, missing, format: "keyvalue" };
  }

  // ── Slash-separated format ──
  if (t.includes("/")) {
    const parts = t.split("/").map(s => s.trim()).filter(Boolean);
    if (parts.length >= 3) {
      fields.name    = parts[0];
      fields.number  = parts[1];
      fields.product = parts[2];
      if (parts[3]) fields.price = parts[3];
      if (parts[4]) fields.note  = parts[4];
      const missing = ["name","number","product"].filter(f => !fields[f]);
      return { fields, missing, format: "slash" };
    }
  }

  // ── Quick single-line format: Name Number Product Price ──
  // Phone number detection: 10+ digit sequence
  const phoneMatch = t.match(/\b(\+?[\d\s\-]{10,15})\b/);
  if (phoneMatch) {
    const phone  = phoneMatch[1].replace(/\s/g, "");
    const before = t.slice(0, phoneMatch.index).trim();
    const after  = t.slice(phoneMatch.index + phoneMatch[0].length).trim();
    // "after" is "Product Price" or just "Product"
    const afterParts = after.split(/\s+/);
    // Last token that looks like a number = price
    const lastToken = afterParts[afterParts.length - 1];
    const looksLikePrice = /^\d[\d,.kK lL]*$/.test(lastToken);
    fields.name    = before || null;
    fields.number  = phone;
    fields.product = looksLikePrice ? afterParts.slice(0, -1).join(" ") : after;
    if (looksLikePrice) fields.price = lastToken;
    const missing = ["name","number","product"].filter(f => !fields[f]);
    return { fields, missing, format: "quick" };
  }

  return { fields, missing: ["name","number","product"], format: "unknown" };
}

function capitalize(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// ─── Bot setup ────────────────────────────────────────────────────────────────
const bot = new TelegramBot(TOKEN, { polling: true });
let adminChatId = null;

// Pending states: waiting for extra input after a command
const pendingState = {}; // chatId → { action, clientId, ... }

function notifyAdmin(text) {
  if (adminChatId) bot.sendMessage(adminChatId, text, { parse_mode: "Markdown" });
}

// ── /start ────────────────────────────────────────────────────────────────────
bot.onText(/\/start/, msg => {
  // If already approved, just welcome them directly
  const existing = getApprovedByChatId(msg.chat.id);
  if (existing) {
    return bot.sendMessage(msg.chat.id,
      `✅ *Welcome back, ${existing.name}!*\n\nSend /help to see how to add clients.`,
      { parse_mode: "Markdown" }
    );
  }

  bot.sendMessage(msg.chat.id,
    "👋 *Welcome to Client Tracker!*\n\nTap the button below to share your phone number and request access.",
    {
      parse_mode: "Markdown",
      reply_markup: {
        keyboard: [[{ text: "📱 Share my phone number", request_contact: true }]],
        resize_keyboard: true, one_time_keyboard: true,
      },
    }
  );
});


// ── Contact received ──────────────────────────────────────────────────────────
bot.on("contact", msg => {
  const contact = msg.contact;
  const phone   = normalizePhone(contact.phone_number);
  const name    = [contact.first_name, contact.last_name].filter(Boolean).join(" ");
  const chatId  = msg.chat.id;

  if (isAdmin(phone)) {
    adminChatId = chatId;
    approveUser(phone, name, Number(chatId));
    return bot.sendMessage(chatId,
      `✅ *Welcome, ${name}! You're the admin.*\n\n` +
      "📌 *3 ways to add a client:*\n\n" +
      "*1. Quick (fastest):*\n`Rahul Sharma 9876543210 CRM 45000`\n\n" +
      "*2. Slash separated:*\n`Rahul / 9876543210 / CRM / 45000`\n\n" +
      "*3. Detailed:*\n`Name: Rahul\nNumber: 9876543210\nProduct: CRM\nPrice: 45000\nNote: Wants demo`\n\n" +
      "Only Name, Number, Product are required.\n\n" +
      "/help — all commands",
      { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
    );
  }

  if (Object.values(loadUsers().approved).find(u => u.phone === phone)) {
  // Update their chatId in case it was null
  const u = loadUsers();
  u.approved[phone].chatId = Number(chatId);
  saveUsers(u);
  return bot.sendMessage(chatId,
    "✅ *You already have access!*\n\nSend /help to get started.",
    { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
  );
}

  addPending(phone, name, Number(chatId));
  bot.sendMessage(chatId,
    `⏳ *Request sent, ${name}!*\n\nYou'll get a message once approved.`,
    { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
  );
  notifyAdmin(`🔔 *New access request*\n\n👤 ${name}\n📞 +${phone}\n\`/adduser +${phone}\``);
});

// ── /help ─────────────────────────────────────────────────────────────────────
bot.onText(/\/help/, msg => {
  const user = getApprovedByChatId(msg.chat.id);
  if (!user) return bot.sendMessage(msg.chat.id, "⛔ No access. Send /start.");

  const adminCommands = isAdmin(user.phone)
    ? "\n*Admin:*\n`/adduser +91...` — approve user\n`/removeuser +91...` — revoke\n`/users` — list users\n"
    : "";

  bot.sendMessage(msg.chat.id,
    "📋 *3 ways to add a client:*\n\n" +
    "*1. Quick (fastest):*\n`Rahul Sharma 9876543210 CRM 45000`\n\n" +
    "*2. Slash:*\n`Rahul / 98765 / CRM / 45000 / wants demo`\n\n" +
    "*3. Detailed:*\n`Name: Rahul\nNumber: 98765\nProduct: CRM\nPrice: 45000\nNote: Interested\nStatus: Hot`\n\n" +
    "*Other commands:*\n`/list` — recent 5 clients\n`/total` — count\n`/find Rahul` — search by name\n\n" +
    "*Use phone number or ID:*\n`/note 9876543210 Called today` — add note\n`/status 9876543210 Hot` — update status\n`/remind 9876543210 25/03/2026 Call back` — follow-up\n`/delete 9876543210` — delete\n" +
    adminCommands,
    { parse_mode: "Markdown" }
  );
});

// ── /list ─────────────────────────────────────────────────────────────────────
bot.onText(/\/list/, async msg => {
  if (!getApprovedByChatId(msg.chat.id)) return bot.sendMessage(msg.chat.id, "⛔ No access.");
  const recent = loadClients().slice(-5).reverse();
  if (!recent.length) return bot.sendMessage(msg.chat.id, "📭 No clients yet.");
  const lines = recent.map(c =>
    `• *#${c.id} ${c.name}* — ${c.product}${c.price ? ` — ₹${c.price}` : ""} [${c.status || "Warm"}]`
  );
  bot.sendMessage(msg.chat.id, `📋 *Recent clients:*\n\n${lines.join("\n")}`, { parse_mode: "Markdown" });
});

// ── /total ────────────────────────────────────────────────────────────────────
bot.onText(/\/total/, msg => {
  if (!getApprovedByChatId(msg.chat.id)) return bot.sendMessage(msg.chat.id, "⛔ No access.");
  const all = loadClients();
  const hot  = all.filter(c => c.status === "Hot").length;
  const cold = all.filter(c => c.status === "Cold").length;
  bot.sendMessage(msg.chat.id,
    `📊 *Totals:*\n\nAll: *${all.length}*\n🔴 Hot: ${hot}  🔵 Cold: ${cold}`,
    { parse_mode: "Markdown" }
  );
});

// ── /find <name or number> ────────────────────────────────────────────────────
bot.onText(/\/find (.+)/, (msg, match) => {
  if (!getApprovedByChatId(msg.chat.id)) return bot.sendMessage(msg.chat.id, "⛔ No access.");
  const q = match[1].toLowerCase();
  const results = loadClients().filter(c =>
    c.name?.toLowerCase().includes(q) ||
    c.number?.toString().includes(q) ||
    c.product?.toLowerCase().includes(q)
  ).slice(0, 5);
  if (!results.length) return bot.sendMessage(msg.chat.id, `🔍 No results for "${match[1]}"`);
  const lines = results.map(c =>
    `*#${c.id} ${c.name}*\n📞 ${c.number} | 📦 ${c.product} | [${c.status || "Warm"}]${c.price ? ` | ₹${c.price}` : ""}`
  );
  bot.sendMessage(msg.chat.id, lines.join("\n\n"), { parse_mode: "Markdown" });
});

// ── /note <id> <text> ─────────────────────────────────────────────────────────
bot.onText(/\/note (\S+) (.+)/, (msg, match) => {
  const user = getApprovedByChatId(msg.chat.id);
  if (!user) return bot.sendMessage(msg.chat.id, "⛔ No access.");
  const clients = loadClients();
const c = clients.find(x => x.id === Number(match[1]) || normalizePhone(x.number) === normalizePhone(match[1]));
if (!c) return bot.sendMessage(msg.chat.id, `❌ Client not found for "${match[1]}".`);
  if (!c.notes) c.notes = [];
  c.notes.push({ text: match[2], by: user.name, at: nowIST() });
  saveClients(clients);
  bot.sendMessage(msg.chat.id,
    `📝 Note added to *#${c.id} ${c.name}*\n\n"${match[2]}"`,
    { parse_mode: "Markdown" }
  );
});

// ── /status <id> <Hot|Warm|Cold|Closed> ──────────────────────────────────────
bot.onText(/\/status (\S+) (\w+)/, (msg, match) => {
  const user = getApprovedByChatId(msg.chat.id);
  if (!user) return bot.sendMessage(msg.chat.id, "⛔ No access.");
  const validStatuses = ["Hot", "Warm", "Cold", "Closed"];
  const newStatus = capitalize(match[2]);
  if (!validStatuses.includes(newStatus)) {
    return bot.sendMessage(msg.chat.id, `⚠️ Status must be one of: Hot, Warm, Cold, Closed`);
  }
  const clients = loadClients();
  const c = clients.find(x => x.id === Number(match[1]) || normalizePhone(x.number) === normalizePhone(match[1]));
  if (!c) return bot.sendMessage(msg.chat.id, `❌ Client not found for "${match[1]}".`);
  const old = c.status;
  c.status = newStatus;
  saveClients(clients);
  const emoji = { Hot: "🔴", Warm: "🟡", Cold: "🔵", Closed: "✅" }[newStatus] || "";
  bot.sendMessage(msg.chat.id,
    `${emoji} *#${c.id} ${c.name}* status updated\n${old} → *${newStatus}*`,
    { parse_mode: "Markdown" }
  );
});

// ── /remind <id> <dd/mm/yyyy> <note> ─────────────────────────────────────────
bot.onText(/\/remind (\S+) (\S+)(?: (.+))?/, (msg, match) => {
  const user = getApprovedByChatId(msg.chat.id);
  if (!user) return bot.sendMessage(msg.chat.id, "⛔ No access.");
  const clients = loadClients();
  const c = clients.find(x => x.id === Number(match[1]) || normalizePhone(x.number) === normalizePhone(match[1]));
  if (!c) return bot.sendMessage(msg.chat.id, `❌ Client not found for "${match[1]}".`);
  c.followUpDate = match[2];
  c.followUpNote = match[3] || "";
  saveClients(clients);
  bot.sendMessage(msg.chat.id,
    `⏰ Follow-up set for *#${c.id} ${c.name}*\n📅 ${match[2]}${match[3] ? `\n📌 ${match[3]}` : ""}`,
    { parse_mode: "Markdown" }
  );
});

// ── /delete <id> ─────────────────────────────────────────────────────────────
bot.onText(/\/delete (\S+)/, (msg, match) => {
  const user = getApprovedByChatId(msg.chat.id);
  if (!user) return bot.sendMessage(msg.chat.id, "⛔ No access.");
  const clients = loadClients();
  const idx = clients.findIndex(x => x.id === Number(match[1]) || normalizePhone(x.number) === normalizePhone(match[1]));
  if (idx < 0) return bot.sendMessage(msg.chat.id, `❌ Client not found for "${match[1]}".`);
  const [removed] = clients.splice(idx, 1);
  saveClients(clients);
  bot.sendMessage(msg.chat.id,
    `🗑 *#${removed.id} ${removed.name}* deleted.`,
    { parse_mode: "Markdown" }
  );
});

// ── /reminders — check today's follow-ups ────────────────────────────────────
bot.onText(/\/reminders/, msg => {
  if (!getApprovedByChatId(msg.chat.id)) return bot.sendMessage(msg.chat.id, "⛔ No access.");
  const today = todayIST();
  const due = loadClients().filter(c => c.followUpDate === today);
  if (!due.length) return bot.sendMessage(msg.chat.id, "✅ No follow-ups due today.");
  const lines = due.map(c =>
    `• *#${c.id} ${c.name}* — ${c.product}${c.followUpNote ? `\n  📌 ${c.followUpNote}` : ""}`
  );
  bot.sendMessage(msg.chat.id, `⏰ *Follow-ups due today:*\n\n${lines.join("\n")}`, { parse_mode: "Markdown" });
});

// ── Admin: /adduser /removeuser /users ────────────────────────────────────────
bot.onText(/\/adduser (.+)/, (msg, match) => {
  const caller = getApprovedByChatId(msg.chat.id);
  if (!caller || !isAdmin(caller.phone)) return bot.sendMessage(msg.chat.id, "⛔ Admin only.");
  const phone = normalizePhone(match[1]);
  const users = loadUsers();
  const pending = users.pending[phone];
if (phone.length < 10) return bot.sendMessage(msg.chat.id, "⚠️ Invalid number.");
approveUser(phone, pending?.name || "User", pending?.chatId ? Number(pending.chatId) : null);
  bot.sendMessage(msg.chat.id, `✅ +${phone} approved!`);
  if (pending?.chatId) bot.sendMessage(pending.chatId, "🎉 *You've been approved!* Send /help to get started.", { parse_mode: "Markdown" });
});

bot.onText(/\/removeuser (.+)/, (msg, match) => {
  const caller = getApprovedByChatId(msg.chat.id);
  if (!caller || !isAdmin(caller.phone)) return bot.sendMessage(msg.chat.id, "⛔ Admin only.");
  const phone = normalizePhone(match[1]);
  const user  = loadUsers().approved[phone];
  if (!user) return bot.sendMessage(msg.chat.id, "⚠️ User not found.");
  removeUser(phone);
  bot.sendMessage(msg.chat.id, `🗑 ${user.name} removed.`);
  if (user.chatId) bot.sendMessage(user.chatId, "ℹ️ Your access has been removed.");
});

bot.onText(/\/users/, msg => {
  const caller = getApprovedByChatId(msg.chat.id);
  if (!caller || !isAdmin(caller.phone)) return bot.sendMessage(msg.chat.id, "⛔ Admin only.");
  const { approved, pending } = loadUsers();
  let text = `👥 *Approved (${Object.values(approved).length})*\n\n`;
  Object.values(approved).forEach(u => { text += `• ${u.name} — +${u.phone}\n`; });
  const pList = Object.values(pending);
  if (pList.length) {
    text += `\n⏳ *Pending (${pList.length})*\n\n`;
    pList.forEach(u => { text += `• ${u.name} — +${u.phone}\n  \`/adduser +${u.phone}\`\n`; });
  }
  bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});

// ── Daily reminder job — runs at 9am IST ─────────────────────────────────────
function scheduleDailyReminders() {
  const now  = new Date();
  const ist  = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const next = new Date(ist);
  next.setHours(9, 0, 0, 0);
  if (next <= ist) next.setDate(next.getDate() + 1);
  const msUntil = next - ist;

  setTimeout(() => {
    sendDailyReminders();
    setInterval(sendDailyReminders, 24 * 60 * 60 * 1000);
  }, msUntil);
  console.log(`⏰ Daily reminders scheduled (next run in ${Math.round(msUntil / 60000)} min)`);
}

function sendDailyReminders() {
  const today = todayIST();
  const due   = loadClients().filter(c => c.followUpDate === today);
  if (!due.length) return;

  const { approved } = loadUsers();
  Object.values(approved).forEach(user => {
    if (!user.chatId) return;
    const lines = due.map(c =>
      `• *#${c.id} ${c.name}* — ${c.product}${c.followUpNote ? `\n  📌 ${c.followUpNote}` : ""}`
    );
    bot.sendMessage(user.chatId,
      `🌅 *Good morning! Follow-ups for today:*\n\n${lines.join("\n")}\n\nSend /reminders anytime to check.`,
      { parse_mode: "Markdown" }
    );
  });
}

// ── Main message handler — smart add client ───────────────────────────────────
bot.on("message", async msg => {
  if (msg.contact || msg.text?.startsWith("/")) return;

  const user = getApprovedByChatId(msg.chat.id);
  if (!user) return bot.sendMessage(msg.chat.id, "⛔ No access. Send /start.");

  const text = msg.text?.trim();
  if (!text) return;

  const { fields, missing, format } = smartParse(text);

  if (missing.length === 3) {
    // Didn't look like a client entry — give a gentle hint
    return bot.sendMessage(msg.chat.id,
      "💡 To add a client, try:\n`Rahul 9876543210 CRM`\nor send /help for all formats.",
      { parse_mode: "Markdown" }
    );
  }

  if (missing.length > 0) {
    return bot.sendMessage(msg.chat.id,
      `⚠️ Missing: *${missing.join(", ")}*\n\nExample: \`Rahul 9876543210 CRM\`\nSend /help for all formats.`,
      { parse_mode: "Markdown" }
    );
  }

  // Build client object
  const clients = loadClients();
  const id      = nextId();
  const client  = {
    id,
    name:         fields.name,
    number:       fields.number,
    product:      fields.product,
    price:        fields.price || "",
    status:       ["Hot","Warm","Cold","Closed"].includes(fields.status) ? fields.status : "Warm",
    notes:        fields.note ? [{ text: fields.note, by: user.name, at: nowIST() }] : [],
    followUpDate: fields.followUpDate || "",
    followUpNote: "",
    addedBy:      user.name,
    addedOn:      nowIST(),
    date:         todayIST(),
  };
  clients.push(client);
  saveClients(clients);

  const statusEmoji = { Hot: "🔴", Warm: "🟡", Cold: "🔵", Closed: "✅" }[client.status] || "🟡";
  bot.sendMessage(msg.chat.id,
    `✅ *Client #${id} saved!*\n\n` +
    `👤 ${client.name}\n📞 ${client.number}\n📦 ${client.product}` +
    `${client.price ? `\n💰 ₹${client.price}` : ""}` +
    `\n${statusEmoji} ${client.status}` +
    `${client.notes.length ? `\n📝 ${client.notes[0].text}` : ""}` +
    `\n📅 ${client.date}\n\n` +
    `_To add a note: /note ${id} your note here_\n` +
    `_To set follow-up: /remind ${id} 25/01/2025_`,
    { parse_mode: "Markdown" }
  );
});

scheduleDailyReminders();

// ─── Express API ──────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/clients", (req, res) => {
  const clients = loadClients().reverse();
  res.json(clients);
});

app.get("/api/clients/download", async (req, res) => {
  await rebuildExcel();
  res.download(EXCEL_PATH, "clients.xlsx");
});

app.get("/api/stats", (req, res) => {
  const clients = loadClients();
  const { approved, pending } = loadUsers();
  const products = [...new Set(clients.map(c => c.product).filter(Boolean))];
  const byStatus = { Hot: 0, Warm: 0, Cold: 0, Closed: 0 };
  clients.forEach(c => { if (byStatus[c.status] !== undefined) byStatus[c.status]++; });
  res.json({
    total: clients.length, products, byStatus,
    approvedUsers: Object.values(approved).length,
    pendingUsers:  Object.values(pending).length,
  });
});

app.get("/api/users", (req, res) => {
  try {
    const { approved, pending } = loadUsers();
    res.json({
      approved: Object.values(approved || {}),
      pending:  Object.values(pending  || {}),
    });
  } catch { res.json({ approved: [], pending: [] }); }
});

// Update client (status, price, followUpDate, followUpNote)
app.patch("/api/clients/:id", (req, res) => {
  const clients = loadClients();
  const c = clients.find(x => x.id === Number(req.params.id));
  if (!c) return res.status(404).json({ error: "Not found" });
  const allowed = ["status","price","followUpDate","followUpNote","name","number","product"];
  allowed.forEach(k => { if (req.body[k] !== undefined) c[k] = req.body[k]; });
  saveClients(clients);
  res.json(c);
});

// Add note via dashboard
app.post("/api/clients/:id/notes", (req, res) => {
  const clients = loadClients();
  const c = clients.find(x => x.id === Number(req.params.id));
  if (!c) return res.status(404).json({ error: "Not found" });
  if (!c.notes) c.notes = [];
  c.notes.push({ text: req.body.text, by: req.body.by || "Dashboard", at: nowIST() });
  saveClients(clients);
  res.json(c);
});

// Delete client
app.delete("/api/clients/:id", (req, res) => {
  const clients = loadClients();
  const idx = clients.findIndex(x => x.id === Number(req.params.id));
  if (idx < 0) return res.status(404).json({ error: "Not found" });
  clients.splice(idx, 1);
  saveClients(clients);
  res.json({ ok: true });
});

app.post("/api/users/approve", (req, res) => {
  const { phone, name, chatId } = req.body;
  if (!phone) return res.status(400).json({ error: "phone required" });
  approveUser(phone, name || "User", chatId || null);
  if (chatId) bot.sendMessage(chatId, "🎉 *You've been approved!* Send /help to get started.", { parse_mode: "Markdown" });
  res.json({ ok: true });
});

app.delete("/api/users/:phone", (req, res) => {
  const users = loadUsers();
  const phone = normalizePhone(req.params.phone);
  const user  = users.approved[phone];
  removeUser(phone);
  if (user?.chatId) bot.sendMessage(user.chatId, "ℹ️ Your access has been removed.");
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`✅ Server on http://localhost:${PORT}`));