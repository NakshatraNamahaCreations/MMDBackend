// Shorten over-long blog meta to SEO lengths WITHOUT cutting mid-word:
// meta title -> <= 60 chars, meta description -> <= 155 chars. Trims at the last
// word boundary and strips any dangling punctuation. Only touches blogs that
// are actually too long.
require("dotenv").config();
const mongoose = require("mongoose");

const trimTo = (str, max) => {
  str = String(str || "").trim();
  if (str.length <= max) return str;
  let cut = str.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > max * 0.55) cut = cut.slice(0, lastSpace);
  return cut.replace(/[\s.,;:\-–—|]+$/, "").trim();
};

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const B = mongoose.connection.collection("blogs");
  const all = await B.find({}).project({ title: 1, metaTitle: 1, metaDescription: 1 }).toArray();

  let tFixed = 0, dFixed = 0;
  for (const b of all) {
    const set = {};
    if ((b.metaTitle || "").length > 60) { set.metaTitle = trimTo(b.metaTitle, 60); tFixed++; }
    if ((b.metaDescription || "").length > 155) { set.metaDescription = trimTo(b.metaDescription, 155); dFixed++; }
    if (Object.keys(set).length) {
      await B.updateOne({ _id: b._id }, { $set: set });
      if (set.metaTitle) console.log(`title(${set.metaTitle.length}): ${set.metaTitle}`);
    }
  }
  console.log(`\nDone. Titles shortened: ${tFixed}, Descriptions shortened: ${dFixed}`);
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
