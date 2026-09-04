import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { loadEnv } from "./loadenv.js";
import { initDb, logEvent, markSending, markSent, markFailed, isDuplicateBySubject, getSummaryCounts, getRecentFailures } from "./db.js";
import { searchOrders, sendDeliveryEmail, sendOwnerSummary, fetchTorrentFromGmail } from "./gmail.js";
import {
  isOrderConfirmation,
  isSimsText,
  extractBuyerEmail,
  extractOrderAmount,
} from "./order.js";
import { createDashboardServer } from "./dashboard.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
loadEnv(path.join(ROOT, ".env"));

const BANNER_PATH = process.env.BANNER_PATH || path.join(ROOT, "assets", "email_banner.gif");
const TORRENT_PATH = process.env.TORRENT_PATH || path.join(ROOT, "assets", "torrent.torrent");
const TORRENT_FILENAME = process.env.TORRENT_FILENAME || "The Sims 4 Ultimate Collection v1.125.59.1030.torrent";
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "120000", 10);
const PORT = parseInt(process.env.PORT || "3000", 10);
const DASHBOARD_TOKEN = process.env.ACCESS_TOKEN || "";
const ALLOW_SEND = String(process.env.ALLOW_SEND || "true").toLowerCase() === "true";
const DISABLE_DASHBOARD = String(process.env.DISABLE_DASHBOARD || "false").toLowerCase() === "true";
const OWNER_EMAIL = (process.env.OWNER_EMAIL || process.env.GMAIL_ADDRESS || "").trim();
const SUMMARY_INTERVAL_MS = Math.max(6 * 60 * 60 * 1000, parseInt(process.env.SUMMARY_INTERVAL_MS || String(12 * 60 * 60 * 1000), 10));
const TORRENT_MARKER = process.env.TORRENT_MARKER || "SIMS4 TORRENT";

let db;
let lastSummaryAt = Date.now();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Cloud instances have an ephemeral disk: assets checked out of git only
// contain the banner. The torrent (too big to push on a flaky connection) is
// stored as an email attachment sent to the owner's own Gmail account and
// pulled down here at startup.
async function ensureTorrentFile() {
  if (fs.existsSync(TORRENT_PATH)) {
    return;
  }
  if (!process.env.GMAIL_ADDRESS || !process.env.GMAIL_APP_PASSWORD) return;
  console.log(`Torrent file missing at ${TORRENT_PATH}. Fetching from Gmail (subject marker: "${TORRENT_MARKER}")...`);
  try {
    const buf = await fetchTorrentFromGmail(TORRENT_MARKER);
    if (!buf || buf.length === 0) {
      console.error("Torrent not found in Gmail. Send yourself an email with subject containing '" + TORRENT_MARKER + "' and the .torrent attached.");
      return;
    }
    fs.mkdirSync(path.dirname(TORRENT_PATH), { recursive: true });
    fs.writeFileSync(TORRENT_PATH, buf);
    console.log(`Torrent stored (${buf.length} bytes).`);
  } catch (e) {
    console.error("Failed to fetch torrent from Gmail:", e.message);
  }
}

async function processOrder(item) {
  const { subject, bodyText, htmlText, from: fromEmail, replyTo } = item;
  // Detection uses subject + plain text only. HTML is used only as a
  // buyer-email fallback source (mailto links).
  const fullText = (subject + "\n" + bodyText).toLowerCase();
  const hasOrder = isOrderConfirmation(fullText);
  const hasSims = isSimsText(fullText);

  const buyer = extractBuyerEmail(subject, bodyText, htmlText, replyTo, fromEmail);
  const orderAmount = extractOrderAmount(subject);

  logEvent(db, {
    level: "info",
    action: "extracted",
    detail: `order=${hasOrder} sims=${hasSims} amount=${orderAmount || "?"} buyerMethod=${buyer.method || "none"} send=${ALLOW_SEND}`,
    messageId: subject,
    buyerEmail: buyer.email || "",
  });

  if (!hasOrder || !hasSims) {
    logEvent(db, {
      level: "info",
      action: "skipped",
      detail: `Not a Sims order (order=${hasOrder}, sims=${hasSims}): ${subject.slice(0, 120)}`,
      messageId: subject,
      buyerEmail: buyer.email || "",
    });
    return { action: "skipped", reason: !hasOrder ? "not-order" : "not-sims" };
  }

  if (!buyer.email) {
    logEvent(db, {
      level: "warn",
      action: "needs-manual",
      detail: `Sims order confirmed but no buyer email found: ${subject.slice(0, 150)}`,
      messageId: subject,
    });
    return { action: "needs-manual" };
  }

  if (isDuplicateBySubject(db, subject)) {
    logEvent(db, {
      level: "info",
      action: "duplicate",
      detail: `Already processed: ${subject.slice(0, 120)}`,
      messageId: subject,
    });
    return { action: "duplicate" };
  }

  if (!ALLOW_SEND) {
    // Monitor-only mode (used on the local PC): detect + log, never send.
    logEvent(db, {
      level: "info",
      action: "detected-only",
      detail: `Order detected (send disabled on this instance): ${subject.slice(0, 120)}`,
      messageId: subject,
      buyerEmail: buyer.email,
    });
    return { action: "detected-only", buyerEmail: buyer.email };
  }

  markSending(db, subject, subject, orderAmount, buyer.email);

  logEvent(db, {
    level: "info",
    action: "sending",
    detail: `Sending delivery to ${buyer.email} (order ${orderAmount})`,
    messageId: subject,
    buyerEmail: buyer.email,
  });

  try {
    const sentId = await sendDeliveryEmail(buyer.email, BANNER_PATH, TORRENT_PATH, TORRENT_FILENAME);
    markSent(db, subject);
    logEvent(db, {
      level: "success",
      action: "sent",
      detail: `Delivered to ${buyer.email} (order ${orderAmount}) msg-id=${sentId}`,
      messageId: subject,
      buyerEmail: buyer.email,
    });
    return { action: "sent", buyerEmail: buyer.email };
  } catch (e) {
    markFailed(db, subject, e.message);
    logEvent(db, {
      level: "error",
      action: "failed",
      detail: String(e.message).slice(0, 500),
      messageId: subject,
      buyerEmail: buyer.email,
    });
    return { action: "failed", reason: e.message };
  }
}

