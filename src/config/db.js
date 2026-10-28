const mongoose = require("mongoose");

exports.connectDB = async () => {
  try {
    await mongoose.connect(
      process.env.MONGO_URI ||
        "mongodb+srv://mmdnew:mmdnew@cluster0.sootp5d.mongodb.net/mmd?appName=Cluster0",
      // Compress DB traffic (built into the driver). Full-list loads are
      // several MB and the link to Atlas is slow.
      { compressors: "zlib" }
    );
    console.log("Database connected.........");
  } catch (err) {
    console.error("MongoDB connection failed:", err.message);
    process.exit(1);
  }
};
