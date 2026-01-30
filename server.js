import express from "express";
import cors from "cors";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";
import Replicate from "replicate";
import Stripe from "stripe";

const app = express();
app.use(cors());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0] || 
         req.headers['x-real-ip'] || 
         req.connection.remoteAddress || 
         req.socket.remoteAddress;
}

async function checkRateLimit(ip, endpoint, maxRequests, windowMinutes) {
  const now = new Date();
  const windowStart = new Date(now - windowMinutes * 60000);
  
  const { data: existing } = await supabase
    .from('rate_limits')
    .select('*')
    .eq('ip_address', ip)
    .eq('endpoint', endpoint)
    .gte('window_start', windowStart.toISOString())
    .single();
  
  if (existing) {
    if (existing.request_count >= maxRequests) {
      return false;
    }
    await supabase
      .from('rate_limits')
      .update({ request_count: existing.request_count + 1 })
      .eq('id', existing.id);
  } else {
    await supabase
      .from('rate_limits')
      .insert({ 
        ip_address: ip, 
        endpoint: endpoint, 
        request_count: 1,
        window_start: now.toISOString()
      });
  }
  return true;
}

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
    console.error("Webhook signature error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log("Webhook received:", event.type);

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.metadata.supabase_user_id;
      
      console.log("Payment completed for user:", userId);

      if (session.mode === 'payment') {
        const { error } = await supabase
          .from("credits")
          .insert({ user_id: userId, credits: 1 });
        
        if (error) {
          console.error("Credits insert error:", error);
        } else {
          console.log("Credit added successfully!");
        }
      } else if (session.mode === 'subscription') {
        const priceId = session.line_items?.data[0]?.price?.id || '';
        let planType = 'starter';
        
        if (priceId === 'price_1StYL46ILDOjliDIe0KBxUqf') planType = 'starter';
        else if (priceId === 'price_1StYLe6ILDOjliDIZamQKL1Y') planType = 'pro';
        else if (priceId === 'price_1StYMD6ILDOjliDI6gVqPr7J') planType = 'power';
        
        const { error } = await supabase
          .from("users")
          .upsert({
            id: userId,
            plan_type: planType,
            monthly_scans_used: 0,
            monthly_reset_date: new Date().toISOString()
          });
        
        if (error) {
          console.error("User plan update error:", error);
        } else {
          console.log(`User upgraded to ${planType} plan!`);
        }
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error("Webhook handler error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.use(express.json());

const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

app.get("/", (req, res) => {
  res.send("Verifly backend running");
});

app.get("/user-info", async (req, res) => {
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

    const { data: userInfo } = await supabase
      .from("users")
      .select("plan_type, monthly_scans_used, monthly_reset_date, stripe_customer_id")
      .eq("id", user.id)
      .single();

    if (userInfo?.monthly_reset_date) {
      const resetDate = new Date(userInfo.monthly_reset_date);
      const now = new Date();
      if (now.getMonth() !== resetDate.getMonth() || now.getFullYear() !== resetDate.getFullYear()) {
        await supabase
          .from("users")
          .update({ 
            monthly_scans_used: 0,
            monthly_reset_date: now.toISOString()
          })
          .eq("id", user.id);
        if (userInfo) userInfo.monthly_scans_used = 0;
      }
    }

    const planType = userInfo?.plan_type || 'free';
    const scansUsed = userInfo?.monthly_scans_used || 0;

    const planLimits = {
      'free': 1,
      'starter': 25,
      'pro': 100,
      'power': 500
    };

    const limit = planLimits[planType] || 1;
    const scansRemaining = Math.max(0, limit - scansUsed);

    const { data: credits } = await supabase
      .from("credits")
      .select("credits")
      .eq("user_id", user.id)
      .single();

    const totalCredits = credits?.credits || 0;

    res.json({
      planType,
      scansUsed,
      scansRemaining: scansRemaining + totalCredits,
      monthlyLimit: limit,
      credits: totalCredits,
      hasStripeCustomer: !!userInfo?.stripe_customer_id
    });

  } catch (err) {
    console.error("User info error:", err);
    res.status(500).json({ error: err.message });
  }
});

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
      
      await supabase
        .from("users")
        .upsert({ id: user.id, stripe_customer_id: stripeCustomerId });
    }

    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      mode: mode,
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

app.post("/create-portal-session", async (req, res) => {
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

    const { data: userData } = await supabase
      .from("users")
      .select("stripe_customer_id")
      .eq("id", user.id)
      .single();

    if (!userData?.stripe_customer_id) {
      return res.status(400).json({ error: "No subscription found" });
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: userData.stripe_customer_id,
      return_url: `${process.env.FRONTEND_URL}`,
    });

    res.json({ url: portalSession.url });

  } catch (err) {
    console.error("Portal session error:", err);
    res.status(500).json({ error: err.message });
  }
});

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

    const ip = getClientIP(req);
    
    const canProceed = await checkRateLimit(ip, 'scan', 50, 60);
    if (!canProceed) {
      return res.status(429).json({ error: "Rate limit exceeded. Max 50 scans per hour." });
    }

    if (!user.email_confirmed_at) {
      return res.status(403).json({ error: "Please verify your email before scanning" });
    }

    const accessInfo = await checkUserAccess(user.id);
    
    if (!accessInfo.hasAccess) {
      return res.status(403).json({ error: "SCAN_LIMIT_REACHED" });
    }

    const aiScore = await detectAI(req.file);
    const isAI = aiScore > 0.5;

    await recordScan(user.id, aiScore, isAI, ip);

    res.json({ 
      allowed: true,
      aiScore: aiScore,
      isAI: isAI,
      scansRemaining: accessInfo.scansRemaining
    });

  } catch (err) {
    console.error("SCAN ERROR:", err);
    res.status(500).json({ error: "SERVER_ERROR", details: err.message });
  }
});

