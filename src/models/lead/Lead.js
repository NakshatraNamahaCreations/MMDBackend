const mongoose = require("mongoose");
const {
  LEAD_STATUSES,
  PAYMENT_STATUSES,
  LEAD_TYPES,
} = require("../../constants/services");

const noteSchema = new mongoose.Schema(
  {
    text: { type: String, required: true, trim: true },
    author: { type: String, default: "Website" },
  },
  { timestamps: true }
);

const leadSchema = new mongoose.Schema(
  {
    slNo: { type: Number },
    orderId: { type: String, index: true },

    // display date/time captured at submission (admin tables read these)
    date: { type: String },
    time: { type: String },

    // contact
    name: { type: String, required: true, trim: true },
    mobileNumber: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true, default: "" },

    // location
    address: { type: String, default: "" },
    district: { type: String, default: "" },
    state: { type: String, default: "" },
    pinCode: { type: String, default: "" },

    // service + commercials
    service: { type: String, required: true, trim: true },
    amount: { type: Number, default: 0 },
    paymentStatus: {
      type: String,
      enum: PAYMENT_STATUSES,
      default: "unpaid",
    },

    // Paytm-side identifiers (captured from the success callback) — required
    // to call the Paytm refund API later.
    paytmTxnId: { type: String, default: "" },
    paytmBankTxnId: { type: String, default: "" },
    paidAt: { type: Date },

    // Refund tracking — set when an admin issues a refund through the panel.
    refundStatus: {
      type: String,
      enum: ["none", "pending", "refunded", "failed"],
      default: "none",
    },
    refundAmount: { type: Number, default: 0 },
    refundRefId: { type: String, default: "" },     // our REFID sent to Paytm
    refundPaytmId: { type: String, default: "" },   // Paytm's refundId
    refundedAt: { type: Date },
    refundError: { type: String, default: "" },

    // CRM workflow
    status: { type: String, enum: LEAD_STATUSES, default: "new" },
    assignedTo: { type: String, default: "" },
    source: { type: String, default: "Website" },
    leadType: { type: String, enum: LEAD_TYPES, default: "website" },
    followUpDate: { type: String },
    notes: { type: [noteSchema], default: [] },

    // common applicant fields shared across several services
    applyingFor: { type: String },
    gender: { type: String },
    dateOfBirth: { type: String },
    placeOfBirth: { type: String },
    educationQualification: { type: String },
    employmentType: { type: String },
    nearbyPoliceStation: { type: String },

    // everything else the per-service form collects
    formData: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      versionKey: false,
      transform: (_doc, ret) => {
        delete ret._id;
        return ret;
      },
    },
  }
);

// The admin panel's incremental sync asks for "leads changed since X", and the
// full list is sorted newest-first — both need these to avoid a collection scan.
leadSchema.index({ updatedAt: -1 });
leadSchema.index({ createdAt: -1 });
// Paged converted/dead tabs: filter by status, newest first.
leadSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model("Lead", leadSchema);
