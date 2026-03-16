require("dotenv").config();
const express     = require("express");
const cors        = require("cors");
const TelegramBot = require("node-telegram-bot-api");
const ExcelJS     = require("exceljs");
const mongoose    = require("mongoose");
const path        = require("path");
const fs          = require("fs");

// ─── Config ────────────────────────────────────────────────────────────────────
const TOKEN        = process.env.TELEGRAM_TOKEN;
const ADMIN_PHONE  = process.env.ADMIN_PHONE;
const MONGODB_URI  = process.env.MONGODB_URI;
const PORT         = process.env.PORT || 3001;

if (!TOKEN)       { console.error("❌ TELEGRAM_TOKEN missing"); process.exit(1); }
if (!ADMIN_PHONE) { console.error("❌ ADMIN_PHONE missing");    process.exit(1); }
if (!MONGODB_URI) { console.error("❌ MONGODB_URI missing");    process.exit(1); }

// ─── MongoDB connection ────────────────────────────────────────────────────────
mongoose.connect(MONGODB_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => { console.error("❌ MongoDB error:", err); process.exit(1); });

// ─── Schemas ───────────────────────────────────────────────────────────────────
const noteSchema = new mongoose.Schema({
  text: String,
  by:   String,
  at:   String,
});

const clientSchema = new mongoose.Schema({
  name:         String,
  number:       String,
  product:      String,
  price:        { type: String, default: "" },
  status:       { type: String, default: "Hot" },
  notes:        [noteSchema],
  followUpDate: { type: String, default: "" },
  followUpNote: { type: String, default: "" },
  addedBy:      String,
  addedOn:      String,
  date:         String,
}, { timestamps: true });

const userSchema = new mongoose.Schema({
  phone:       { type: String, unique: true },
  name:        String,
  chatId:      Number,
  status:      { type: String, enum: ["approved","pending"], default: "pending" },
  requestedAt: { type: Date, default: Date.now },
  addedAt:     Date,
});

const Client = mongoose.model("Client", clientSchema);
const User   = mongoose.model("User",   userSchema);

// ─── Helpers ───────────────────────────────────────────────────────────────────
function nowIST() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}
function todayIST() {
  return new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
}
function normalizePhone(p) { return String(p).replace(/\D/g, ""); }
function isAdmin(phone)    { return normalizePhone(phone) === normalizePhone(ADMIN_PHONE); }
function capitalize(s)     { if (!s) return s; return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(); }

async function getApprovedByChatId(chatId) {
  return User.findOne({ chatId: Number(chatId), status: "approved" });
}

