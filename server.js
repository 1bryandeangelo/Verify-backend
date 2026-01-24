import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* HEALTH CHECK */
app.get("/", (req, res) => {
  res.send("Verifly backend running");
});

/* SCAN GATE (NO AI YET) */
app.post("/scan", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({ error: "Missing Authorization header" });
    }

    const token = authHeader.replace("Bearer ", "");

    // 1️⃣ Verify user
    const {
      data: { user },
      error: authError
    } = await supabase.auth.getUser(token);

    if (authError || !user) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    // 2️⃣ Check scan count
    const { count, error: countError } = await supabase
      .from("scans")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.id);

    if (countError) {
      return res.status(500).json({ error: "Scan lookup failed" });
    }

    if (count >= 1) {
      return res.status(403).json({ error: "Free scan already used" });
    }

    // 3️⃣ Record scan
    const { error: insertError } = await supabase
      .from("scans")
      .insert({ user_id: user.id });

    if (insertError) {
      return res.status(500).json({ error: "Failed to record scan" });
    }

    // 4️⃣ Allow scan
    res.json({ allowed: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* START SERVER */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Verifly backend running on port ${PORT}`);
});
