app.get("/", (req, res) => {
  res.send("Verifly backend running");
});

import express from "express";
import Stripe from "stripe";
import Replicate from "replicate";
import cors from "cors";
import { v4 as uuid } from "uuid";

const app = express();
app.use(cors());
app.use(express.json());

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_KEY
});

const users = {}; // replace w/ DB later

// Create user
app.post("/signup", (req,res)=>{
  const id = uuid();
  users[id] = {
    email: req.body.email,
    scans: 0,
    tier: "free",
    videoUsed: 0
  };
  res.json({userId:id});
});

// Scan
app.post("/scan", async (req,res)=>{
  const { userId, type } = req.body;
  const user = users[userId];

  if(!user) return res.status(401).send("No user");

  // FREE LIMIT
  if(user.tier==="free" && user.scans>=1)
    return res.status(402).send("Paywall");

  // VIDEO LIMIT
  if(type==="video"){
    if(user.tier!=="power") 
      return res.status(403).send("Upgrade required");

    if(user.videoUsed>=20)
      return res.status(402).send("Video limit reached");

    user.videoUsed += 1;
  }

  // Replicate call (image example)
  const output = await replicate.run(
    "meta/llama-2-7b-chat",
    { input: { prompt: "Analyze image authenticity"} }
  );

  user.scans++;
  res.json({ result: output });
});


// Stripe webhook
app.post("/webhook", 
express.raw({type:"application/json"}), 
(req,res)=>{
  const event = req.body;

  if(event.type==="checkout.session.completed"){
    const email = event.data.object.customer_details.email;

    for(const u in users){
      if(users[u].email===email){
        if(event.data.object.amount_total==199){
          users[u].tier="single";
        }
        if(event.data.object.amount_total==700){
          users[u].tier="pro";
        }
        if(event.data.object.amount_total==1900){
          users[u].tier="power";
        }
      }
    }
  }

  res.json({received:true});
});

app.listen(3000,()=>console.log("Running"));
