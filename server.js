import express from "express";
import Stripe from "stripe";
import Replicate from "replicate";
import cors from "cors";
import { v4 as uuid } from "uuid";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(cors());
app.use(express.json());

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_KEY
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

app.get("/", (req, res) => {
  res.send("Verifly backend running");
});

/* SIGNUP */
app.post("/signup", async (req, res) => {
  const { email, name, use_case } = req.body;

  const { data, error } = await supabase
    .from("users")
    .insert({ email, name, use_case })
    .select();

  if (error) return res.status(500).json(error);
  res.json(data[0]);
});

/* SCAN */
app.post("/scan", async (req, res) => {
  try {
    const { imageUrl, userId } = req.body;

    // 1) Check free limit
    const { data: scans } = await supabase
      .from("scans")
      .select("*")
      .eq("user_id", userId);

    if (scans.length >= 1) {
      return res.status(403).json({ error: "PAYWALL" });
    }

    // 2) Send to Replicate
    const response = await fetch(
      "https://api.replicate.com/v1/predictions",
      {
        method: "POST",
        headers: {
          Authorization: `Token ${process.env.REPLICATE_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          version: "MODEL_VERSION_HERE",
          input: { image: imageUrl }
        })
      }
    );

    const prediction = await response.json();

    const score = prediction.output.score;
    const isAI = score > 0.5;

    // 3) Save result
    await supabase.from("scans").insert({
      user_id: userId,
      score,
      is_ai: isAI
    });

    res.json({ score, isAI });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Scan failed" });
  }
});

/* START SERVER */
app.listen(3000, () =>
  console.log("Verifly backend running")
);

import express from "express";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---- SCAN GATE ----
app.post("/scan", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: "Missing Authorization header" });
    }

    const token = authHeader.replace("Bearer ", "");

    // 1️⃣ Verify user
    const { data: { user }, error: userError } =
      await supabase.auth.getUser(token);

    if (userError || !user) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    // 2️⃣ Check existing scans
    const { count, error: countError } = await supabase
      .from("scans")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.id);

    if (countError) {
      return res.status(500).json({ error: "Scan lookup failed" });
    }

    if (count >= 1) {
      return res.status(403).json({
        error: "Free scan already used"
      });
    }

    // 3️⃣ Insert scan record
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

app.listen(3000, () => {
  console.log("Verify backend running on port 3000");
});
