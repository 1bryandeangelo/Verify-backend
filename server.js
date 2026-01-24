import express from "express";
import cors from "cors";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";
import Replicate from "replicate";

const app = express();
app.use(cors());
app.use(express.json());

// Multer for file uploads (stores in memory)
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

/* ---------- SUPABASE ---------- */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* ---------- REPLICATE (for AI detection) ---------- */
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

/* ---------- HEALTH CHECK ---------- */
app.get("/", (req, res) => {
  res.send("Verifly backend running");
});

/* ---------- SCAN ENDPOINT ---------- */
app.post("/scan", upload.single('file'), async (req, res) => {
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

    // 3️⃣ Check if file was uploaded
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // 4️⃣ Run AI detection
    const aiScore = await detectAI(req.file);

    // 5️⃣ Insert scan record with results
    const isAI = aiScore > 0.5;
    
    const { error: insertError } = await supabase
      .from("scans")
      .insert({ 
        user_id: user.id,
        score: aiScore,
        is_ai: isAI
      });

    if (insertError) {
      throw insertError;
    }

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

/* ---------- AI DETECTION FUNCTION ---------- */
async function detectAI(file) {
  // Simple placeholder - you'll need to implement actual AI detection
  // Options:
  // 1. Use Replicate API with an AI detection model
  // 2. Use Hive AI API
  // 3. Use OpenAI's moderation API
  // 4. Build your own model
  
  // For now, return a random score for testing
  const mockScore = Math.random();
  console.log(`AI Detection Score: ${mockScore}`);
  
  /* EXAMPLE: Using Replicate for AI detection
  try {
    const output = await replicate.run(
      "ai-detection-model", // Replace with actual model
      {
        input: {
          image: file.buffer.toString('base64')
        }
      }
    );
    return output.ai_probability;
  } catch (err) {
    console.error("Replicate error:", err);
    return 0.5; // Default fallback
  }
  */
  
  return mockScore;
}

/* ---------- START ---------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("✅ Backend listening on", PORT);
});
