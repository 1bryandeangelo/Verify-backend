import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(cors());
app.use(express.json());

/* ---------- SUPABASE (SERVICE ROLE REQUIRED) ---------- */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* ---------- HEALTH CHECK ---------- */
app.get("/", (req, res) => {
  res.send("Verifly backend running");
});

/* ---------- SCAN GATE ---------- */
app.post("/scan", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: "Missing auth header" });
    }

    const token = authHeader.replace("Bearer ", "");

    // 1️⃣ Verify user
    const { data: { user }, error: userError } =
      await supabase.auth.getUser(token);

    if (userError || !user) {
      return res.status(401).json({ error: "Invalid token" });
    }

    // 2️⃣ Check scan count
    const { count, error: countError } = await supabase
      .from("scans")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.id);

    if (countError) {
      throw countError;
    }

    if (count >= 1) {
      return res.status(403).json({ error: "FREE_SCAN_USED" });
    }

    // 3️⃣ Insert scan record
    const { error: insertError } = await supabase
      .from("scans")
      .insert({ user_id: user.id });

    if (insertError) {
      throw insertError;
    }

    res.json({ allowed: true });

  } catch (err) {
    console.error("🔥 SCAN ERROR:", err);
    res.status(500).json({ error: "SERVER_ERROR" });
  }
});

/* ---------- START ---------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("✅ Backend listening on", PORT);
});
