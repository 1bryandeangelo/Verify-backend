import express from "express";
import Stripe from "stripe";
import Replicate from "replicate";
import cors from "cors";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Verifly backend running");
});

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_KEY
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);



// ---------------- SCAN ----------------

app.post("/scan", async (req, res) => {
  try {
    const { imageUrl, userId } = req.body;

    // 1) Check scan count
    const { data: scans } = await supabase
      .from("scans")
      .select("*")
      .eq("user_id", userId);

    if (scans.length >= 1) {
      return res.status(403).json({ error: "PAYWALL" });
    }

    // 2) Send to Replicate (IMAGE ONLY)
    const response = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        "Authorization": `Token ${process.env.REPLICATE_API_KEY}`,
