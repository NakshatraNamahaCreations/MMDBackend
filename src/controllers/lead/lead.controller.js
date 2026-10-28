const Lead = require("../../models/lead/Lead");

const generateOrderId = () =>
  "MMD" + Date.now() + Math.floor(Math.random() * 9000 + 1000);

// All date/time strings are stored in IST so they match what the user actually
// entered the form at — Render servers run UTC, which is ~5h30m behind India.
const istDate = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const istTime = () =>
  new Date().toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });

// The three follow-up buckets are derived from followUpDate, not stored as a
// fixed value: a lead scheduled for the future sits in "followup", rolls into
// "today" on the day, and into "overdue" once the date passes. We keep the
// stored status as the admin set it and recompute the display bucket on read.
const SCHEDULED_STATUSES = ["followup", "today", "overdue"];

// "Today" for follow-up bucketing must be India time — the Render server runs
// UTC (~5.5h behind IST), which otherwise pushes a follow-up dated for today
// into the wrong bucket near midnight. Follow-up dates are entered/stored in
// IST, so compare against the IST date.
const localToday = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

// followUpDate may be a real Date (migrated/legacy rows) OR a "YYYY-MM-DD"
// string. Normalize both to an IST calendar date so bucketing is consistent.
const toYMD = (v) => {
  if (!v) return "";
  if (v instanceof Date)
    return v.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  return String(v).slice(0, 10);
};

const effectiveStatus = (status, followUpDate) => {
  if (!followUpDate || !SCHEDULED_STATUSES.includes(status)) return status;
  const fu = toYMD(followUpDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fu)) return status;
  const today = localToday();
  if (fu < today) return "overdue";
  if (fu === today) return "today";
  return "followup";
};

const serializeLead = (doc) => {
  const o = doc && typeof doc.toJSON === "function" ? doc.toJSON() : doc;
  if (o) o.status = effectiveStatus(o.status, o.followUpDate);
  return o;
};

const User = require("../../models/user/User");

const norm = (s) => String(s || "").trim().toLowerCase();
const listHas = (list, value) => {
  const v = norm(value);
  if (!v) return false;
  return (list || []).some((x) => {
    const n = norm(x);
    return n && (n === v || v.includes(n) || n.includes(v));
  });
};

// Config-based auto-assign: find the active team member whose Team-Settings
// services cover this lead's service AND whose states cover its state. A member
// with NO states set handles that service for ALL states. Prefer an exact
// service+state match over a service-only (all-states) match. Returns "" if no
// member is configured for it (the lead is then left Unassigned).
const findAssigneeByConfig = async (service, state) => {
  if (!norm(service)) return "";
  const users = await User.find({ status: "active" })
    .select("name services states")
    .lean();
  let serviceOnly = "";
  for (const u of users) {
    if (!u.services || !u.services.length) continue;
    if (!listHas(u.services, service)) continue;
    const hasStates = u.states && u.states.length;
    if (hasStates && listHas(u.states, state)) return u.name; // best match
    if (!hasStates && !serviceOnly) serviceOnly = u.name;       // all-states
  }
  return serviceOnly;
};