async function checkUserAccess(userId) {
  const { data: userInfo } = await supabase
    .from("users")
    .select("plan_type, monthly_scans_used, monthly_reset_date")
    .eq("id", userId)
    .single();

  if (userInfo?.monthly_reset_date) {
    const resetDate = new Date(userInfo.monthly_reset_date);
    const now = new Date();
    if (now.getMonth() !== resetDate.getMonth() || now.getFullYear() !== resetDate.getFullYear()) {
      await supabase
        .from("users")
        .update({ 
          monthly_scans_used: 0,
          monthly_reset_date: now.toISOString()
        })
        .eq("id", userId);
      if (userInfo) userInfo.monthly_scans_used = 0;
    }
  }

  const planType = userInfo?.plan_type || 'free';
  const scansUsed = userInfo?.monthly_scans_used || 0;

  const planLimits = {
    'free': 1,
    'starter': 25,
    'pro': 100,
    'power': 500
  };

  const limit = planLimits[planType] || 1;

  if (scansUsed < limit) {
    return { 
      hasAccess: true, 
      scansRemaining: limit - scansUsed,
      planType: planType
    };
  }

  const { data: credits } = await supabase
    .from("credits")
    .select("credits")
    .eq("user_id", userId)
    .single();

  if (credits && credits.credits > 0) {
    return { 
      hasAccess: true, 
      scansRemaining: credits.credits,
      planType: 'credit'
    };
  }

  return { hasAccess: false, scansRemaining: 0, planType: planType };
}

async function recordScan(userId, score, isAI, ip) {
  await supabase
    .from("scans")
    .insert({ 
      user_id: userId,
      score: score,
      is_ai: isAI,
      ip_address: ip
    });

  await supabase.rpc('increment_scans_used', { user_id: userId });
}

async function detectAI(file) {
  try {
    const base64Image = file.buffer.toString('base64');
    const dataURI = `data:${file.mimetype};base64,${base64Image}`;
    
    console.log("Calling Replicate AI detection...");
    
    const detection = await replicate.run(
      "lucataco/ai-detector:3e1c41afd05b0f36df4ed16dd948c0c5b65f0f39e1220a21b4aa69b8c1278bb6",
      {
        input: {
          image: dataURI
        }
      }
    );
    
    const aiScore = parseFloat(detection) || 0.5;
    
    console.log(`Real AI Detection Score: ${aiScore}`);
    return aiScore;
    
  } catch (err) {
    console.error("Replicate error:", err);
    return 0.5;
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Backend listening on", PORT);
});
