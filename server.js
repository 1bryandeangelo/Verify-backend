import express from "express";
import cors from "cors";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";
import Replicate from "replicate";
import Stripe from "stripe";

const app = express();
app.use(cors());
app.use((req, res, next) => {
  if (req.originalUrl === '/webhook') {
    next();
  } else {
    express.json()(req, res, next);
  }
});

  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// Multer for file uploads
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB
});

/* ---------- SUPABASE ---------- */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* ---------- STRIPE ---------- */
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/* ---------- REPLICATE ---------- */
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

/* ---------- HEALTH CHECK ---------- */
app.get("/", (req, res) => {
  res.send("Verifly backend running");
});

/* ---------- CREATE STRIPE CHECKOUT ---------- */
app.post("/create-checkout", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: "Missing auth header" });
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);

    if (userError || !user) {
      return res.status(401).json({ error: "Invalid token" });
    }

    const { priceId, mode } = req.body;

    // Create or get Stripe customer
    let stripeCustomerId;
    const { data: existingCustomer } = await supabase
      .from("users")
      .select("stripe_customer_id")
      .eq("id", user.id)
      .single();

    if (existingCustomer?.stripe_customer_id) {
      stripeCustomerId = existingCustomer.stripe_customer_id;
    } else {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { supabase_user_id: user.id }
      });
      stripeCustomerId = customer.id;
      
      // Save customer ID
      await supabase
        .from("users")
        .upsert({ id: user.id, stripe_customer_id: stripeCustomerId });
    }

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      mode: mode, // 'payment' or 'subscription'
      line_items: [{
        price: priceId,
        quantity: 1,
      }],
      success_url: `${process.env.FRONTEND_URL}?success=true`,
      cancel_url: `${process.env.FRONTEND_URL}?canceled=true`,
      metadata: {
        supabase_user_id: user.id
      }
    });

    res.json({ sessionId: session.id });

  } catch (err) {
    console.error("Checkout error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ---------- STRIPE WEBHOOK ---------- */
app.post("/webhook", express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        const session = event.data.object;
        const userId = session.metadata.supabase_user_id;

        console.log("Processing payment for user:", userId);

        if (session.mode === 'payment') {
          const { error } = await supabase
            .from("credits")
            .insert({ user_id: userId, credits: 1 });
          
          if (error) {
            console.error("Credits insert error:", error);
          } else {
            console.log("✅ Credit added for user:", userId);
          }
        }
        break;
    }

    res.json({ received: true });
  } catch (err) {
    console.error("Webhook handler error:", err);
    res.status(500).json({ error: err.message });
  }
});


/* ---------- SCAN ENDPOINT ---------- */
app.post("/scan", upload.single('file'), async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: "Missing auth header" });
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);

    if (userError || !user) {
      return res.status(401).json({ error: "Invalid token" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // Check if user has credits
    const hasAccess = await checkUserAccess(user.id);
    
    if (!hasAccess) {
      return res.status(403).json({ error: "FREE_SCAN_USED" });
    }

    // Run AI detection
    const aiScore = await detectAI(req.file);
    const isAI = aiScore > 0.5;

    // Record the scan
    await recordScan(user.id, aiScore, isAI);

    res.json({ 
      allowed: true,
      aiScore: aiScore,
      isAI: isAI
    });

  } catch (err) {
    console.error("🔥 SCAN ERROR:", err);
    res.status(500).json({ error: "SERVER_ERROR", details: err.message });
  }
});

/* ---------- HELPER FUNCTIONS ---------- */

async function checkUserAccess(userId) {
  // Check if user has active subscription
  const { data: subscription } = await supabase
    .from("subscriptions")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active")
    .single();

  if (subscription) {
    return true; // Has active subscription
  }

  // Check if user has credits
  const { data: credits } = await supabase
    .from("credits")
    .select("credits")
    .eq("user_id", userId)
    .single();

  if (credits && credits.credits > 0) {
    return true; // Has credits
  }

  // Check if user has used their free scan
  const { count } = await supabase
    .from("scans")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId);

  return count === 0; // Allow if no scans yet
}

async function recordScan(userId, score, isAI) {
  // Record the scan
  await supabase
    .from("scans")
    .insert({ 
      user_id: userId,
      score: score,
      is_ai: isAI
    });

  // Deduct credit if user has any
  const { data: credits } = await supabase
    .from("credits")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (credits && credits.credits > 0) {
    await supabase
      .from("credits")
      .update({ credits: credits.credits - 1 })
      .eq("user_id", userId);
  }
}

async function detectAI(file) {
  // For now, return random score for testing
  // TODO: Implement Replicate AI detection
  const mockScore = Math.random();
  console.log(`AI Detection Score: ${mockScore}`);
  
  /* 
  // Example Replicate implementation:
  try {
    const output = await replicate.run(
      "andreasjansson/clip-features:75b33f253f7714a281ad3e9b28f63e3232d583716ef6718f2e46641077ea040a",
      {
        input: {
          inputs: file.buffer.toString('base64')
        }
      }
    );
    return output.ai_probability || 0.5;
  } catch (err) {
    console.error("Replicate error:", err);
    return 0.5;
  }
  */
  
  return mockScore;
}

/* ---------- START ---------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("✅ Backend listening on", PORT);
});