// website submits leads, admin can also add them manually
exports.createLead = async (req, res) => {
  try {
    const b = req.body || {};

    const name = String(b.name || "").trim();
    const mobileNumber = String(b.mobileNumber || b.mobile || "").trim();
    const service = String(b.service || "").trim();

    if (!name) {
      return res
        .status(400)
        .json({ success: false, message: "Name is required" });
    }
    if (!mobileNumber) {
      return res
        .status(400)
        .json({ success: false, message: "Mobile number is required" });
    }
    if (!service) {
      return res
        .status(400)
        .json({ success: false, message: "Service is required" });
    }

    const orderId = b.orderId || generateOrderId();

    // Honour an explicit assignee; otherwise auto-assign ONLY by the per-user
    // service+state config set in Team Settings. If nobody is configured for
    // this lead's service/state, it stays Unassigned (no hardcoded fallback).
    const givenAssignee =
      b.assignedTo && b.assignedTo !== "Unassigned" ? b.assignedTo : "";
    let assignedTo = givenAssignee;
    if (!assignedTo) {
      assignedTo = await findAssigneeByConfig(service, b.state || b.addrState || "");
    }

    const fields = {
      orderId,
      date: b.date || istDate(),
      time: b.time || istTime(),
      name,
      mobileNumber,
      email: b.email || "",
      address: b.address || "",
      district: b.district || "",
      state: b.state || b.addrState || "",
      pinCode: b.pinCode || "",
      service,
      amount: Number(b.amount) || 0,
      // NEVER trust the client for payment status. A lead is always created
      // unpaid; only the checksum-verified Paytm callback (which records the
      // transaction id + paidAt) may flip it to "paid". This stops leads from
      // showing "paid" without a real transaction.
      paymentStatus: "unpaid",
      status: b.status || "new",
      assignedTo,
      source: b.source || "Website",
      leadType: b.leadType || "website",
      followUpDate: b.followUpDate,
      applyingFor: b.applyingFor,
      gender: b.gender,
      dateOfBirth: b.dateOfBirth || b.dob,
      placeOfBirth: b.placeOfBirth,
      educationQualification: b.educationQualification || b.education,
      employmentType: b.employmentType || b.employment,
      nearbyPoliceStation: b.nearbyPoliceStation || b.policeStation,
      formData:
        b.formData && typeof b.formData === "object" ? b.formData : {},
    };

    // Idempotent on orderId: the website creates the lead (unpaid) right after
    // OTP verification, then the Paytm callback flips it to paid. If the submit
    // fires twice (double-tap "verify OTP", a retry, an effect re-run) we must
    // NOT insert a second lead for the same order — otherwise the callback marks
    // only one paid and the customer ends up with a paid + an unpaid duplicate.
    // Reuse the existing lead instead, but never downgrade an already-paid lead.
    let lead = b.orderId ? await Lead.findOne({ orderId: b.orderId }) : null;
    if (lead) {
      const wasPaid = lead.paymentStatus === "paid" || lead.refundStatus;
      const prevAssigned = lead.assignedTo;
      Object.assign(lead, fields);
      if (wasPaid) lead.paymentStatus = "paid";
      // A re-submit must not wipe/override an assignment the lead already has
      // (auto-assigned on first create, or set by an admin). Keep it unless the
      // caller explicitly passed a new assignee.
      if (!givenAssignee && prevAssigned) lead.assignedTo = prevAssigned;
      await lead.save();
    } else {
      fields.slNo = (await Lead.countDocuments()) + 1;
      lead = await Lead.create(fields);
    }

    // Add/refresh the lead in the cache so it appears on the next fetch.
    upsertLeadCache(lead);

    return res
      .status(201)
      .json({ success: true, message: "Lead created", data: serializeLead(lead) });
  } catch (err) {
    console.error("createLead error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// admin panel list — supports ?status= and ?search=
// Returns EVERY matching lead but LEAN and with only the fields the list /
// table / search / dashboard actually use. Excluding the heavy `formData`
// blob (and using .lean(), which skips Mongoose hydration) is what keeps an
// 18k-lead response small (~8MB) and fast enough to serve — the previous
// "return full documents" version produced ~52MB and 500/502'd the host,
// blanking the panel. The detail view fetches the full lead (incl. formData)
// separately via getLeadById.
const LEAD_LIST_FIELDS =
  "slNo name mobileNumber email service status assignedTo amount paymentStatus " +
  "refundStatus refundAmount district state date time createdAt updatedAt followUpDate orderId leadType source " +
  // older "Tourist Visa" leads keep the visa country here (panel's country filter)
  "applyingFor";

// Run the lean list query and normalize each row (id + derived status bucket).
const buildLeadList = async (query = {}) => {
  const data = await Lead.find(query)
    .select(LEAD_LIST_FIELDS)
    .sort({ createdAt: -1 })
    .lean(); // plain objects — far cheaper than hydrating 18k documents
  return data.map((o) => {
    o.id = String(o._id);
    delete o._id;
    o.status = effectiveStatus(o.status, o.followUpDate);
    return o;
  });
};

// Convert a single Lead doc to the lean list-row shape used in the cache, so a
// create/update can patch the cache directly instead of waiting for the 25s
// background rebuild (which is why a status change "needed many refreshes").
const LEAD_LIST_KEYS = LEAD_LIST_FIELDS.split(/\s+/);
const toLeadListRow = (doc) => {
  const o = typeof doc.toObject === "function" ? doc.toObject() : doc;
  const row = { id: String(o._id) };
  for (const k of LEAD_LIST_KEYS) row[k] = o[k];
  row.status = effectiveStatus(o.status, o.followUpDate);
  return row;
};

// Patch (or insert) one lead in the cached list.
const upsertLeadCache = (doc) => {
  if (!leadListCache.data) return;
  const row = toLeadListRow(doc);
  const idx = leadListCache.data.findIndex((l) => l.id === row.id);
  if (idx !== -1) leadListCache.data[idx] = row;
  else leadListCache.data.unshift(row);
  leadListCache.body = null;
};
// Exported so other controllers (e.g. the Paytm callback/refund) can keep the
// cached list in sync — otherwise a payment marks the lead paid in the DB but
// the panel keeps showing it unpaid until the cache rebuilds.
exports.upsertLeadCache = upsertLeadCache;

// In-memory cache of the FULL (unfiltered) lead list, refreshed in the
// background. The admin panel loads the whole list on startup; querying ~18k
// leads from the (cloud) DB takes several seconds, so without this every page
// load waited on that. With the cache, the panel is served instantly and the
// expensive query runs at most once per interval — no matter how many admins
// are open. Up to ~25s staleness, which is fine for a CRM (and the panel does
// optimistic updates for the user's own actions anyway).
// `body` is the ready-to-send JSON string of the full list (~13MB for 27k
// leads). Stringifying that on every request cost ~1-2s, so it's built once and
// reused until a write changes the list (body = null) or the IST day rolls over
// (follow-up buckets depend on today's date).
let leadListCache = { data: null, builtAt: 0, body: null, bodyDay: "" };
// The cold build pulls every lead from the DB, which can take minutes on a slow
// link. Share one in-flight build so concurrent/retried requests don't each
// start another full download.
let cacheBuild = null;
const refreshLeadCache = () => {
  if (!cacheBuild) {
    cacheBuild = (async () => {
      try {
        leadListCache = { data: await buildLeadList({}), builtAt: Date.now(), body: null, bodyDay: "" };
      } catch (err) {
        console.error("lead cache refresh failed:", err.message);
      } finally {
        cacheBuild = null;
      }
    })();
  }
  return cacheBuild;
};

// Closed leads (~99% of the collection). The panel's first load skips them so
// the working lists (new/follow-up/in-process) appear in a second.
const CLOSED_STATUSES = ["dead", "converted"];
// NOTE: no background setInterval refresh. A periodic rebuild could finish a DB
// query that started BEFORE a delete/update and overwrite the cache with stale
// data — which made deletes/status-changes "sometimes" revert. Every write goes
// through create/update/delete here and patches the cache directly, so it stays
// correct without a background rebuild. (After a direct DB change such as a
// migration/sync script, restart the backend to rebuild the cache.)

exports.listLeads = async (req, res) => {
  try {
    const { status, search, assignedTo, since, active } = req.query;

    // ?since=<ISO date> → only leads created/updated after that moment. The
    // admin panel uses this to pick up new/changed leads without re-downloading
    // the whole list. Indexed on updatedAt, so it's a tiny query.
    if (since) {
      const sinceDate = new Date(String(since));
      if (Number.isNaN(sinceDate.getTime()))
        return res.status(400).json({ success: false, message: "Invalid since" });
      const out = await buildLeadList({ updatedAt: { $gte: sinceDate } });
      return res.json({ success: true, count: out.length, data: out });
    }

    // ?active=1 → only open leads (not dead/converted). Served from the cache
    // when it's warm, otherwise a small direct query (~250 rows).
    if (active) {
      const out = leadListCache.data
        ? leadListCache.data
            .filter((r) => !CLOSED_STATUSES.includes(r.status))
            .map((r) => ({ ...r, status: effectiveStatus(r.status, r.followUpDate) }))
        : await buildLeadList({ status: { $nin: CLOSED_STATUSES } });
      return res.json({ success: true, count: out.length, data: out });
    }

    // No filters → the panel's main load. Serve the cached full list instantly
    // (building it once if the cache is still cold).
    if (!status && !search && !assignedTo) {
      if (!leadListCache.data) await refreshLeadCache();
      const today = localToday();
      if (!leadListCache.body || leadListCache.bodyDay !== today) {
        // Re-derive the follow-up bucket (overdue/today/followup) using TODAY's
        // IST date. The cached row's stored bucket is frozen at the time it was
        // written, so without this a lead scheduled for "tomorrow" would stay
        // in Follow-up forever instead of rolling into Today/Overdue.
        const data = (leadListCache.data || []).map((r) => {
          const eff = effectiveStatus(r.status, r.followUpDate);
          return eff === r.status ? r : { ...r, status: eff };
        });
        leadListCache.body = JSON.stringify({ success: true, count: data.length, data });
        leadListCache.bodyDay = today;
      }
      return res.type("application/json").send(leadListCache.body);
    }

    // Filtered queries are smaller and run directly (not cached).
    const query = {};
    if (status) query.status = status;
    if (assignedTo) query.assignedTo = assignedTo;
    if (search) {
      const rx = new RegExp(
        String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i"
      );
      query.$or = [{ name: rx }, { mobileNumber: rx }, { orderId: rx }, { email: rx }, { service: rx }];
    }

    // ?limit=N caps the result (the panel's header search shows the top few).
    const limit = Number(req.query.limit) || 0;
    const out = limit
      ? (await Lead.find(query).select(LEAD_LIST_FIELDS).sort({ createdAt: -1 }).limit(Math.min(limit, 100)).lean())
          .map((o) => {
            o.id = String(o._id);
            delete o._id;
            o.status = effectiveStatus(o.status, o.followUpDate);
            return o;
          })
      : await buildLeadList(query);
    return res.json({ success: true, count: out.length, data: out });
  } catch (err) {
    console.error("listLeads error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// Server-side paging for the big closed tabs (converted/dead, ~27k leads) so
// the panel fetches one page at a time instead of the whole list. Mirrors the
// LeadTable filters: search (name/mobile/district/service), payment, service
// (incl. Tourist Visa + country), assignee, and column sort.
// ?all=1 returns every match (CSV export).
const escapeRx = (s) => String(s).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Same aliases as the panel's visaCountryOf().
const VISA_COUNTRY_ALIASES = {
  Dubai: ["united arab emirates", "united arab emirated", "uae"],
  UK: ["united kingdom"],
};
const PAGE_SORT_KEYS = ["slNo", "date", "name", "mobileNumber", "district", "service", "amount", "createdAt"];

exports.listLeadsPage = async (req, res) => {
  try {
    const q = req.query;
    const status = String(q.status || "");
    if (!CLOSED_STATUSES.includes(status)) {
      // Open statuses are bucketed by follow-up date in JS, so they can't be
      // filtered by the stored value — the panel loads those client-side.
      return res.status(400).json({ success: false, message: "status must be converted or dead" });
    }

    const and = [{ status }];
    if (q.assignedTo) and.push({ assignedTo: String(q.assignedTo) });
    if (q.payment) and.push({ paymentStatus: String(q.payment) });
    if (q.search && String(q.search).trim()) {
      const rx = new RegExp(escapeRx(q.search), "i");
      and.push({ $or: [{ name: rx }, { mobileNumber: rx }, { district: rx }, { service: rx }] });
    }
    if (q.service === "Tourist Visa") {
      and.push({ service: /tourist visa\s*$/i });
      if (q.country) {
        const names = [String(q.country), ...(VISA_COUNTRY_ALIASES[q.country] || [])].map(escapeRx);
        const country = names.join("|");
        and.push({
          $or: [
            { service: new RegExp(`^\\s*(${country})\\s*tourist visa\\s*$`, "i") },
            {
              service: /^\s*tourist visa\s*$/i,
              applyingFor: new RegExp(`^\\s*(${country})\\s*$`, "i"),
            },
          ],
        });
      }
    } else if (q.service) {
      and.push({ service: String(q.service) });
    }
    const query = { $and: and };

    const sortKey = PAGE_SORT_KEYS.includes(q.sort) ? q.sort : "createdAt";
    const dir = q.dir === "asc" ? 1 : -1;
    const all = q.all === "1";
    const limit = Math.min(Math.max(Number(q.limit) || 10, 1), 100);
    const page = Math.max(Number(q.page) || 1, 1);

    let find = Lead.find(query)
      .select(LEAD_LIST_FIELDS)
      .sort({ [sortKey]: dir, _id: dir })
      .allowDiskUse(true);
    if (!all) find = find.skip((page - 1) * limit).limit(limit);

    const [rows, total, assignees] = await Promise.all([
      find.lean(),
      Lead.countDocuments(query),
      Lead.distinct("assignedTo", { status }),
    ]);
    const data = rows.map((o) => {
      o.id = String(o._id);
      delete o._id;
      return o;
    });
    return res.json({
      success: true,
      total,
      page,
      limit,
      data,
      assignees: assignees.filter(Boolean).sort(),
    });
  } catch (err) {
    console.error("listLeadsPage error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// Dashboard charts, computed in the DB so the panel never downloads every lead.
// Days are IST calendar days (the panel's users are in India).
const IST = "Asia/Kolkata";
const istDayStart = (ymd) => new Date(`${ymd}T00:00:00+05:30`);
const istDayEnd = (ymd) => new Date(`${ymd}T23:59:59.999+05:30`);
const YMD_RX = /^\d{4}-\d{2}-\d{2}$/;

// Leads created per IST day: [{ d: "YYYY-MM-DD", n }]. The panel buckets these
// into the daily/monthly bars for whichever range is selected.
exports.getDailyCounts = async (req, res) => {
  try {
    const match = { createdAt: { $type: "date" } };
    if (req.query.assignedTo) match.assignedTo = String(req.query.assignedTo);
    const rows = await Lead.aggregate([
      { $match: match },
      { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: IST } }, n: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    return res.json({ success: true, data: rows.map((r) => ({ d: r._id, n: r.n })) });
  } catch (err) {
    console.error("getDailyCounts error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// Leads and conversions per service, optionally within ?from=&to= (YYYY-MM-DD).
exports.getServiceStats = async (req, res) => {
  try {
    const { from, to, assignedTo } = req.query;
    const match = {};
    if (assignedTo) match.assignedTo = String(assignedTo);
    if ((from && YMD_RX.test(from)) || (to && YMD_RX.test(to))) {
      match.createdAt = {};
      if (from && YMD_RX.test(from)) match.createdAt.$gte = istDayStart(from);
      if (to && YMD_RX.test(to)) match.createdAt.$lte = istDayEnd(to);
    }
    const rows = await Lead.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$service",
          count: { $sum: 1 },
          converted: { $sum: { $cond: [{ $eq: ["$status", "converted"] }, 1, 0] } },
        },
      },
    ]);
    return res.json({
      success: true,
      data: rows.map((r) => ({ name: r._id, count: r.count, converted: r.converted })),
    });
  } catch (err) {
    console.error("getServiceStats error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.getLeadById = async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id);
    if (!lead) {
      return res
        .status(404)
        .json({ success: false, message: "Lead not found" });
    }
    return res.json({ success: true, data: serializeLead(lead) });
  } catch (err) {
    console.error("getLeadById error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// admin updates workflow fields (status, assignee, payment, amount, follow-up)
exports.updateLead = async (req, res) => {
  try {
    const allowed = [
      "status",
      "assignedTo",
      "paymentStatus",
      "amount",
      "followUpDate",
      "service",
      "name",
      "mobileNumber",
      "email",
      "address",
      "district",
      "state",
      "pinCode",
      "source",
      // applicant fields the admin's per-service form can edit
      "applyingFor",
      "gender",
      "dateOfBirth",
      "placeOfBirth",
      "educationQualification",
      "employmentType",
      "nearbyPoliceStation",
      // the admin view edits the per-service form fields and the activity feed,
      // which it sends back as the full formData object / notes array
      "formData",
      "notes",
      "date",
      "time",
    ];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    const lead = await Lead.findByIdAndUpdate(req.params.id, updates, {
      new: true,
      runValidators: true,
    });
    if (!lead) {
      return res
        .status(404)
        .json({ success: false, message: "Lead not found" });
    }
    // Patch the cache so the new status/assignee/etc. shows on the next fetch
    // (and survives a page refresh) instead of waiting for the 25s rebuild.
    upsertLeadCache(lead);
    return res.json({ success: true, message: "Lead updated", data: serializeLead(lead) });
  } catch (err) {
    console.error("updateLead error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.addNote = async (req, res) => {
  try {
    const text = String(req.body.text || "").trim();
    if (!text) {
      return res
        .status(400)
        .json({ success: false, message: "Note text is required" });
    }

    const lead = await Lead.findByIdAndUpdate(
      req.params.id,
      { $push: { notes: { text, author: req.body.author || "Admin" } } },
      { new: true }
    );
    if (!lead) {
      return res
        .status(404)
        .json({ success: false, message: "Lead not found" });
    }
    return res.json({ success: true, message: "Note added", data: serializeLead(lead) });
  } catch (err) {
    console.error("addNote error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.deleteLead = async (req, res) => {
  try {
    const lead = await Lead.findByIdAndDelete(req.params.id);
    if (!lead) {
      return res
        .status(404)
        .json({ success: false, message: "Lead not found" });
    }
    // Keep the in-memory cache in sync immediately, otherwise the next list
    // fetch returns the cached (still-present) lead and it "reappears" until
    // the 25s background refresh — which is why deletes seemed to need many
    // refreshes to stick.
    if (leadListCache.data) {
      const id = String(req.params.id);
      leadListCache.data = leadListCache.data.filter((l) => l.id !== id);
      leadListCache.body = null;
    }
    return res.json({ success: true, message: "Lead deleted" });
  } catch (err) {
    console.error("deleteLead error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// dashboard counts — uses the derived follow-up buckets so the totals match
// what the admin sees in each list. Computed server-side (aggregation + a
// couple of targeted counts) instead of loading every lead, so it stays cheap
// even at 18k+ and is safe to poll frequently.
exports.getStats = async (req, res) => {
  try {
    // Optional ?assignedTo= scopes the counts to one employee (so an employee's
    // dashboard shows THEIR numbers); omitted = whole pipeline (admin).
    const match = {};
    if (req.query.assignedTo) match.assignedTo = String(req.query.assignedTo);

    // counts per STORED status (server-side group, no documents transferred)
    const grouped = await Lead.aggregate([
      { $match: match },
      { $group: { _id: "$status", n: { $sum: 1 } } },
    ]);
    const byStored = {};
    let total = 0;
    for (const g of grouped) {
      byStored[g._id || ""] = g.n;
      total += g.n;
    }

    // Scheduled leads split into followup/today/overdue by followUpDate. This
    // set is small (only leads in a scheduled status), so bucket them in JS via
    // effectiveStatus — which handles both Date and "YYYY-MM-DD" values. A
    // $regex query would silently miss Date-typed followUpDate values.
    const scheduled = await Lead.find(
      { ...match, status: { $in: SCHEDULED_STATUSES } },
      "status followUpDate"
    ).lean();
    let overdue = 0;
    let todayCount = 0;
    let followup = 0;
    for (const l of scheduled) {
      const eff = effectiveStatus(l.status, l.followUpDate);
      if (eff === "overdue") overdue += 1;
      else if (eff === "today") todayCount += 1;
      else followup += 1;
    }

    const stats = {
      new: byStored.new || 0,
      overdue,
      today: todayCount,
      followup,
      inprocess: byStored.inprocess || 0,
      converted: byStored.converted || 0,
      dead: byStored.dead || 0,
      total,
    };

    return res.json({ success: true, data: stats });
  } catch (err) {
    console.error("getStats error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};
