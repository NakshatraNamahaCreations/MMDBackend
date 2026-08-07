// Generate designed SVG banner images for the N most recent blogs (gradient +
// category pill + wrapped title + branding footer) and store them on each
// blog's `image` field as a data URI. No photos / external assets needed.
//   node scripts/make-blog-banners.cjs            # last 3 blogs (default)
//   node scripts/make-blog-banners.cjs 5          # last 5 blogs
require("dotenv").config();
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");

const N = Number(process.argv[2]) || 3;

// The white Make My Documents logo (shows cleanly on the dark banner — no badge
// needed). Embedded so the banner is fully self-contained.
const LOGO =
  "data:image/png;base64," +
  fs.readFileSync(path.join(__dirname, "assets", "logo-white.png")).toString("base64");

// Category -> 3-stop gradient (mirrors the site's category colours).
const GRAD = {
  "Passport":                     ["#0f2d5c", "#2E68B1", "#3d8bd4"],
  "Tourist Visa":                 ["#7c1d05", "#c2410c", "#f97316"],
  "PAN Card":                     ["#3b0764", "#7c3aed", "#a78bfa"],
  "Senior Citizen Card":          ["#064e3b", "#059669", "#34d399"],
  "Insurance":                    ["#0c4a6e", "#0369a1", "#0ea5e9"],
  "Rental Agreement":             ["#431407", "#9a3412", "#ea580c"],
  "Lease Agreement":              ["#4a044e", "#86198f", "#e879f9"],
  "Police Verification":          ["#052e16", "#166534", "#22c55e"],
  "MSME Certificate":             ["#1a1a4e", "#3730a3", "#6366f1"],
  "Police Clearance Certificate": ["#0f172a", "#1e3a5f", "#2563eb"],
  "Affidavits / Annexure":        ["#334155", "#475569", "#94a3b8"],
};
const DEFAULT_GRAD = ["#0f172a", "#334155", "#64748b"];

const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Greedy word-wrap into at most `maxLines` lines of ~maxChars chars.
const wrap = (title, maxChars = 26, maxLines = 4) => {
  const words = String(title || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (test.length > maxChars && line) { lines.push(line); line = w; }
    else line = test;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = lines[maxLines - 1].replace(/[\s.,;:-]+$/, "") + "…";
  }
  return lines;
};

const banner = (title, category) => {
  const [c1, c2, c3] = GRAD[category] || DEFAULT_GRAD;
  const lines = wrap(title, 26, 4);
  const lineH = 76;
  const blockH = lines.length * lineH;
  // Centre the title block below the top badges (category tag top-left, logo
  // top-right) and above the footer.
  const startY = 330 - blockH / 2 + 52;

  const titleTspans = lines
    .map((ln, i) => `<tspan x="80" dy="${i === 0 ? 0 : lineH}">${esc(ln)}</tspan>`)
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${c1}"/>
      <stop offset="0.55" stop-color="${c2}"/>
      <stop offset="1" stop-color="${c3}"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#g)"/>
  <circle cx="1060" cy="140" r="240" fill="#ffffff" opacity="0.05"/>
  <circle cx="140" cy="560" r="200" fill="#ffffff" opacity="0.05"/>
  <circle cx="1120" cy="470" r="120" fill="#ffffff" opacity="0.05"/>
  <!-- White logo, top-right (opposite the card's category tag on the left) -->
  <image href="${LOGO}" xlink:href="${LOGO}" x="936" y="60" width="212" height="76" preserveAspectRatio="xMidYMid meet"/>
  <text y="${startY}" font-family="Arial, Helvetica, sans-serif" font-size="60" font-weight="800" fill="#ffffff">${titleTspans}</text>
  <rect x="0" y="556" width="1200" height="74" fill="#000000" opacity="0.22"/>
  <text x="80" y="601" font-family="Arial, Helvetica, sans-serif" font-size="23" font-weight="500" fill="#ffffff" opacity="0.85">Click it, Get it.</text>
  <text x="1124" y="601" font-family="Arial, Helvetica, sans-serif" font-size="24" font-weight="600" fill="#ffffff" opacity="0.9" text-anchor="end">makemydocuments.com</text>
</svg>`;
};

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const B = mongoose.connection.collection("blogs");
  const blogs = await B.find({}).project({ title: 1, category: 1 }).sort({ createdAt: -1 }).limit(N).toArray();

  for (const b of blogs) {
    const svg = banner(b.title, b.category);
    const dataUri = "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");
    await B.updateOne({ _id: b._id }, { $set: { image: dataUri } });
    console.log(`banner set (${b.category}): ${b.title.slice(0, 55)}`);
  }
  console.log(`\nDone. ${blogs.length} banner(s) generated.`);
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
