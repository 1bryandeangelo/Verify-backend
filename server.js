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
import multer from "multer";
const upload = multer({ storage: multer.memoryStorage() });

app.post("/scan", upload.single("image"), async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: "Missing auth" });
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: "Invalid token" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No image uploaded" });
    }

    const { count } = await supabase
      .from("scans")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.id);

    if (count >= 1) {
      return res.status(403).json({ error: "Free scan used" });
    }

    await supabase.from("scans").insert({ user_id: user.id });

    res.json({
      message: "✅ Image received. AI scan coming next."
    });

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