// ─── Excel export ──────────────────────────────────────────────────────────────
async function rebuildExcel() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Clients");
  ws.columns = [
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

  const clients = await Client.find().sort({ createdAt: 1 });
  const statusColors = { Hot: "FFFEE2E2", Cold: "FFEFF6FF", Closed: "FFF0FDF4" };

  clients.forEach((c, i) => {
    const lastNote = c.notes?.length ? c.notes[c.notes.length - 1].text : "";
    const row = ws.addRow({
      name: c.name, number: c.number, product: c.product,
      price: c.price, status: c.status || "Hot",
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

  const excelPath = path.join("/tmp", "clients.xlsx");
  await wb.xlsx.writeFile(excelPath);
  return excelPath;
}

// ─── Smart parser ──────────────────────────────────────────────────────────────
function smartParse(text) {
  const fields = { status: "Hot" };
  const t = text.trim();

  if (t.includes(":") && t.includes("\n")) {
    for (const line of t.split("\n")) {
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      const k = line.slice(0, idx).trim().toLowerCase();
      const v = line.slice(idx + 1).trim();
      if (!v) continue;
      if (k === "name")                                              fields.name    = v;
      else if (["number","phone","mob","mobile"].includes(k))        fields.number  = v;
      else if (["product","service","item","p"].includes(k))         fields.product = v;
      else if (["price","amount","amt","cost"].includes(k))          fields.price   = v;
      else if (["note","notes","talk","last talk","remark"].includes(k)) fields.note = v;
      else if (["status","stage"].includes(k))                       fields.status  = capitalize(v);
      else if (["followup","follow up","follow-up","reminder"].includes(k)) fields.followUpDate = v;
    }
    return { fields, missing: ["name","number","product"].filter(f => !fields[f]), format: "keyvalue" };
  }

  if (t.includes("/")) {
    const parts = t.split("/").map(s => s.trim()).filter(Boolean);
    if (parts.length >= 3) {
      fields.name    = parts[0];
      fields.number  = parts[1];
      fields.product = parts[2];
      if (parts[3]) fields.price = parts[3];
      if (parts[4]) fields.note  = parts[4];
      return { fields, missing: ["name","number","product"].filter(f => !fields[f]), format: "slash" };
    }
  }

  const phoneMatch = t.match(/\b(\+?[\d\s\-]{10,15})\b/);
  if (phoneMatch) {
    const phone      = phoneMatch[1].replace(/\s/g, "");
    const before     = t.slice(0, phoneMatch.index).trim();
    const after      = t.slice(phoneMatch.index + phoneMatch[0].length).trim();
    const afterParts = after.split(/\s+/);
    const lastToken  = afterParts[afterParts.length - 1];
    const looksLikePrice = /^\d[\d,.kK lL]*$/.test(lastToken);
    fields.name    = before || null;
    fields.number  = phone;
    fields.product = looksLikePrice ? afterParts.slice(0, -1).join(" ") : after;
    if (looksLikePrice) fields.price = lastToken;
    return { fields, missing: ["name","number","product"].filter(f => !fields[f]), format: "quick" };
  }

  return { fields, missing: ["name","number","product"], format: "unknown" };
}

// ─── Bot ───────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(TOKEN, { polling: true });
let adminChatId = null;

function notifyAdmin(text) {
  if (adminChatId) bot.sendMessage(adminChatId, text, { parse_mode: "Markdown" });
}

// /start
bot.onText(/\/start/, async msg => {
  const existing = await getApprovedByChatId(msg.chat.id);
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

// Contact received
bot.on("contact", async msg => {
  const contact = msg.contact;
  const phone   = normalizePhone(contact.phone_number);
  const name    = [contact.first_name, contact.last_name].filter(Boolean).join(" ");
  const chatId  = Number(msg.chat.id);

  if (isAdmin(phone)) {
    adminChatId = chatId;
    await User.findOneAndUpdate(
      { phone },
      { name, chatId, status: "approved", addedAt: new Date() },
      { upsert: true, new: true }
    );
    return bot.sendMessage(chatId,
      `✅ *Welcome, ${name}! You're the admin.*\n\n` +
      "📌 *3 ways to add a client:*\n\n" +
      "*1. Quick:* `Rahul 9876543210 CRM 45000`\n" +
      "*2. Slash:* `Rahul / 9876543210 / CRM / 45000`\n" +
      "*3. Detailed:*\n`Name: Rahul\nNumber: 98765\nProduct: CRM\nPrice: 45000`\n\n" +
      "/help — all commands",
      { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
    );
  }

  const existing = await User.findOne({ phone, status: "approved" });
  if (existing) {
    await User.findOneAndUpdate({ phone }, { chatId });
    return bot.sendMessage(chatId,
      "✅ *You already have access!*\n\nSend /help to get started.",
      { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
    );
  }

  await User.findOneAndUpdate(
    { phone },
    { name, chatId, status: "pending", requestedAt: new Date() },
    { upsert: true, new: true }
  );
  bot.sendMessage(chatId,
    `⏳ *Request sent, ${name}!*\n\nYou'll get a message once approved.`,
    { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
  );
  notifyAdmin(`🔔 *New access request*\n\n👤 ${name}\n📞 +${phone}\n\`/adduser +${phone}\``);
});

// /help
bot.onText(/\/help/, async msg => {
  const user = await getApprovedByChatId(msg.chat.id);
  if (!user) return bot.sendMessage(msg.chat.id, "⛔ No access. Send /start.");
  const adminCmds = isAdmin(user.phone)
    ? "\n*Admin:*\n`/adduser +91...` — approve\n`/removeuser +91...` — revoke\n`/users` — list\n"
    : "";
  bot.sendMessage(msg.chat.id,
    "📋 *Add a client:*\n\n" +
    "`Rahul 9876543210 CRM 45000`\n`Rahul / 98765 / CRM / 45000`\n\n" +
    "*Commands:*\n`/list` — recent 5\n`/total` — count\n`/find Rahul` — search\n" +
    "`/note 9876543210 text` — add note\n`/status 9876543210 Hot` — update\n" +
    "`/remind 9876543210 25/03/2026 note` — follow-up\n`/delete 9876543210` — delete\n" +
    adminCmds,
    { parse_mode: "Markdown" }
  );
});

// /list
bot.onText(/\/list/, async msg => {
  if (!await getApprovedByChatId(msg.chat.id)) return bot.sendMessage(msg.chat.id, "⛔ No access.");
  const recent = await Client.find().sort({ createdAt: -1 }).limit(5);
  if (!recent.length) return bot.sendMessage(msg.chat.id, "📭 No clients yet.");
  const lines = recent.map(c =>
    `• *${c.name}* — ${c.product}${c.price ? ` — ₹${c.price}` : ""} [${c.status}]`
  );
  bot.sendMessage(msg.chat.id, `📋 *Recent clients:*\n\n${lines.join("\n")}`, { parse_mode: "Markdown" });
});

// /total
bot.onText(/\/total/, async msg => {
  if (!await getApprovedByChatId(msg.chat.id)) return bot.sendMessage(msg.chat.id, "⛔ No access.");
  const total  = await Client.countDocuments();
  const hot    = await Client.countDocuments({ status: "Hot" });
  const cold   = await Client.countDocuments({ status: "Cold" });
  const closed = await Client.countDocuments({ status: "Closed" });
  bot.sendMessage(msg.chat.id,
    `📊 *Totals:*\n\nAll: *${total}*\n🔴 Hot: ${hot}  🔵 Cold: ${cold}  ✅ Closed: ${closed}`,
    { parse_mode: "Markdown" }
  );
});

// /find
bot.onText(/\/find (.+)/, async (msg, match) => {
  if (!await getApprovedByChatId(msg.chat.id)) return bot.sendMessage(msg.chat.id, "⛔ No access.");
  const q = match[1];
  const results = await Client.find({
    $or: [
      { name:    { $regex: q, $options: "i" } },
      { number:  { $regex: q, $options: "i" } },
      { product: { $regex: q, $options: "i" } },
    ]
  }).limit(5);
  if (!results.length) return bot.sendMessage(msg.chat.id, `🔍 No results for "${q}"`);
  const lines = results.map(c =>
    `*${c.name}*\n📞 ${c.number} | 📦 ${c.product} | [${c.status}]${c.price ? ` | ₹${c.price}` : ""}`
  );
  bot.sendMessage(msg.chat.id, lines.join("\n\n"), { parse_mode: "Markdown" });
});

// /note
bot.onText(/\/note (\S+) (.+)/, async (msg, match) => {
  const user = await getApprovedByChatId(msg.chat.id);
  if (!user) return bot.sendMessage(msg.chat.id, "⛔ No access.");
  const q = match[1];
  const c = await Client.findOne({
    $or: [{ number: { $regex: normalizePhone(q) } }]
  });
  if (!c) return bot.sendMessage(msg.chat.id, `❌ Client not found for "${q}".`);
  c.notes.push({ text: match[2], by: user.name, at: nowIST() });
  await c.save();
  bot.sendMessage(msg.chat.id, `📝 Note added to *${c.name}*\n\n"${match[2]}"`, { parse_mode: "Markdown" });
});

// /status
bot.onText(/\/status (\S+) (\w+)/, async (msg, match) => {
  const user = await getApprovedByChatId(msg.chat.id);
  if (!user) return bot.sendMessage(msg.chat.id, "⛔ No access.");
  const valid = ["Hot", "Cold", "Closed"];
  const newStatus = capitalize(match[2]);
  if (!valid.includes(newStatus)) return bot.sendMessage(msg.chat.id, `⚠️ Status must be: Hot, Cold, Closed`);
  const c = await Client.findOne({ number: { $regex: normalizePhone(match[1]) } });
  if (!c) return bot.sendMessage(msg.chat.id, `❌ Client not found.`);
  const old = c.status;
  c.status = newStatus;
  await c.save();
  const emoji = { Hot:"🔴", Cold:"🔵", Closed:"✅" }[newStatus] || "";
  bot.sendMessage(msg.chat.id, `${emoji} *${c.name}* status: ${old} → *${newStatus}*`, { parse_mode: "Markdown" });
});

// /remind
bot.onText(/\/remind (\S+) (\S+)(?: (.+))?/, async (msg, match) => {
  const user = await getApprovedByChatId(msg.chat.id);
  if (!user) return bot.sendMessage(msg.chat.id, "⛔ No access.");
  const c = await Client.findOne({ number: { $regex: normalizePhone(match[1]) } });
  if (!c) return bot.sendMessage(msg.chat.id, `❌ Client not found.`);
  c.followUpDate = match[2];
  c.followUpNote = match[3] || "";
  await c.save();
  bot.sendMessage(msg.chat.id,
    `⏰ Follow-up set for *${c.name}*\n📅 ${match[2]}${match[3] ? `\n📌 ${match[3]}` : ""}`,
    { parse_mode: "Markdown" }
  );
});

// /delete
bot.onText(/\/delete (\S+)/, async (msg, match) => {
  const user = await getApprovedByChatId(msg.chat.id);
  if (!user) return bot.sendMessage(msg.chat.id, "⛔ No access.");
  const c = await Client.findOneAndDelete({ number: { $regex: normalizePhone(match[1]) } });
  if (!c) return bot.sendMessage(msg.chat.id, `❌ Client not found.`);
  bot.sendMessage(msg.chat.id, `🗑 *${c.name}* deleted.`, { parse_mode: "Markdown" });
});

// /reminders
bot.onText(/\/reminders/, async msg => {
  if (!await getApprovedByChatId(msg.chat.id)) return bot.sendMessage(msg.chat.id, "⛔ No access.");
  const today = todayIST();
  const due = await Client.find({ followUpDate: today });
  if (!due.length) return bot.sendMessage(msg.chat.id, "✅ No follow-ups due today.");
  const lines = due.map(c => `• *${c.name}* — ${c.product}${c.followUpNote ? `\n  📌 ${c.followUpNote}` : ""}`);
  bot.sendMessage(msg.chat.id, `⏰ *Follow-ups today:*\n\n${lines.join("\n")}`, { parse_mode: "Markdown" });
});

// Admin commands
bot.onText(/\/adduser (.+)/, async (msg, match) => {
  const caller = await getApprovedByChatId(msg.chat.id);
  if (!caller || !isAdmin(caller.phone)) return bot.sendMessage(msg.chat.id, "⛔ Admin only.");
  const phone = normalizePhone(match[1]);
  if (phone.length < 10) return bot.sendMessage(msg.chat.id, "⚠️ Invalid number.");
  const u = await User.findOneAndUpdate(
    { phone },
    { status: "approved", addedAt: new Date() },
    { new: true }
  );
  bot.sendMessage(msg.chat.id, `✅ +${phone} approved!`);
  if (u?.chatId) bot.sendMessage(u.chatId, "🎉 *You've been approved!* Send /help to get started.", { parse_mode: "Markdown" });
});

bot.onText(/\/removeuser (.+)/, async (msg, match) => {
  const caller = await getApprovedByChatId(msg.chat.id);
  if (!caller || !isAdmin(caller.phone)) return bot.sendMessage(msg.chat.id, "⛔ Admin only.");
  const phone = normalizePhone(match[1]);
  const u = await User.findOneAndDelete({ phone });
  if (!u) return bot.sendMessage(msg.chat.id, "⚠️ User not found.");
  bot.sendMessage(msg.chat.id, `🗑 ${u.name} removed.`);
  if (u.chatId) bot.sendMessage(u.chatId, "ℹ️ Your access has been removed.");
});

bot.onText(/\/users/, async msg => {
  const caller = await getApprovedByChatId(msg.chat.id);
  if (!caller || !isAdmin(caller.phone)) return bot.sendMessage(msg.chat.id, "⛔ Admin only.");
  const approved = await User.find({ status: "approved" });
  const pending  = await User.find({ status: "pending" });
  let text = `👥 *Approved (${approved.length})*\n\n`;
  approved.forEach(u => { text += `• ${u.name} — +${u.phone}\n`; });
  if (pending.length) {
    text += `\n⏳ *Pending (${pending.length})*\n\n`;
    pending.forEach(u => { text += `• ${u.name} — +${u.phone}\n  \`/adduser +${u.phone}\`\n`; });
  }
  bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});

// Daily reminders at 9am IST
function scheduleDailyReminders() {
  const ist  = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const next = new Date(ist);
  next.setHours(9, 0, 0, 0);
  if (next <= ist) next.setDate(next.getDate() + 1);
  setTimeout(() => {
    sendDailyReminders();
    setInterval(sendDailyReminders, 24 * 60 * 60 * 1000);
  }, next - ist);
}

async function sendDailyReminders() {
  const today   = todayIST();
  const due     = await Client.find({ followUpDate: today });
  if (!due.length) return;
  const approved = await User.find({ status: "approved", chatId: { $ne: null } });
  approved.forEach(user => {
    const lines = due.map(c => `• *${c.name}* — ${c.product}${c.followUpNote ? `\n  📌 ${c.followUpNote}` : ""}`);
    bot.sendMessage(user.chatId,
      `🌅 *Good morning! Follow-ups today:*\n\n${lines.join("\n")}\n\nSend /reminders to check anytime.`,
      { parse_mode: "Markdown" }
    );
  });
}

// Main message handler
bot.on("message", async msg => {
  if (msg.contact || msg.text?.startsWith("/")) return;
  const user = await getApprovedByChatId(msg.chat.id);
  if (!user) return bot.sendMessage(msg.chat.id, "⛔ No access. Send /start.");
  const text = msg.text?.trim();
  if (!text) return;

  const { fields, missing } = smartParse(text);
  if (missing.length === 3) {
    return bot.sendMessage(msg.chat.id,
      "💡 To add a client:\n`Rahul 9876543210 CRM`\nor send /help",
      { parse_mode: "Markdown" }
    );
  }
  if (missing.length > 0) {
    return bot.sendMessage(msg.chat.id,
      `⚠️ Missing: *${missing.join(", ")}*\n\nExample: \`Rahul 9876543210 CRM\``,
      { parse_mode: "Markdown" }
    );
  }

  const client = await Client.create({
    name:         fields.name,
    number:       fields.number,
    product:      fields.product,
    price:        fields.price || "",
    status:       ["Hot","Cold","Closed"].includes(fields.status) ? fields.status : "Hot",
    notes:        fields.note ? [{ text: fields.note, by: user.name, at: nowIST() }] : [],
    followUpDate: fields.followUpDate || "",
    followUpNote: "",
    addedBy:      user.name,
    addedOn:      nowIST(),
    date:         todayIST(),
  });

  const emoji = { Hot:"🔴", Cold:"🔵", Closed:"✅" }[client.status] || "🔴";
  bot.sendMessage(msg.chat.id,
    `✅ *Client saved!*\n\n` +
    `👤 ${client.name}\n📞 ${client.number}\n📦 ${client.product}` +
    `${client.price ? `\n💰 ₹${client.price}` : ""}` +
    `\n${emoji} ${client.status}` +
    `${client.notes.length ? `\n📝 ${client.notes[0].text}` : ""}` +
    `\n📅 ${client.date}\n\n` +
    `_/note ${client.number} your note_\n` +
    `_/remind ${client.number} 25/03/2026_\n\n` +
    `🌐 [View Dashboard](https://client.webolev.com)`,
    { parse_mode: "Markdown" }
  );
});

scheduleDailyReminders();

// ─── Express API ───────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/clients", async (req, res) => {
  const clients = await Client.find().sort({ createdAt: -1 });
  res.json(clients);
});

app.get("/api/clients/download", async (req, res) => {
  const excelPath = await rebuildExcel();
  res.download(excelPath, "clients.xlsx");
});

app.get("/api/stats", async (req, res) => {
  const total    = await Client.countDocuments();
  const products = await Client.distinct("product");
  const hot      = await Client.countDocuments({ status: "Hot" });
  const cold     = await Client.countDocuments({ status: "Cold" });
  const closed   = await Client.countDocuments({ status: "Closed" });
  const approved = await User.countDocuments({ status: "approved" });
  const pending  = await User.countDocuments({ status: "pending" });
  res.json({
    total, products,
    byStatus: { Hot: hot, Cold: cold, Closed: closed },
    approvedUsers: approved,
    pendingUsers:  pending,
  });
});

app.get("/api/users", async (req, res) => {
  const approved = await User.find({ status: "approved" });
  const pending  = await User.find({ status: "pending" });
  res.json({ approved, pending });
});

app.patch("/api/clients/:id", async (req, res) => {
  const allowed = ["status","price","followUpDate","followUpNote","name","number","product"];
  const update  = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });
  const c = await Client.findByIdAndUpdate(req.params.id, update, { new: true });
  if (!c) return res.status(404).json({ error: "Not found" });
  res.json(c);
});

app.post("/api/clients/:id/notes", async (req, res) => {
  const c = await Client.findById(req.params.id);
  if (!c) return res.status(404).json({ error: "Not found" });
  c.notes.push({ text: req.body.text, by: req.body.by || "Dashboard", at: nowIST() });
  await c.save();
  res.json(c);
});

app.delete("/api/clients/:id", async (req, res) => {
  await Client.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
});

app.post("/api/users/approve", async (req, res) => {
  const { phone, name, chatId } = req.body;
  if (!phone) return res.status(400).json({ error: "phone required" });
  const u = await User.findOneAndUpdate(
    { phone: normalizePhone(phone) },
    { status: "approved", name: name || "User", chatId: chatId || null, addedAt: new Date() },
    { upsert: true, new: true }
  );
  if (u.chatId) bot.sendMessage(u.chatId, "🎉 *You've been approved!* Send /help to start.", { parse_mode: "Markdown" });
  res.json({ ok: true });
});

app.delete("/api/users/:phone", async (req, res) => {
  const u = await User.findOneAndDelete({ phone: normalizePhone(req.params.phone) });
  if (u?.chatId) bot.sendMessage(u.chatId, "ℹ️ Your access has been removed.");
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`✅ Server on http://localhost:${PORT}`));