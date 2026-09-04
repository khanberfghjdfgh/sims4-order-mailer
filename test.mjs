import {
  isOrderConfirmation,
  isSimsText,
  extractBuyerEmail,
  extractOrderAmount,
  buildDeliveryHtml,
  DELIVERY_SUBJECT,
} from "./src/order.js";

let failures = 0;
function check(name, got, want) {
  const ok = got === want;
  if (!ok) failures++;
  console.log((ok ? "PASS" : "FAIL") + "  " + name + (ok ? "" : `  (got=${JSON.stringify(got)} want=${JSON.stringify(want)})`));
}

const subject = "Etsy Order confirmation for: MAD 149.99 from: shamariyajenkins6@gmail.com (4158951196)";
check("extract buyer email from subject", extractBuyerEmail(subject, "", "", "", "").email, "shamariyajenkins6@gmail.com");
check("extract order amount", extractOrderAmount(subject), "MAD 149.99");
check("order confirmation true", isOrderConfirmation(subject), true);
check("sims text false in subject only", isSimsText(subject), false);

check("username-only subject -> empty", extractBuyerEmail("Etsy Order confirmation for: MAD 179.99 from: vpncwq4y (4159324214)", "", "", "noreply@mail.etsy.com", "Etsy Transactions <transaction@etsy.com>").email, "");
check("catches body *Email line", extractBuyerEmail("from: vpncwq4y (123)", "\nContacting the Buyer\n* Email lvowden@googlemail.com\n", "", "", "").email, "lvowden@googlemail.com");
check("catches html mailto link", extractBuyerEmail("from: vpncwq4y (123)", "no email in body here", '<a href="mailto:lucy@example.com">Send them an email</a>', "", "").email, "lucy@example.com");
check("no email anywhere -> empty", extractBuyerEmail("from: user123 (1)", "no emails here", "<b>no emails here</b>", "", "").email, "");

check("sims4 in text", isSimsText("The Sims 4 base game"), true);
check("sims4 no space", isSimsText("sims4 all dlc"), true);
check("sims6", isSimsText("sims 6 game"), true);
check("non-sims not flagged", isSimsText("sim cards"), false);

check("DELIVERY_SUBJECT", DELIVERY_SUBJECT, "Thank you for your order! Etsy order notice!");

const html = buildDeliveryHtml();
check("html contains thank-you", html.includes("Thank you so much for your purchase!"), true);
check("html contains Creatoristico", html.includes("Creatoristico"), true);
check("html contains banner cid", html.includes("cid:thankyou-banner"), true);

console.log(failures ? "\n" + failures + " FAILURE(S)" : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
