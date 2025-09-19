import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import authRoutes from "./routes/auth.routes.js";
import certRoutes from "./routes/certificates.routes.js";
import { requestId, httpLogger } from "./middleware/logger.js";
import sql from "./db/db.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// logging — add requestId first, then logger
app.use(requestId);
app.use(httpLogger);

// health
app.get("/health", (_, res) => res.send("ok"));

// routes
app.use("/auth", authRoutes);
app.use("/certificates", certRoutes);

async function start() {
  try {
    await sql`select 1`;
    console.log("✅ Database connected");
    const port = process.env.PORT || 8080;
    app.listen(port, () => console.log(`🚀 Server running on port ${port}`));
  } catch (e) {
    console.error("❌ Database connection failed:", e);
    process.exit(1);
  }
}
start();
