import express from "express";
import Stripe from "stripe";
import Replicate from "replicate";
import cors from "cors";
import { v4 as uuid } from "uuid";
import fetch from "node-fetch";
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
  process.env.SUPABASE_ANON_KEY
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