async function runScan() {
  logEvent(db, { level: "info", action: "scan", detail: "Starting Gmail IMAP scan..." });

  const results = [];
  let processed = 0;

  try {
    await searchOrders(async (items) => {
      for (const item of items) {
        processed++;
        if (processed > 40) {
          logEvent(db, { level: "info", action: "scan", detail: "Reached max 40 per scan, deferring rest." });
          break;
        }
        const res = await processOrder(item);
        results.push({ subject: item.subject.slice(0, 80), ...res });
      }
    });
  } catch (e) {
    logEvent(db, { level: "error", action: "scan", detail: String(e.message).slice(0, 500) });
    return { ok: false, error: e.message, processed, results };
  }

  logEvent(db, {
    level: "info",
    action: "scan",
    detail: `Scan complete. Checked ${processed} message(s), actions: ${JSON.stringify(results.map((r) => r.action))}`,
  });

  return { ok: true, processed, results };
}

async function maybeSendSummary() {
  if (!ALLOW_SEND) return; // only the cloud sender reports
  if (!OWNER_EMAIL) return;
  if (Date.now() - lastSummaryAt < SUMMARY_INTERVAL_MS) return;
  if (DISABLE_DASHBOARD && !db) return;

  lastSummaryAt = Date.now();
  try {
    const counts = getSummaryCounts(db);
    const failures = getRecentFailures(db, 10);
    const lines = [
      `Sims4 Order Mailer summary (${new Date().toISOString()})`,
      "",
      `Delivered today: ${counts.sentToday}`,
      `Failed (total): ${counts.failed}`,
      `Needs manual handling: ${counts.needsManual}`,
      `Last delivery at: ${counts.lastSentAt || "never"}`,
    ];
    if (failures.length) {
      lines.push("", "Recent failures:");
      for (const f of failures) {
        lines.push(`- ${f.buyer_email || "?"} | ${(f.subject || "").slice(0, 80)} | ${(f.last_error || "").slice(0, 120)}`);
      }
    }
    await sendOwnerSummary(OWNER_EMAIL, lines.join("\n"));
    logEvent(db, { level: "info", action: "summary", detail: "Owner summary email sent." });
  } catch (e) {
    logEvent(db, { level: "error", action: "summary", detail: String(e.message).slice(0, 300) });
  }
}

async function pollLoop() {
  console.log(`[${new Date().toISOString()}] Starting poll loop (interval: ${POLL_INTERVAL_MS / 1000}s)`);

  while (true) {
    try {
      console.log(`[${new Date().toISOString()}] Running scan...`);
      const result = await runScan();
      console.log(`[${new Date().toISOString()}] Scan result:`, JSON.stringify(result));
    } catch (e) {
      console.error(`[${new Date().toISOString()}] Poll error:`, e.message);
    }
    await maybeSendSummary();
    await sleep(POLL_INTERVAL_MS);
  }
}

function startDashboard() {
  if (DISABLE_DASHBOARD) {
    console.log("Dashboard disabled (DISABLE_DASHBOARD=true). No web listener started.");
    return;
  }
  const server = createDashboardServer(db, runScan);
  // Bind to loopback ONLY so nothing on the network or cloud can reach it.
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`Dashboard running on http://127.0.0.1:${PORT}`);
    if (!DASHBOARD_TOKEN) {
      console.error("WARNING: ACCESS_TOKEN not set. Set it before going online.");
    } else {
      console.log(`Dashboard token: use ?token=${DASHBOARD_TOKEN} to access`);
    }
  });
  server.on("error", (e) => {
    console.error("Dashboard server error:", e.message);
  });
}

async function main() {
  console.log("=== Sims4 Order Mailer v2 (secure) ===");
  console.log(`Gmail: ${process.env.GMAIL_ADDRESS ? "configured" : "(not set)"}`);
  console.log(`Send enabled: ${ALLOW_SEND}`);
  console.log(`Dashboard: ${DISABLE_DASHBOARD ? "disabled" : "bound to 127.0.0.1"}`);
  console.log(`Owner summary email: ${OWNER_EMAIL ? "configured" : "(not set)"}`);
  console.log(`Poll interval: ${POLL_INTERVAL_MS / 1000}s`);
  console.log("");

  db = await initDb();
  await ensureTorrentFile();

  startDashboard();
  pollLoop().catch((e) => {
    console.error("Poll loop fatal:", e);
    process.exit(1);
  });
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});