import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { buildDeliveryHtml, buildDeliveryText, DELIVERY_SUBJECT } from "./order.js";

function getImapConfig() {
  return {
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: {
      user: process.env.GMAIL_ADDRESS,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
    logger: false,
  };
}

function getSmtpConfig() {
  return {
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
      user: process.env.GMAIL_ADDRESS,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  };
}

function decodeMimeWord(s) {
  if (!s) return "";
  // Decode RFC 2047 encoded-words, e.g. =?UTF-8?B?...?= or =?UTF-8?Q?...?=
  return s.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, enc, text) => {
    try {
      if (enc.toUpperCase() === "B") return Buffer.from(text, "base64").toString("utf-8");
      return decodeURIComponent(text.replace(/=/g, "%").replace(/_/g, " "));
    } catch {
      return text;
    }
  }).trim();
}

function parseRawMessage(raw) {
  const text = raw.toString("utf-8").replace(/\r\n/g, "\n");
  const idx = text.indexOf("\n\n");
  const headText = idx === -1 ? text : text.slice(0, idx);
  const bodyStart = idx === -1 ? text.length : idx + 2;
  const lowerHead = headText.toLowerCase();

  // Body: extract text/plain and text/html parts.
  let bodyText = "";
  let htmlText = "";

  const boundaryMatch = headText.match(/boundary\s*=\s*"?([^";\s]+)"?/i);
  if (boundaryMatch) {
    const boundary = boundaryMatch[1];
    const parts = text.slice(bodyStart).split("--" + boundary);
    for (const part of parts) {
      const pIdx = part.indexOf("\n\n");
      if (pIdx === -1) continue;
      const partHead = part.slice(0, pIdx).toLowerCase();
      const partBody = part.slice(pIdx + 2).replace(/\n--$/, "");

      const typeM = partHead.match(/content-type\s*:\s*([^;\r\n]+)/);
      const contentType = typeM ? typeM[1].toLowerCase() : "";

      if (contentType.includes("multipart/")) {
        continue;
      }
      if (contentType.includes("text/plain")) {
        bodyText += (partBody || "") + "\n";
      } else if (contentType.includes("text/html")) {
        htmlText += (partBody || "") + "\n";
      }
    }
    if (!bodyText && !htmlText && bodyStart < text.length) {
      bodyText = text.slice(bodyStart);
    }
  } else {
    if (lowerHead.includes("content-type: text/plain")) {
      bodyText = text.slice(bodyStart);
    } else if (lowerHead.includes("content-type: text/html")) {
      htmlText = text.slice(bodyStart);
    } else {
      bodyText = text.slice(bodyStart);
    }
  }

  // Basic base64 / quoted-printable decoding of the extracted parts.
  bodyText = decodeBodyPart(bodyText);
  htmlText = decodeBodyPart(htmlText);

  return { bodyText, htmlText };
}

function decodeBodyPart(part) {
  if (!part) return "";
  // Trim leading/trailing blank lines.
  const trimmed = part.trim();
  if (!trimmed) return "";
  // If it looks like base64 (long runs of base64 chars), try decode.
  if (/^[A-Za-z0-9+/=\r\n]+$/.test(trimmed) && trimmed.length > 40 && trimmed.length % 4 === 0) {
    try {
      const decoded = Buffer.from(trimmed.replace(/[\r\n]/g, ""), "base64").toString("utf-8");
      if (decoded.length > 0 && !decoded.includes("\uFFFD")) return decoded;
    } catch { /* fall through */ }
  }
  return trimmed;
}

