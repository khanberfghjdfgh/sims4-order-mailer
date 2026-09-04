const SIMS_RE = /sims\s*[46]/i;
const ORDER_CONFIRM_PHRASE = "order confirmation";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ETSY_SYSTEM_ADDRS = /@(etsy\.com|mail\.etsy\.com|sendgrid\.info|mailgun|mailgun\.org)$/i;

export function isOrderConfirmation(text) {
  return (text || "").toLowerCase().includes(ORDER_CONFIRM_PHRASE);
}

export function isSimsText(text) {
  return SIMS_RE.test(text || "");
}

export function extractOrderAmount(subject) {
  const m = (subject || "").match(/(?:for|amount)\s*:\s*([A-Za-z]{3}\s*[\d,.]+)/i);
  return m ? m[1] : "";
}

function isRealEmail(cand) {
  return !!cand && EMAIL_RE.test(cand) && !ETSY_SYSTEM_ADDRS.test(cand);
}

export function extractBuyerEmail(subject, bodyText, htmlText, replyTo, fromRaw) {
  const s = subject || "";

  const m = s.match(/\bfrom\s*:\s*([^\s(]+)/i);
  if (m) {
    const cand = m[1].replace(/[.,;<>]+$/, "").trim();
    if (isRealEmail(cand)) return { email: cand, method: "subject" };
  }

  const body = bodyText || "";
  const line = body.match(/(?:^|\n)\s*\*\s*Email\s*[: ]?\s*([\w.+-]+@[\w-]+\.[\w.]+)/i)
    || body.match(/(?:^|\n)\s*Email\s*[: ]?\s*([\w.+-]+@[\w-]+\.[\w.]+)/i);
  if (line && isRealEmail(line[1])) return { email: line[1], method: "body-email-line" };

  const html = htmlText || "";
  const mailtos = html.match(/mailto:([\w.+-]+@[\w-]+\.[\w.]+)/gi) || [];
  for (const mm of mailtos) {
    const cand = mm.replace(/^mailto:/i, "").replace(/[.,;<>()]+$/g, "");
    if (isRealEmail(cand)) return { email: cand, method: "html-mailto" };
  }

  const hay = body + " " + (replyTo || "") + " " + (fromRaw || "");
  const found = hay.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) || [];
  for (const cand of found) {
    const clean = cand.replace(/[.,;<>()]+$/g, "");
    if (isRealEmail(clean)) return { email: clean, method: "body-generic" };
  }

  return { email: "", method: "" };
}

export const DELIVERY_SUBJECT = "Thank you for your order! Etsy order notice!";

const BODY_PARAGRAPHS = [
  "Thank you so much for your purchase! I really appreciate your support.",
  "Your order has been delivered in this email. Please also make sure to download and check the PDF provided on Etsy with your purchase, as it contains important instructions and details you'll need.",
  "If you have any questions or need further assistance, feel free to reach out anytime!",
  "Best regards,",
  "Creatoristico",
];

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function buildDeliveryHtml() {
  const cid = "thankyou-banner";
  const paraStyle = "margin:0 0 16px 0;font-family:'Segoe UI',Arial,sans-serif;font-size:17px;color:#25415E;line-height:30px;";
  const paras = BODY_PARAGRAPHS.map((p) => {
    if (p === "Best regards,") return `<p style="${paraStyle}margin-top:28px;">${escapeHtml(p)}</p>`;
    if (p === "Creatoristico") return `<p style="margin:0;font-family:'Segoe UI',Arial,sans-serif;font-size:20px;color:#1E9E46;line-height:30px;font-weight:bold;letter-spacing:.3px;">${escapeHtml(p)}</p>`;
    return `<p style="${paraStyle}">${escapeHtml(p)}</p>`;
  }).join("\n");

  return [
    '<!DOCTYPE html><html><head><meta charset="utf-8"></head>',
    '<body style="margin:0;padding:0;background-color:#EAF7FB;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#EAF7FB;padding:18px 10px;"><tr><td align="center">',
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background-color:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 4px 14px rgba(30,158,70,.15);">',
    '<tr><td style="background-color:#C9EEF6;">',
    `<img src="cid:${cid}" width="600" alt="Thank you for your purchase!" style="display:block;width:600px;border:0;">`,
    '</td></tr>',
    '<tr><td style="padding:34px 38px;background-color:#ffffff;">',
    paras,
    '</td></tr>',
    '<tr><td align="center" style="background-color:#F0F7F2;padding:16px 20px;border-top:1px solid #DCEDE2;">',
    '<div style="font-size:12px;color:#8AA09A;font-family:\'Segoe UI\',Arial,sans-serif;">Digital product delivered by email &bull; Creatoristico</div>',
    '</td></tr></table></td></tr></table></body></html>',
  ].join("\n");
}

export function buildDeliveryText() {
  return BODY_PARAGRAPHS.join("\n");
}
