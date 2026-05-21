require("dotenv").config();
const express     = require("express");
const cors        = require("cors");
const TelegramBot = require("node-telegram-bot-api");
const ExcelJS     = require("exceljs");
const path        = require("path");
const { admin, db } = require("./firebase");
const rateLimit   = require("express-rate-limit");
const helmet      = require("helmet");

// ── Config ────────────────────────────────────────────────────────────────────
const TOKEN       = process.env.TELEGRAM_TOKEN;
const ADMIN_PHONE = process.env.ADMIN_PHONE;
const PORT        = process.env.PORT || 3001;

// Validate all required env vars up front with clear error messages
const REQUIRED_ENV = [
  "TELEGRAM_TOKEN",
  "ADMIN_PHONE",
  "FIREBASE_PROJECT_ID",
  "FIREBASE_PRIVATE_KEY",
  "FIREBASE_CLIENT_EMAIL",
];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error("❌ Missing required env vars:", missing.join(", "));
  process.exit(1);
}

// ── Firestore Collections ─────────────────────────────────────────────────────
const clientsCol = db.collection("clients");
const usersCol   = db.collection("users");

// ── Helpers ───────────────────────────────────────────────────────────────────
function nowIST()   { return new Date().toLocaleString("en-IN",     { timeZone: "Asia/Kolkata" }); }
function todayIST() { return new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" }); }

function normalizePhone(p) {
  const n = String(p).replace(/\D/g, "");
  return (n.length >= 10 && n.length <= 15) ? n : null;
}

function isAdmin(phone) {
  const n = normalizePhone(phone);
  const a = normalizePhone(ADMIN_PHONE);
  return n && a && n === a;
}

function capitalize(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

async function getApprovedByChatId(chatId) {
  const snap = await usersCol
    .where("chatId", "==", Number(chatId))
    .where("status", "==", "approved")
    .limit(1)
    .get();
  return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}

let _adminChatIdCache = null;
async function getAdminChatId() {
  if (_adminChatIdCache) return _adminChatIdCache;
  const phone = normalizePhone(ADMIN_PHONE);
  const snap  = await usersCol.where("phone", "==", phone).limit(1).get();
  if (!snap.empty && snap.docs[0].data().chatId) {
    _adminChatIdCache = snap.docs[0].data().chatId;
    return _adminChatIdCache;
  }
  return null;
}

async function notifyAdmin(text) {
  try {
    const chatId = await getAdminChatId();
    if (chatId) bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
  } catch (e) {
    console.error("notifyAdmin failed:", e.message);
  }
}

// ── Smart Parser ──────────────────────────────────────────────────────────────
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
      if (k === "name")                                                      fields.name    = v;
      else if (["number","phone","mob","mobile"].includes(k))                fields.number  = v;
      else if (["product","service","item","p"].includes(k))                 fields.product = v;
      else if (["price","amount","amt","cost"].includes(k))                  fields.price   = v;
      else if (["note","notes","talk","last talk","remark"].includes(k))     fields.note    = v;
      else if (["status","stage"].includes(k))                               fields.status  = capitalize(v);
      else if (["followup","follow up","follow-up","reminder"].includes(k))  fields.followUpDate = v;
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
    const looksLikePrice = /^\d[\d,.kKlL]*$/.test(lastToken);
    fields.name    = before || null;
    fields.number  = phone;
    fields.product = looksLikePrice ? afterParts.slice(0, -1).join(" ") : after;
    if (looksLikePrice) fields.price = lastToken;
    return { fields, missing: ["name","number","product"].filter(f => !fields[f]), format: "quick" };
  }

  return { fields, missing: ["name","number","product"], format: "unknown" };
}

