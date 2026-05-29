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

// ── Firestore Collections ────────────────────────────────────────────────────
const clientsCol = db.collection("clients");
const usersCol   = db.collection("users");

// ── Helpers ──────────────────────────────────────────────────────────────────
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

// ── Smart Parser ─────────────────────────────────────────────────────────────
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

// ── Excel Export ─────────────────────────────────────────────────────────────
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

// ── Telegram Bot ─────────────────────────────────────────────────────────────
const bot = new TelegramBot(TOKEN, { 
  polling: {
    autoStart: true,
    params: { timeout: 10 }
  }
});

bot.on("polling_error", (err) => {
  console.error("Telegram polling error:", err.code, err.message);
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

    const dupSnap = await clientsCol.where("number", "==", num).limit(1).get();
    if (!dupSnap.empty) {
      const existing = dupSnap.docs[0].data();
      return bot.sendMessage(msg.chat.id,
        `⚠️ *Client already exists!*\n\n👤 ${existing.name} — ${existing.product}\n📞 ${num}\n\nUse /note ${num} to add a note.`,
        { parse_mode: "Markdown" }
      );
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
app.set('trust proxy', 1);
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
  allowedHeaders: ["Content-Type","Authorization","x-vault-token"],
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

// ── Approved middleware ──────────────────────────────────────────────────
// Prevents any Firebase user (even ones not in your users collection) from
// accessing the API. Only approved users in Firestore can proceed.
async function approvedMiddleware(req, res, next) {
  try {
    const email = req.user?.email;
    const uid   = req.user?.uid;
    if (!email && !uid) return res.status(403).json({ error: "Access denied." });

    // Check by email first (dashboard users)
    if (email) {
      const byEmail = await usersCol
        .where("email", "==", email)
        .where("status", "==", "approved")
        .limit(1).get();
      if (!byEmail.empty) return next();
    }

    // Fallback: check by uid (Firebase UID stored on user doc)
    if (uid) {
      const byUid = await usersCol
        .where("uid", "==", uid)
        .where("status", "==", "approved")
        .limit(1).get();
      if (!byUid.empty) return next();
    }

    return res.status(403).json({ error: "Access denied. Not an approved user." });
  } catch (e) {
    console.error("approvedMiddleware error:", e.message);
    res.status(500).json({ error: "Auth check failed" });
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────
// NOTE: All sensitive routes now use BOTH authMiddleware AND approvedMiddleware
app.get("/api/clients", authMiddleware, approvedMiddleware, async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = Math.min(parseInt(req.query.limit) || 100, 200);
    const search = req.query.search?.toLowerCase() || "";
    const status = req.query.status || "";

    // Always query ordered by createdAt desc — no JS sort needed
    let query = clientsCol.orderBy("createdAt", "desc");
    if (status && ["Hot","Cold","Closed"].includes(status)) {
      query = clientsCol.where("status", "==", status).orderBy("createdAt", "desc");
    }

    const snap = await query.get();
    let docs   = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (search) {
      docs = docs.filter(c =>
        c.name?.toLowerCase().includes(search) ||
        c.number?.includes(search) ||
        c.product?.toLowerCase().includes(search)
      );
    }

    const total   = docs.length;
    const clients = docs.slice((page - 1) * limit, page * limit);
    res.set("Cache-Control", "private, max-age=20");
    res.json({ clients, total, page, pages: Math.ceil(total / limit) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// Frontend calls this on initial load instead of two separate calls
app.get("/api/dashboard", authMiddleware, approvedMiddleware, async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = Math.min(parseInt(req.query.limit) || 100, 200);

    const [
      clientsSnap,
      hotSnap, coldSnap, closedSnap,
      usersSnap, pendingSnap,
      productsSnap,
    ] = await Promise.all([
      clientsCol.orderBy("createdAt", "desc").get(),
      clientsCol.where("status", "==", "Hot").count().get(),
      clientsCol.where("status", "==", "Cold").count().get(),
      clientsCol.where("status", "==", "Closed").count().get(),
      usersCol.where("status", "==", "approved").count().get(),
      usersCol.where("status", "==", "pending").count().get(),
      clientsCol.select("product").get(),
    ]);

    const allDocs  = clientsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const total    = allDocs.length;
    const clients  = allDocs.slice((page - 1) * limit, page * limit);
    const products = [...new Set(productsSnap.docs.map(d => d.data().product).filter(Boolean))];

    res.set("Cache-Control", "private, max-age=20");
    res.json({
      clients,
      total,
      page,
      pages: Math.ceil(total / limit),
      stats: {
        total,
        products,
        byStatus: {
          Hot:    hotSnap.data().count,
          Cold:   coldSnap.data().count,
          Closed: closedSnap.data().count,
        },
        approvedUsers: usersSnap.data().count,
        pendingUsers:  pendingSnap.data().count,
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/followups/today", authMiddleware, approvedMiddleware, async (req, res) => {
  try {
    const today = todayIST();
    const snap  = await clientsCol.where("followUpDate", "==", today).get();
    res.json({ due: snap.docs.map(d => ({ id: d.id, ...d.data() })), today });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/clients/download", authMiddleware, approvedMiddleware, async (req, res) => {
  try {
    const excelPath = await rebuildExcel();
    res.download(excelPath, "clients.xlsx");
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/stats", authMiddleware, approvedMiddleware, async (req, res) => {
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
    res.set("Cache-Control", "private, max-age=30");
    res.json({
      total:         allSnap.data().count,
      products,
      byStatus:      { Hot: hotSnap.data().count, Cold: coldSnap.data().count, Closed: closedSnap.data().count },
      approvedUsers: usersSnap.data().count,
      pendingUsers:  pendingSnap.data().count,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/users", authMiddleware, approvedMiddleware, async (req, res) => {
  try {
    const snap     = await usersCol.get();
    const approved = snap.docs.filter(d => d.data().status === "approved").map(d => ({ id: d.id, ...d.data() }));
    const pending  = snap.docs.filter(d => d.data().status === "pending").map(d => ({ id: d.id, ...d.data() }));
    res.json({ approved, pending });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/clients", authMiddleware, approvedMiddleware, async (req, res) => {
  try {
    const { name, number, product, price, status, note, followUpDate, followUpNote, addedBy } = req.body;
    if (!name || !number || !product) return res.status(400).json({ error: "name, number, product required" });
    if (name.length > 100 || product.length > 100) return res.status(400).json({ error: "Input too long" });
    const num = normalizePhone(number);
    if (!num) return res.status(400).json({ error: "Invalid phone number" });


const dupSnap = await clientsCol.where("number", "==", num).limit(1).get();
if (!dupSnap.empty) return res.status(409).json({ error: "Client with this number already exists" });

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

app.patch("/api/clients/:id", authMiddleware, approvedMiddleware, async (req, res) => {
  try {
    const allowed = ["status","price","followUpDate","followUpNote","name","number","product"];
    const update  = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    if (Object.keys(update).length === 0) return res.status(400).json({ error: "Nothing to update" });
    const docRef = clientsCol.doc(req.params.id);
    // Use transaction so we read+write in one round trip instead of two
    const result = await db.runTransaction(async t => {
      const snap = await t.get(docRef);
      if (!snap.exists) throw new Error("Not found");
      t.update(docRef, update);
      return { id: snap.id, ...snap.data(), ...update };
    });
    res.json(result);
  } catch (e) {
    if (e.message === "Not found") return res.status(404).json({ error: "Client not found" });
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/clients/:id/notes", authMiddleware, approvedMiddleware, async (req, res) => {
  try {
    const { text, by } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: "Note text required" });
    const docRef = clientsCol.doc(req.params.id);
    const result = await db.runTransaction(async t => {
      const snap = await t.get(docRef);
      if (!snap.exists) throw new Error("Not found");
      const notes = [...(snap.data().notes || [])];
      notes.push({ text, by: by || req.user.email || "Dashboard", at: nowIST() });
      t.update(docRef, { notes });
      return { id: snap.id, ...snap.data(), notes };
    });
    res.json(result);
  } catch (e) {
    if (e.message === "Not found") return res.status(404).json({ error: "Client not found" });
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/clients/:id", authMiddleware, approvedMiddleware, async (req, res) => {
  try {
    await clientsCol.doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/users/approve", authMiddleware, approvedMiddleware, async (req, res) => {
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

app.delete("/api/users/:phone", authMiddleware, approvedMiddleware, async (req, res) => {
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


// ── GET /api/machines ─────────────────────────────────────────────
app.get("/api/machines", authMiddleware, approvedMiddleware, async (req, res) => {
  try {
    const snap = await machinesCol.orderBy("createdAt", "asc").get();
    const machines = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.set("Cache-Control", "private, max-age=30");
    res.json({ machines });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/machines ────────────────────────────────────────────
app.post("/api/machines", authMiddleware, approvedMiddleware, async (req, res) => {
  try {
    const { name, category, power, notes, variants } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: "name required" });

    // variants: [{ label, capacity, size, price }]
    const cleanVariants = Array.isArray(variants)
      ? variants.map(v => ({
          id:       v.id || `v_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
          label:    v.label    || "",
          capacity: v.capacity || "",
          size:     v.size     || "",
          price:    v.price    || "",
        }))
      : [];

    const docRef = machinesCol.doc();
    const data = {
      name:      name.trim(),
      category:  category  || "",
      power:     power     || "",
      notes:     notes     || "",
      variants:  cleanVariants,
      addedBy:   req.user.email || "Dashboard",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await docRef.set(data);
    res.status(201).json({ id: docRef.id, ...data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/machines/:id ───────────────────────────────────────
app.patch("/api/machines/:id", authMiddleware, approvedMiddleware, async (req, res) => {
  try {
    const { name, category, power, notes, variants } = req.body;
    const update = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    if (name      !== undefined) update.name     = name.trim();
    if (category  !== undefined) update.category = category;
    if (power     !== undefined) update.power    = power;
    if (notes     !== undefined) update.notes    = notes;
    if (variants  !== undefined) {
      update.variants = variants.map(v => ({
        id:       v.id || `v_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
        label:    v.label    || "",
        capacity: v.capacity || "",
        size:     v.size     || "",
        price:    v.price    || "",
      }));
    }
    const docRef = machinesCol.doc(req.params.id);
    const snap   = await docRef.get();
    if (!snap.exists) return res.status(404).json({ error: "Machine not found" });
    await docRef.update(update);
    res.json({ id: snap.id, ...snap.data(), ...update });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/machines/:id ──────────────────────────────────────
app.delete("/api/machines/:id", authMiddleware, approvedMiddleware, async (req, res) => {
  try {
    await machinesCol.doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════
// VAULT — Secure Password Store
// ════════════════════════════════════════════════════════════════
const crypto  = require("crypto");
const jwt     = require("jsonwebtoken");

const VAULT_OTP     = process.env.VAULT_OTP;
const VAULT_SECRET  = process.env.VAULT_JWT_SECRET;
const VAULT_ENC_KEY = process.env.VAULT_ENCRYPT_KEY; // must be 32 chars
const vaultCol      = db.collection("vault");

// ── Encrypt / Decrypt ─────────────────────────────────────────
function encrypt(text) {
  const iv  = crypto.randomBytes(16);
  const key = Buffer.from(VAULT_ENC_KEY.padEnd(32).slice(0, 32));
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
}

function decrypt(data) {
  const [ivHex, encHex] = data.split(":");
  const iv  = Buffer.from(ivHex, "hex");
  const key = Buffer.from(VAULT_ENC_KEY.padEnd(32).slice(0, 32));
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  const dec = Buffer.concat([decipher.update(Buffer.from(encHex, "hex")), decipher.final()]);
  return dec.toString("utf8");
}

// ── Vault JWT middleware ───────────────────────────────────────
function vaultAuth(req, res, next) {
  const header = req.headers["x-vault-token"];
  if (!header) return res.status(401).json({ error: "Vault token required" });
  try {
    req.vault = jwt.verify(header, VAULT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired vault token" });
  }
}

// ── POST /api/vault/verify — check OTP, return vault JWT ──────
app.post("/api/vault/verify", authMiddleware, (req, res) => {
  if (!VAULT_OTP || !VAULT_SECRET || !VAULT_ENC_KEY) {
    return res.status(500).json({ error: "Vault not configured" });
  }
  const { otp } = req.body;
  if (!otp || String(otp).trim() !== String(VAULT_OTP).trim()) {
    return res.status(403).json({ error: "Invalid OTP" });
  }
  const token = jwt.sign(
    { uid: req.user.uid, vault: true },
    VAULT_SECRET,
    { expiresIn: "1h" }
  );
  res.json({ token });
});

// ── GET /api/vault/entries — list all decrypted entries ───────
app.get("/api/vault/entries", authMiddleware, vaultAuth, async (req, res) => {
  try {
    const snap    = await vaultCol.orderBy("createdAt", "desc").get();
    const entries = snap.docs.map(d => {
      const data = d.data();
      return {
        id:        d.id,
        title:     data.title,
        username:  data.username  ? decrypt(data.username)  : "",
        password:  data.password  ? decrypt(data.password)  : "",
        url:       data.url       ? decrypt(data.url)       : "",
        note:      data.note      ? decrypt(data.note)      : "",
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
      };
    });
    res.json({ entries });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/vault/entries — save new entry ──────────────────
app.post("/api/vault/entries", authMiddleware, vaultAuth, async (req, res) => {
  try {
    const { title, username, password, url, note } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: "Title required" });
    const now  = admin.firestore.FieldValue.serverTimestamp();
    const data = {
      title:    title.trim(),
      username: username ? encrypt(username) : "",
      password: password ? encrypt(password) : "",
      url:      url      ? encrypt(url)      : "",
      note:     note     ? encrypt(note)     : "",
      addedBy:  req.user.uid,
      createdAt: now,
      updatedAt: now,
    };
    const ref = vaultCol.doc();
    await ref.set(data);
    res.status(201).json({
      id: ref.id, title,
      username: username || "",
      password: password || "",
      url: url || "", note: note || "",
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/vault/entries/:id — update entry ───────────────
app.patch("/api/vault/entries/:id", authMiddleware, vaultAuth, async (req, res) => {
  try {
    const { title, username, password, url, note } = req.body;
    const update = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    if (title    !== undefined) update.title    = title.trim();
    if (username !== undefined) update.username = username ? encrypt(username) : "";
    if (password !== undefined) update.password = password ? encrypt(password) : "";
    if (url      !== undefined) update.url      = url      ? encrypt(url)      : "";
    if (note     !== undefined) update.note     = note     ? encrypt(note)     : "";
    await vaultCol.doc(req.params.id).update(update);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/vault/entries/:id — delete entry ──────────────
app.delete("/api/vault/entries/:id", authMiddleware, vaultAuth, async (req, res) => {
  try {
    await vaultCol.doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ── Uncaught exception safety net ────────────────────────────────────────────
process.on("uncaughtException",  e => console.error("Uncaught exception:", e.message));
process.on("unhandledRejection", e => console.error("Unhandled rejection:", e));

app.listen(PORT, () => console.log(`✅ API server on http://localhost:${PORT}`));