export async function searchOrders(callback) {
  const client = new ImapFlow(getImapConfig());

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");

    try {
      const query = {
        or: [
          { from: "etsy.com" },
          { from: "auto-sm.com" },
        ],
        since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      };

      const uids = [];
      for await (const msg of client.fetch(query, { envelope: true, uid: true })) {
        const rawSubject = msg.envelope?.subject || "";
        const subject = decodeMimeWord(rawSubject);
        if (subject.toLowerCase().includes("order confirmation")) {
          uids.push({ uid: msg.uid, subject });
        }
      }

      const results = [];
      for (const { uid, subject } of uids) {
        try {
          const msg = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
          const raw = msg.source;
          const parsed = parseRawMessage(raw);
          const fromAddr = msg.envelope?.from?.[0]?.address || "";
          const replyToAddr = msg.envelope?.replyTo?.[0]?.address || "";

          results.push({
            uid,
            subject,
            bodyText: parsed.bodyText,
            htmlText: parsed.htmlText,
            from: fromAddr,
            replyTo: replyToAddr,
          });
        } catch (e) {
          console.error(`Failed to fetch message ${uid}:`, e.message);
        }
      }

      await callback(results);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

export async function sendDeliveryEmail(buyerEmail, bannerPath, torrentPath, torrentFilename) {
  const transporter = nodemailer.createTransport(getSmtpConfig());

  const html = buildDeliveryHtml();
  const text = buildDeliveryText();

  const info = await transporter.sendMail({
    from: `"Creatoristico" <${process.env.GMAIL_ADDRESS}>`,
    to: buyerEmail,
    subject: DELIVERY_SUBJECT,
    text,
    html,
    attachments: [
      {
        filename: "email_banner.gif",
        path: bannerPath,
        cid: "thankyou-banner",
        contentDisposition: "inline",
      },
      {
        filename: torrentFilename,
        path: torrentPath,
        contentDisposition: "attachment",
      },
    ],
  });

  return info.messageId || "";
}

export async function sendOwnerSummary(ownerEmail, summaryText) {
  const transporter = nodemailer.createTransport(getSmtpConfig());
  const info = await transporter.sendMail({
    from: `"Sims4 Order Mailer" <${process.env.GMAIL_ADDRESS}>`,
    to: ownerEmail,
    subject: "Sims4 Order Mailer - Daily summary",
    text: summaryText,
  });
  return info.messageId || "";
}

// Find a send-to-self email whose subject contains `marker` and return the
// first .torrent attachment as a Buffer. Used so the cloud worker can obtain
// the (large) torrent file from Gmail itself instead of shipping it in the
// repo. Returns null if not found.
export async function fetchTorrentFromGmail(marker) {
  const client = new ImapFlow(getImapConfig());
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const matches = [];
      const seen = new Set();
      for await (const msg of client.fetch({ seen }, { envelope: true, bodyStructure: true, uid: true })) {
        const subject = decodeMimeWord(msg.envelope?.subject || "");
        if (subject.toLowerCase().includes(marker.toLowerCase())) {
          matches.push(msg);
          if (matches.length >= 5) break;
        }
      }
      for (const msg of matches) {
        const part = findTorrentPart(msg.bodyStructure);
        if (!part) continue;
        try {
          const fetched = await client.fetchOne(msg.uid, { bodyParts: [part.path] }, { uid: true });
          const buf = fetched.bodyParts?.[part.pathKey];
          if (buf && buf.length > 0) return buf;
        } catch (e) {
          console.error("Failed to fetch torrent attachment part:", e.message);
        }
      }
      return null;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

// Recursively find a .torrent attachment part and return an imapflow body
// part path (e.g. { path: ['1','2'], pathKey: '1.2' }).
function findTorrentPart(node, trail = []) {
  if (!node) return null;
  const isMultipart = String(node.type || "").toLowerCase() === "multipart";
  if (isMultipart) {
    if (!node.parts || !node.parts.length) return null;
    for (let i = 0; i < node.parts.length; i++) {
      const r = findTorrentPart(node.parts[i], [...trail, String(i + 1)]);
      if (r) return r;
    }
    return null;
  }
  const type = String(node.contentType || "").toLowerCase();
  const name = String(node.parameters?.name || node.disposition?.parameters?.filename || "").toLowerCase();
  if (type.includes("bittorrent") || name.endsWith(".torrent")) {
    return { path: trail, pathKey: trail.join(".") };
  }
  return null;
}