// ── Excel Export ──────────────────────────────────────────────────────────────
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
    { header: "Follow Note", key: "followUpNote",width: 28 },
    { header: "Added By",    key: "addedBy",     width: 16 },
    { header: "Added On",    key: "addedOn",     width: 22 },
  ];
  ws.getRow(1).eachCell(cell => {
    cell.font      = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill      = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2563EB" } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
  });
  ws.getRow(1).height = 22;

  const snap         = await clientsCol.orderBy("createdAt", "asc").get();
  const statusColors = { Hot: "FFFEE2E2", Cold: "FFEFF6FF", Closed: "FFF0FDF4" };

  snap.docs.forEach((doc, i) => {
    const c        = doc.data();
    const lastNote = c.notes?.length ? c.notes[c.notes.length - 1].text : "";
    const row = ws.addRow({
      name: c.name, number: c.number, product: c.product,
      price: c.price, status: c.status || "Hot",
      lastNote, followUpDate: c.followUpDate || "",
      followUpNote: c.followUpNote || "",
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

// ── Telegram Bot ──────────────────────────────────────────────────────────────
const bot = new TelegramBot(TOKEN, { polling: true });

// FIX: Handle polling errors — without this, a network blip crashes the process
bot.on("polling_error", (err) => {
  console.error("Telegram polling error:", err.code, err.message);
  // Don't exit — polling auto-recovers
});

bot.on("error", (err) => {
  console.error("Telegram bot error:", err.message);
});

bot.onText(/\/start/, async msg => {
  try {
    const existing = await getApprovedByChatId(msg.chat.id);
    if (existing) {
      return bot.sendMessage(msg.chat.id,
        `✅ *Welcome back, ${existing.name}!*\n\nSend /help to see commands.`,
        { parse_mode: "Markdown" }
      );
    }
    bot.sendMessage(msg.chat.id,
      "👋 *Welcome to Client Tracker!*\n\nTap below to share your phone number and request access.",
      {
        parse_mode: "Markdown",
        reply_markup: {
          keyboard: [[{ text: "📱 Share my phone number", request_contact: true }]],
          resize_keyboard: true, one_time_keyboard: true,
        },
      }
    );
  } catch (e) { console.error("/start error:", e.message); }
});

bot.on("contact", async msg => {
  try {
    const contact = msg.contact;
    const phone   = normalizePhone(contact.phone_number);
    const name    = [contact.first_name, contact.last_name].filter(Boolean).join(" ");
    const chatId  = Number(msg.chat.id);

    if (!phone) {
      return bot.sendMessage(chatId, "❌ Invalid phone number. Please try again.");
    }

    if (isAdmin(phone)) {
      _adminChatIdCache = chatId;
      await usersCol.doc(phone).set(
        { phone, name, chatId, status: "approved", addedAt: new Date().toISOString() },
        { merge: true }
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

    const existingSnap = await usersCol
      .where("phone", "==", phone)
      .where("status", "==", "approved")
      .limit(1).get();

    if (!existingSnap.empty) {
      await usersCol.doc(phone).set({ chatId }, { merge: true });
      return bot.sendMessage(chatId,
        "✅ *You already have access!*\n\nSend /help to get started.",
        { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
      );
    }

    await usersCol.doc(phone).set(
      { phone, name, chatId, status: "pending", requestedAt: new Date().toISOString() },
      { merge: true }
    );
    bot.sendMessage(chatId,
      `⏳ *Request sent, ${name}!*\n\nYou'll get a message once approved.`,
      { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
    );
    notifyAdmin(`🔔 *New access request*\n\n👤 ${name}\n📞 +${phone}\n\`/adduser +${phone}\``);
  } catch (e) { console.error("contact error:", e.message); }
});

bot.onText(/\/help/, async msg => {
  try {
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
      "`/remind 9876543210 25/03/2026 note` — follow-up\n`/reminders` — today's due\n`/delete 9876543210` — delete\n" +
      adminCmds,
      { parse_mode: "Markdown" }
    );
  } catch (e) { console.error("/help error:", e.message); }
});

bot.onText(/\/list/, async msg => {
  try {
    if (!await getApprovedByChatId(msg.chat.id)) return bot.sendMessage(msg.chat.id, "⛔ No access.");
    const snap = await clientsCol.orderBy("createdAt", "desc").limit(5).get();
    if (snap.empty) return bot.sendMessage(msg.chat.id, "🔭 No clients yet.");
    const lines = snap.docs.map(d => {
      const c = d.data();
      return `• *${c.name}* — ${c.product}${c.price ? ` — ₹${c.price}` : ""} [${c.status}]`;
    });
    bot.sendMessage(msg.chat.id, `📋 *Recent clients:*\n\n${lines.join("\n")}`, { parse_mode: "Markdown" });
  } catch (e) { console.error("/list error:", e.message); }
});

bot.onText(/\/total/, async msg => {
  try {
    if (!await getApprovedByChatId(msg.chat.id)) return bot.sendMessage(msg.chat.id, "⛔ No access.");
    const [allSnap, hotSnap, coldSnap, closedSnap] = await Promise.all([
      clientsCol.count().get(),
      clientsCol.where("status","==","Hot").count().get(),
      clientsCol.where("status","==","Cold").count().get(),
      clientsCol.where("status","==","Closed").count().get(),
    ]);
    bot.sendMessage(msg.chat.id,
      `📊 *Totals:*\n\nAll: *${allSnap.data().count}*\n🔴 Hot: ${hotSnap.data().count}  🔵 Cold: ${coldSnap.data().count}  ✅ Closed: ${closedSnap.data().count}`,
      { parse_mode: "Markdown" }
    );
  } catch (e) { console.error("/total error:", e.message); }
});

bot.onText(/\/find (.+)/, async (msg, match) => {
  try {
    if (!await getApprovedByChatId(msg.chat.id)) return bot.sendMessage(msg.chat.id, "⛔ No access.");
    const q       = match[1].toLowerCase();
    const snap    = await clientsCol.get();
    const results = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(c =>
        c.name?.toLowerCase().includes(q) ||
        c.number?.includes(q) ||
        c.product?.toLowerCase().includes(q)
      ).slice(0, 5);
    if (!results.length) return bot.sendMessage(msg.chat.id, `🔍 No results for "${match[1]}"`);
    const lines = results.map(c =>
      `*${c.name}*\n📞 ${c.number} | 📦 ${c.product} | [${c.status}]${c.price ? ` | ₹${c.price}` : ""}`
    );
    bot.sendMessage(msg.chat.id, lines.join("\n\n"), { parse_mode: "Markdown" });
  } catch (e) { console.error("/find error:", e.message); }
});

bot.onText(/\/note (\S+) (.+)/, async (msg, match) => {
  try {
    const user = await getApprovedByChatId(msg.chat.id);
    if (!user) return bot.sendMessage(msg.chat.id, "⛔ No access.");
    const num  = normalizePhone(match[1]);
    if (!num) return bot.sendMessage(msg.chat.id, "❌ Invalid phone number.");
    const snap = await clientsCol.where("number", "==", num).limit(1).get();
    if (snap.empty) return bot.sendMessage(msg.chat.id, `❌ Client not found for "${match[1]}".`);
    const docRef = snap.docs[0].ref;
    const c      = snap.docs[0].data();
    const notes  = c.notes || [];
    notes.push({ text: match[2], by: user.name, at: nowIST() });
    await docRef.update({ notes });
    bot.sendMessage(msg.chat.id, `📝 Note added to *${c.name}*\n\n"${match[2]}"`, { parse_mode: "Markdown" });
  } catch (e) { console.error("/note error:", e.message); }
});

bot.onText(/\/status (\S+) (\w+)/, async (msg, match) => {
  try {
    const user = await getApprovedByChatId(msg.chat.id);
    if (!user) return bot.sendMessage(msg.chat.id, "⛔ No access.");
    const valid     = ["Hot","Cold","Closed"];
    const newStatus = capitalize(match[2]);
    if (!valid.includes(newStatus)) return bot.sendMessage(msg.chat.id, "⚠️ Status must be: Hot, Cold, Closed");
    const num  = normalizePhone(match[1]);
    if (!num) return bot.sendMessage(msg.chat.id, "❌ Invalid phone number.");
    const snap = await clientsCol.where("number", "==", num).limit(1).get();
    if (snap.empty) return bot.sendMessage(msg.chat.id, "❌ Client not found.");
    const old = snap.docs[0].data().status;
    await snap.docs[0].ref.update({ status: newStatus });
    const emoji = { Hot:"🔴", Cold:"🔵", Closed:"✅" }[newStatus] || "";
    bot.sendMessage(msg.chat.id, `${emoji} *${snap.docs[0].data().name}* status: ${old} → *${newStatus}*`, { parse_mode: "Markdown" });
  } catch (e) { console.error("/status error:", e.message); }
});

bot.onText(/\/remind (\S+) (\S+)(?: (.+))?/, async (msg, match) => {
  try {
    const user = await getApprovedByChatId(msg.chat.id);
    if (!user) return bot.sendMessage(msg.chat.id, "⛔ No access.");
    const num  = normalizePhone(match[1]);
    if (!num) return bot.sendMessage(msg.chat.id, "❌ Invalid phone number.");
    const snap = await clientsCol.where("number", "==", num).limit(1).get();
    if (snap.empty) return bot.sendMessage(msg.chat.id, "❌ Client not found.");
    const c = snap.docs[0].data();
    await snap.docs[0].ref.update({ followUpDate: match[2], followUpNote: match[3] || "" });
    bot.sendMessage(msg.chat.id,
      `⏰ Follow-up set for *${c.name}*\n📅 ${match[2]}${match[3] ? `\n📌 ${match[3]}` : ""}`,
      { parse_mode: "Markdown" }
    );
  } catch (e) { console.error("/remind error:", e.message); }
});

bot.onText(/\/reminders/, async msg => {
  try {
    if (!await getApprovedByChatId(msg.chat.id)) return bot.sendMessage(msg.chat.id, "⛔ No access.");
    const today = todayIST();
    const snap  = await clientsCol.where("followUpDate", "==", today).get();
    if (snap.empty) return bot.sendMessage(msg.chat.id, "✅ No follow-ups due today.");
    const lines = snap.docs.map(d => {
      const c = d.data();
      return `• *${c.name}* — ${c.product}${c.followUpNote ? `\n  📌 ${c.followUpNote}` : ""}`;
    });
    bot.sendMessage(msg.chat.id, `⏰ *Follow-ups today:*\n\n${lines.join("\n")}`, { parse_mode: "Markdown" });
  } catch (e) { console.error("/reminders error:", e.message); }
});

bot.onText(/\/delete (\S+)/, async (msg, match) => {
  try {
    const user = await getApprovedByChatId(msg.chat.id);
    if (!user) return bot.sendMessage(msg.chat.id, "⛔ No access.");
    const num  = normalizePhone(match[1]);
    if (!num) return bot.sendMessage(msg.chat.id, "❌ Invalid phone number.");
    const snap = await clientsCol.where("number", "==", num).limit(1).get();
    if (snap.empty) return bot.sendMessage(msg.chat.id, "❌ Client not found.");
    const name = snap.docs[0].data().name;
    await snap.docs[0].ref.delete();
    bot.sendMessage(msg.chat.id, `🗑 *${name}* deleted.`, { parse_mode: "Markdown" });
  } catch (e) { console.error("/delete error:", e.message); }
});

bot.onText(/\/adduser (.+)/, async (msg, match) => {
  try {
    const caller = await getApprovedByChatId(msg.chat.id);
    if (!caller || !isAdmin(caller.phone)) return bot.sendMessage(msg.chat.id, "⛔ Admin only.");
    const phone = normalizePhone(match[1]);
    if (!phone) return bot.sendMessage(msg.chat.id, "⚠️ Invalid number.");
    const docSnap = await usersCol.doc(phone).get();
    await usersCol.doc(phone).set(
      { status: "approved", addedAt: new Date().toISOString() },
      { merge: true }
    );
    bot.sendMessage(msg.chat.id, `✅ +${phone} approved!`);
    if (docSnap.exists && docSnap.data().chatId) {
      bot.sendMessage(docSnap.data().chatId, "🎉 *You've been approved!* Send /help to get started.", { parse_mode: "Markdown" });
    }
  } catch (e) { console.error("/adduser error:", e.message); }
});

bot.onText(/\/removeuser (.+)/, async (msg, match) => {
  try {
    const caller = await getApprovedByChatId(msg.chat.id);
    if (!caller || !isAdmin(caller.phone)) return bot.sendMessage(msg.chat.id, "⛔ Admin only.");
    const phone   = normalizePhone(match[1]);
    if (!phone) return bot.sendMessage(msg.chat.id, "⚠️ Invalid number.");
    const docSnap = await usersCol.doc(phone).get();
    if (!docSnap.exists) return bot.sendMessage(msg.chat.id, "⚠️ User not found.");
    const u = docSnap.data();
    await usersCol.doc(phone).delete();
    bot.sendMessage(msg.chat.id, `🗑 ${u.name} removed.`);
    if (u.chatId) bot.sendMessage(u.chatId, "ℹ️ Your access has been removed.");
  } catch (e) { console.error("/removeuser error:", e.message); }
});

bot.onText(/\/users/, async msg => {
  try {
    const caller = await getApprovedByChatId(msg.chat.id);
    if (!caller || !isAdmin(caller.phone)) return bot.sendMessage(msg.chat.id, "⛔ Admin only.");
    const snap     = await usersCol.get();
    const approved = snap.docs.filter(d => d.data().status === "approved").map(d => d.data());
    const pending  = snap.docs.filter(d => d.data().status === "pending").map(d => d.data());
    let text = `👥 *Approved (${approved.length})*\n\n`;
    approved.forEach(u => { text += `• ${u.name} — +${u.phone}\n`; });
    if (pending.length) {
      text += `\n⏳ *Pending (${pending.length})*\n\n`;
      pending.forEach(u => { text += `• ${u.name} — +${u.phone}\n  \`/adduser +${u.phone}\`\n`; });
    }
    bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
  } catch (e) { console.error("/users error:", e.message); }
});

// Main message handler — add client
bot.on("message", async msg => {
  try {
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

    const num = normalizePhone(fields.number);
    if (!num) {
      return bot.sendMessage(msg.chat.id, "❌ Invalid phone number. Please check and try again.");
    }

    const now    = nowIST();
    const today  = todayIST();
    const status = ["Hot","Cold","Closed"].includes(fields.status) ? fields.status : "Hot";
    const docRef = clientsCol.doc();
    await docRef.set({
      name:         fields.name,
      number:       num,
      product:      fields.product,
      price:        fields.price || "",
      status,
      notes:        fields.note ? [{ text: fields.note, by: user.name, at: now }] : [],
      followUpDate: fields.followUpDate || "",
      followUpNote: "",
      addedBy:      user.name,
      addedOn:      now,
      date:         today,
      createdAt:    admin.firestore.FieldValue.serverTimestamp(),
    });

    const emoji = { Hot:"🔴", Cold:"🔵", Closed:"✅" }[status] || "🔴";
    bot.sendMessage(msg.chat.id,
      `✅ *Client saved!*\n\n` +
      `👤 ${fields.name}\n📞 ${num}\n📦 ${fields.product}` +
      `${fields.price ? `\n💰 ₹${fields.price}` : ""}` +
      `\n${emoji} ${status}` +
      `${fields.note ? `\n📝 ${fields.note}` : ""}` +
      `\n📅 ${today}\n\n` +
      `_/note ${num} your note_\n` +
      `_/remind ${num} 25/03/2026_\n\n` +
      `🌐 [View Dashboard](${process.env.DASHBOARD_URL || "https://client.webolev.com"})`,
      { parse_mode: "Markdown" }
    );
  } catch (e) { console.error("message handler error:", e.message); }
});

// ── Daily Reminders ───────────────────────────────────────────────────────────
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

// FIX: Wrapped in try/catch so a Firestore error doesn't crash the process
async function sendDailyReminders() {
  try {
    const today     = todayIST();
    const dueSnap   = await clientsCol.where("followUpDate", "==", today).get();
    if (dueSnap.empty) return;
    const usersSnap = await usersCol.where("status", "==", "approved").get();
    const lines     = dueSnap.docs.map(d => {
      const c = d.data();
      return `• *${c.name}* — ${c.product}${c.followUpNote ? `\n  📌 ${c.followUpNote}` : ""}`;
    });
    usersSnap.docs.forEach(d => {
      const u = d.data();
      if (u.chatId) {
        bot.sendMessage(u.chatId,
          `🌅 *Good morning! Follow-ups today:*\n\n${lines.join("\n")}\n\nSend /reminders anytime.`,
          { parse_mode: "Markdown" }
        ).catch(e => console.error("sendDailyReminders sendMessage failed:", e.message));
      }
    });
  } catch (e) {
    console.error("sendDailyReminders error:", e.message);
  }
}

scheduleDailyReminders();
console.log("✅ Telegram bot started");

// ── Express API ───────────────────────────────────────────────────────────────
const app = express();
app.use(helmet());

const allowedOrigins = [
  "https://client.webolev.com",
  "http://localhost:5173",
  "http://localhost:5174",
  ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(",").map(s => s.trim()) : []),
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS blocked: ${origin}`));
  },
  methods: ["GET","POST","PATCH","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization"],
  credentials: true,
}));

app.use(express.json({ limit: "10kb" }));
app.use("/api/", rateLimit({ windowMs: 15 * 60 * 1000, max: 300 }));

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", ts: Date.now() });
});

// ── Auth middleware ───────────────────────────────────────────────────────────
async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });
  try {
    const decoded = await admin.auth().verifyIdToken(header.split(" ")[1]);
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

// GET clients
app.get("/api/clients", authMiddleware, async (req, res) => {
  try {
    const page   = parseInt(req.query.page)  || 1;
    const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
    const search = req.query.search?.toLowerCase() || "";
    const status = req.query.status || "";

    // FIX: avoid composite index requirement — filter by status without orderBy, sort in memory
    let query;
    if (status && ["Hot","Cold","Closed"].includes(status)) {
      query = clientsCol.where("status", "==", status);
    } else {
      query = clientsCol.orderBy("createdAt", "desc");
    }

    const snap = await query.get();
    let docs   = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (status) {
      docs.sort((a, b) => {
        const ta = a.createdAt?.toMillis?.() ?? 0;
        const tb = b.createdAt?.toMillis?.() ?? 0;
        return tb - ta;
      });
    }

    if (search) {
      docs = docs.filter(c =>
        c.name?.toLowerCase().includes(search) ||
        c.number?.includes(search) ||
        c.product?.toLowerCase().includes(search)
      );
    }

    const total   = docs.length;
    const clients = docs.slice((page - 1) * limit, page * limit);
    res.json({ clients, total, page, pages: Math.ceil(total / limit) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/followups/today", authMiddleware, async (req, res) => {
  try {
    const today = todayIST();
    const snap  = await clientsCol.where("followUpDate", "==", today).get();
    res.json({ due: snap.docs.map(d => ({ id: d.id, ...d.data() })), today });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/clients/download", authMiddleware, async (req, res) => {
  try {
    const excelPath = await rebuildExcel();
    res.download(excelPath, "clients.xlsx");
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/stats", authMiddleware, async (req, res) => {
  try {
    const [allSnap, hotSnap, coldSnap, closedSnap, usersSnap, pendingSnap, productsSnap] = await Promise.all([
      clientsCol.count().get(),
      clientsCol.where("status","==","Hot").count().get(),
      clientsCol.where("status","==","Cold").count().get(),
      clientsCol.where("status","==","Closed").count().get(),
      usersCol.where("status","==","approved").count().get(),
      usersCol.where("status","==","pending").count().get(),
      clientsCol.select("product").get(),
    ]);
    const products = [...new Set(productsSnap.docs.map(d => d.data().product).filter(Boolean))];
    res.set("Cache-Control", "public, max-age=30");
    res.json({
      total:         allSnap.data().count,
      products,
      byStatus:      { Hot: hotSnap.data().count, Cold: coldSnap.data().count, Closed: closedSnap.data().count },
      approvedUsers: usersSnap.data().count,
      pendingUsers:  pendingSnap.data().count,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/users", authMiddleware, async (req, res) => {
  try {
    const snap     = await usersCol.get();
    const approved = snap.docs.filter(d => d.data().status === "approved").map(d => ({ id: d.id, ...d.data() }));
    const pending  = snap.docs.filter(d => d.data().status === "pending").map(d => ({ id: d.id, ...d.data() }));
    res.json({ approved, pending });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/clients", authMiddleware, async (req, res) => {
  try {
    const { name, number, product, price, status, note, followUpDate, followUpNote, addedBy } = req.body;
    if (!name || !number || !product) return res.status(400).json({ error: "name, number, product required" });
    if (name.length > 100 || product.length > 100) return res.status(400).json({ error: "Input too long" });
    const num = normalizePhone(number);
    if (!num) return res.status(400).json({ error: "Invalid phone number" });
    const now    = nowIST();
    const docRef = clientsCol.doc();
    const data   = {
      name, number: num, product,
      price:        price || "",
      status:       ["Hot","Cold","Closed"].includes(status) ? status : "Hot",
      notes:        note ? [{ text: note, by: addedBy || "Dashboard", at: now }] : [],
      followUpDate: followUpDate || "",
      followUpNote: followUpNote || "",
      addedBy:      addedBy || req.user.email || "Dashboard",
      addedOn:      now,
      date:         todayIST(),
      createdAt:    admin.firestore.FieldValue.serverTimestamp(),
    };
    await docRef.set(data);
    res.status(201).json({ id: docRef.id, ...data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch("/api/clients/:id", authMiddleware, async (req, res) => {
  try {
    const allowed = ["status","price","followUpDate","followUpNote","name","number","product"];
    const update  = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    if (Object.keys(update).length === 0) return res.status(400).json({ error: "Nothing to update" });
    const docRef = clientsCol.doc(req.params.id);
    await docRef.update(update);
    const updated = await docRef.get();
    res.json({ id: updated.id, ...updated.data() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/clients/:id/notes", authMiddleware, async (req, res) => {
  try {
    const docRef  = clientsCol.doc(req.params.id);
    const docSnap = await docRef.get();
    if (!docSnap.exists) return res.status(404).json({ error: "Not found" });
    const notes = docSnap.data().notes || [];
    notes.push({ text: req.body.text, by: req.body.by || req.user.email || "Dashboard", at: nowIST() });
    await docRef.update({ notes });
    const updated = await docRef.get();
    res.json({ id: updated.id, ...updated.data() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/clients/:id", authMiddleware, async (req, res) => {
  try {
    await clientsCol.doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/users/approve", authMiddleware, async (req, res) => {
  try {
    const { phone, name, chatId } = req.body;
    if (!phone) return res.status(400).json({ error: "phone required" });
    const norm = normalizePhone(phone);
    if (!norm) return res.status(400).json({ error: "Invalid phone" });
    await usersCol.doc(norm).set(
      { status: "approved", name: name || "User", chatId: chatId || null, addedAt: new Date().toISOString() },
      { merge: true }
    );
    const docSnap = await usersCol.doc(norm).get();
    if (docSnap.data()?.chatId) {
      bot.sendMessage(docSnap.data().chatId, "🎉 *You've been approved!* Send /help to start.", { parse_mode: "Markdown" });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/users/:phone", authMiddleware, async (req, res) => {
  try {
    const norm = normalizePhone(req.params.phone);
    if (!norm) return res.status(400).json({ error: "Invalid phone" });
    const docSnap = await usersCol.doc(norm).get();
    if (docSnap.exists && docSnap.data().chatId) {
      bot.sendMessage(docSnap.data().chatId, "ℹ️ Your access has been removed.");
    }
    await usersCol.doc(norm).delete();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error("Express error:", err.message);
  if (err.message?.includes("CORS")) return res.status(403).json({ error: "CORS blocked" });
  res.status(500).json({ error: "Internal server error" });
});

// ── Uncaught exception safety net ─────────────────────────────────────────────
process.on("uncaughtException",  e => console.error("Uncaught exception:", e.message));
process.on("unhandledRejection", e => console.error("Unhandled rejection:", e));

app.listen(PORT, () => console.log(`✅ API server on http://localhost:${PORT}`));