import express from "express";
import Stripe from "stripe";
import { Resend } from "resend";
import { createClient } from "@supabase/supabase-js";
import cors from "cors";
import bodyParser from "body-parser";

// ----------------------------
// CONFIG & INIT
// ----------------------------
const app = express();

// Security Headers
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "lifetime");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  next();
});

// CORS Configuration
const allowedOrigins = [
  "https://heloxai.xyz",
  process.env.FRONTEND_URL
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  methods: ["GET", "POST", "OPTIONS", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
}));

// Body Parser Strategy
app.use((req, res, next) => {
  if (req.path === '/stripe-webhook') {
    return bodyParser.raw({ type: "application/json" })(req, res, next);
  }
  express.json()(req, res, next);
});

// Services
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
  typescript: true,
});

const resend = new Resend(process.env.RESEND_API_KEY);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY 
);

// Helpers
function trackAnalytics(eventName, properties = {}) {
  console.log(`[ANALYTICS] ${eventName}:`, JSON.stringify(properties));
}

async function logAdminAction(adminId, action, targetId = null) {
  try {
    await supabase.from("admin_audit_logs").insert({
      admin_id: adminId,
      action: action,
      target_id: targetId,
    });
  } catch (err) {
    console.error("❌ Failed to log admin action:", err);
  }
}

async function sendEmail(to, subject, htmlContent) {
  try {
    if (!process.env.FROM_EMAIL) {
      console.warn("⚠️ FROM_EMAIL not set, skipping email.");
      return;
    }
    const result = await resend.emails.send({
      from: process.env.FROM_EMAIL,
      to,
      subject,
      html: htmlContent,
    });
    console.log("📧 Email sent:", result.id);
    return result;
  } catch (err) {
    console.error("❌ Refund error:", err);
  }
}

async function sendTrialEndingEmail(email, plan, endDate) {
  const subject = "Your HeloxAi Trial is Ending Soon";
  const html = `
    <p>Hi there,</p>
    <p>Your <strong>${plan}</strong> trial ends on <strong>${new Date(endDate * 1000).toLocaleDateString()}</strong>.</p>
    <p>Your payment method will be charged automatically unless you cancel.</p>
    <br>
    <p>Best,<br>The HeloxAi Team</p>
  `;
  await sendEmail(email, subject, html);
}

async function getChargeId(paymentIntentId) {
  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    return paymentIntent.latest_charge;
  } catch (err) {
    console.error("❌ Error retrieving charge ID:", err);
    return null;
  }
}

// Auth Middleware
async function authenticateUser(req, res, next) {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ error: "Missing token" });

    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: "Invalid user" });
    }

    req.user = user;
    next();
  } catch (err) {
    console.error("Auth error:", err);
    res.status(500).json({ error: "Internal auth error" });
  }
}

async function requireAdmin(req, res, next) {
  try {
    const { data: publicUser, error } = await supabase
      .from("users")
      .select("role")
      .eq("id", req.user.id)
      .single();

    if (error || !publicUser || publicUser.role !== "admin") {
      return res.status(403).json({ error: "Forbidden: Admins only" });
    }

    req.adminProfile = publicUser;
    next();
  } catch (err) {
    res.status(500).json({ error: "Error checking permissions" });
  }
}

// ----------------------------
// DB RESET HELPERS
// ----------------------------

async function handleRefundReset(userId) {
  const { data: user } = await supabase
    .from("users")
    .select("refund_count")
    .eq("id", userId)
    .single();

  if (!user) return;

  const newRefundCount = (user.refund_count || 0) + 1;

  const { error } = await supabase
    .from("users")
    .update({
      plan: null,
      is_premium: false,
      is_lifetime: false,
      stripe_subscription_id: null,
      subscription_status: "refunded",
      current_period_end: null,
      refund_count: newRefundCount,
      last_refund_at: new Date().toISOString(),
    })
    .eq("id", userId);

  if (error) {
    console.error("❌ Failed to reset user after refund:", error.message);
  } else {
    console.log(`✅ User ${userId} refunded and reset. Count: ${newRefundCount}`);
    trackAnalytics("user_refunded", { user_id: userId, refund_count: newRefundCount });
  }
}

async function handleSubscriptionCancellation(userId) {
  const { error } = await supabase
    .from("users")
    .update({
      plan: null,
      is_premium: false,
      is_lifetime: false,
      stripe_subscription_id: null,
      subscription_status: "canceled",
      current_period_end: null,
    })
    .eq("id", userId);

  if (error) {
    console.error("❌ Failed to reset user after cancellation:", error.message);
  } else {
    console.log(`✅ User ${userId} subscription cancelled.`);
    trackAnalytics("user_cancelled", { user_id: userId });
  }
}

// ----------------------------
// ROUTES: STRIPE & PAYMENTS
// ----------------------------

app.post("/create-checkout-session", async (req, res) => {
  try {
    const { user_id, email, plan } = req.body;

    if (!user_id || !email || !plan) {
      return res.status(400).json({ error: "Missing user_id, email, or plan" });
    }

    let line_item;
    let mode;
    let product_name;
    const logoUrl = "https://heloxai.xyz/logo.png";

    switch (plan) {
      case "lifetime":
        mode = "payment";
        product_name = "HeloxAI Lifetime Access";
        line_item = {
          price_data: {
            currency: "gbp",
            product_data: {
              name: product_name,
              description: "One-time lifetime premium subscription to HeloxAI",
              images: [logoUrl], 
            },
            unit_amount: 49900, 
          },
          quantity: 1,
        };
        break;
      case "monthly":
        mode = "subscription";
        product_name = "HeloxAI Monthly Premium";
        if (!process.env.STRIPE_MONTHLY_PRICE_ID) throw new Error("Missing Price ID config");
        line_item = { price: process.env.STRIPE_MONTHLY_PRICE_ID, quantity: 1 };
        break;
      case "yearly":
        mode = "subscription";
        product_name = "HeloxAI Yearly";
        if (!process.env.STRIPE_YEARLY_PRICE_ID) throw new Error("Missing Price ID config");
        line_item = { price: process.env.STRIPE_YEARLY_PRICE_ID, quantity: 1 };
        break;
      default:
        return res.status(400).json({ error: "Invalid plan type" });
    }

    const sessionConfig = {
      mode,
      line_items: [line_item],
      client_reference_id: user_id,
      customer_email: email,
      metadata: { user_id, product: plan }, 
      success_url: `${process.env.FRONTEND_URL}/prem.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/prem.html?cancelled=true`
    };

    if (mode === 'subscription') {
      sessionConfig.subscription_data = {};
      if (plan === 'monthly') {
        sessionConfig.subscription_data.trial_period_days = 3;
      } else if (plan === 'yearly') {
        sessionConfig.subscription_data.trial_period_days = 7;
      }
    }

    const session = await stripe.checkout.sessions.create(sessionConfig);
    trackAnalytics("checkout_session_created", { user_id, plan, mode });
    res.json({ url: session.url });

  } catch (err) {
    console.error("❌ Create checkout error:", err);
    res.status(500).json({ error: err.message, type: err.type, code: err.code });
  }
});

app.post("/create-portal-session", async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: "Missing user_id" });

    const { data: user, error } = await supabase
      .from("users")
      .select("stripe_customer_id, email")
      .eq("id", user_id)
      .single();

    if (error || !user || !user.stripe_customer_id) {
      return res.status(404).json({ error: "No active subscription found to manage." });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `${process.env.FRONTEND_URL}/prem.html`,
    });

    trackAnalytics("portal_accessed", { user_id });
    res.json({ url: session.url });

  } catch (err) {
    console.error("❌ Portal session error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/refund", authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id; // Use authenticated user ID

    const { data: user, error: userError } = await supabase
      .from("users")
      .select("refund_count, last_refund_at, plan, stripe_subscription_id")
      .eq("id", userId)
      .single();

    if (userError || !user) return res.status(404).json({ error: "User not found" });

    if (user.refund_count >= 1) {
      return res.status(403).json({
        error: "You have already used your one-time refund option. You can cancel your subscription, but cannot receive another refund."
      });
    }

    const { data: payment, error: paymentError } = await supabase
      .from("payments")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (paymentError || !payment) return res.status(404).json({ error: "Payment not found" });
    if (payment.status === "refunded") return res.status(400).json({ error: "Payment already refunded" });

    const created = new Date(payment.created_at);
    const now = new Date();
    const diffDays = (now - created) / (1000 * 60 * 60 * 24);

    if (diffDays > 7) {
      return res.status(403).json({ error: "Refund period expired (7 days max)." });
    }

    if (!payment.stripe_payment_intent_id) {
      return res.status(400).json({ error: "No payment intent found associated with this payment." });
    }

    // 1. Process Refund in Stripe
    await stripe.refunds.create({
      payment_intent: payment.stripe_payment_intent_id,
      reason: "requested_by_customer"
    });

    // 2. Cancel Subscription in Stripe if active (CRITICAL FIX)
    // If we don't do this, they get refunded now but charged again next month.
    if (user.stripe_subscription_id) {
      try {
        await stripe.subscriptions.cancel(user.stripe_subscription_id);
        console.log(`🚫 Cancelled subscription ${user.stripe_subscription_id} due to refund.`);
      } catch (subError) {
        console.warn("⚠️ Warning: Failed to cancel subscription in Stripe during refund:", subError.message);
      }
    }

    // 3. Update Payment Record
    await supabase.from("payments")
      .update({
        status: "refunded",
        updated_at: new Date().toISOString()
      })
      .eq("id", payment.id);

    // 4. Reset User Data
    await handleRefundReset(userId);

    res.json({ success: true, message: "Refund processed successfully." });

  } catch (err) {
    console.error("❌ Refund error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------
// CORE LOGIC: UPGRADE USER
// ----------------------------
async function upgradeUser(session) {
  const userId = session.client_reference_id;
  const email = session.customer_details?.email;
  const planType = session.metadata.product; // 'lifetime', 'monthly', 'yearly'

  if (!userId && !email) throw new Error("No user identifier found in session");

  const baseData = {
    id: userId,
    email: email,
    stripe_customer_id: session.customer || null,
    is_premium: true,
    is_free: false,
    is_lifetime: false,
    updated_at: new Date().toISOString(),
  };

  let dbPlan = "premium"; 
  let productName = "Premium Subscription";

  if (planType === "lifetime") {
    dbPlan = "lifetime";
    productName = "Lifetime Plan";
    Object.assign(baseData, {
      plan: "lifetime",
      is_lifetime: true,
      is_premium: true,
      stripe_subscription_id: null,
      subscription_status: null,
      current_period_end: null
    });
  } else if (planType === "monthly" || planType === "yearly") {
    // Handle both subscription types with shared logic
    dbPlan = planType === 'monthly' ? 'ultimate_monthly' : 'ultimate_yearly';
    productName = planType === 'monthly' ? 'Ultimate Monthly' : 'Ultimate Yearly';
    
    Object.assign(baseData, {
      plan: dbPlan,
      is_lifetime: false,
      is_premium: true,
    });
    
    if (session.subscription) {
      try {
        const subscription = await stripe.subscriptions.retrieve(session.subscription);
        Object.assign(baseData, {
          stripe_subscription_id: session.subscription,
          subscription_status: subscription.status,
          current_period_end: subscription.current_period_end
            ? new Date(subscription.current_period_end * 1000).toISOString()
            : null,
        });
      } catch (e) {
        console.error("Failed to retrieve subscription details for upgrade:", e);
      }
    }
  }

  const { error: upsertError } = await supabase
    .from("users")
    .upsert(baseData, { onConflict: "id" });

  if (upsertError) {
    throw new Error("Failed to upsert user: " + upsertError.message);
  }

  const profilePlan = planType === 'free' ? 'free' : 'premium';
  await supabase
    .from("user_profiles")
    .upsert({
      user_id: userId,
      plan: profilePlan
    }, { onConflict: "user_id" }) 
    .then(({ error }) => {
      if (error) console.warn("⚠️ user_profiles update failed:", error.message);
    });

  const paymentIntentId = session.payment_intent;
  let chargeId = null;

  if (paymentIntentId) {
    chargeId = await getChargeId(paymentIntentId);
  }

  await supabase
    .from("payments")
    .insert({
      user_id: userId,
      stripe_payment_intent_id: paymentIntentId || null,
      stripe_charge_id: chargeId,
      amount: session.amount_total,
      currency: session.currency,
      email: email,
      product_name: productName,
      status: "completed",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .then(({ error }) => {
      if (error) console.error("⚠️ Payment record insert failed:", error.message);
    });

  console.log(`✅ ${planType} unlocked for:`, userId);

  trackAnalytics("user_upgraded", {
    user_id: userId,
    plan: dbPlan,
    amount: session.amount_total
  });

  return {
    upgraded: true,
    user_id: userId,
    plan: dbPlan
  };
}

// ----------------------------
// ROUTES: USER & PROFILE
// ----------------------------

app.get("/user/profile", authenticateUser, async (req, res) => {
  // Disable caching for this endpoint so updates reflect immediately
  res.setHeader('Cache-Control', 'no-store');
  
  try {
    const { data, error } = await supabase
      .from("users")
      .select("id, email, plan, is_premium, is_lifetime, stripe_customer_id, subscription_status")
      .eq("id", req.user.id)
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("Error fetching profile:", err);
    res.status(500).json({ error: err.message });
  }
});

app.put("/user/profile", authenticateUser, async (req, res) => {
  try {
    const { nickname, personality, avatar_url } = req.body;
    
    const updates = {};
    if (nickname) updates.nickname = nickname;
    if (personality) updates.personality = personality;
    
    if (avatar_url) {
        await supabase.from("profiles").update({ avatar_url })
          .eq("id", req.user.id);
    }

    if (Object.keys(updates).length > 0) {
        updates.updated_at = new Date().toISOString();
        const { error } = await supabase.from("users").update(updates).eq("id", req.user.id);
        if (error) throw error;
    }
    
    const { data, error: fetchError } = await supabase
      .from("users")
      .select("id, email, plan, is_premium, is_lifetime")
      .eq("id", req.user.id)
      .single();

    if (fetchError) throw fetchError;
    res.json(data);
  } catch (err) {
    console.error("Error updating profile:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/user/settings", authenticateUser, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("user_settings")
      .select("*")
      .eq("id", req.user.id)
      .single();

    if (error && error.code === 'PGRST116') {
       return res.json({ theme: 'dark', notifications_enabled: true });
    }
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("Error fetching settings:", err);
    res.status(500).json({ error: err.message });
  }
});

app.put("/user/settings", authenticateUser, async (req, res) => {
  try {
    const { theme, notifications_enabled } = req.body;
    
    const { data, error } = await supabase
      .from("user_settings")
      .upsert({
        id: req.user.id,
        theme,
        notifications_enabled,
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("error in settings update:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/delete-account", authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;

    await logAdminAction(userId, "delete_account_self", userId);

    await supabase.from("payments").delete().eq("user_id", userId);
    await supabase.from("user_profiles").delete().eq("user_id", userId);
    await supabase.from("conversations").delete().eq("user_id", userId); 
    await supabase.from("profiles").delete().eq("id", userId);
    await supabase.from("users").delete().eq("id", userId);

    await supabase.auth.admin.deleteUser(userId);

    console.log(`🗑️ User ${userId} fully deleted`);
    res.json({ success: true });

  } catch (err) {
    console.error("❌ Delete account error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------
// ROUTES: CONVERSATIONS & CHAT
// ----------------------------

app.get("/conversations", authenticateUser, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("conversations")
      .select("*")
      .eq("user_id", req.user.id)
      .order("updated_at", { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/conversations", authenticateUser, async (req, res) => {
  try {
    const { title } = req.body;
    const { data, error } = await supabase
      .from("conversations")
      .insert({
        user_id: req.user.id,
        title: title || "New Chat",
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/conversations/:id/messages", authenticateUser, async (req, res) => {
  try {
    const { data: conv } = await supabase
      .from("conversations")
      .select("id")
      .eq("id", req.params.id)
      .eq("user_id", req.user.id)
      .single();
    
    if (!conv) return res.status(404).json({ error: "Conversation not found" });

    const { data, error } = await supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", req.params.id)
      .order("created_at", { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/conversations/:id/messages", authenticateUser, async (req, res) => {
  try {
    const { role, content, content_type, media_url, metadata } = req.body;

    const { data: conv } = await supabase
      .from("conversations")
      .select("id")
      .eq("id", req.params.id)
      .eq("user_id", req.user.id)
      .single();

    if (!conv) return res.status(404).json({ error: "Conversation not found" });

    const { data, error } = await supabase
      .from("messages")
      .insert({
        conversation_id: req.params.id,
        role,
        content,
        content_type: content_type || "text",
        media_url,
        metadata: metadata || {},
      })
      .select()
      .single();

    if (error) throw error;
    
    await supabase
      .from("conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", req.params.id);

    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/generated-media", authenticateUser, async (req, res) => {
  try {
    const { conversation_id, url, media_type, prompt } = req.body;
    
    const { data, error } = await supabase
      .from("generated_media")
      .insert({
        user_id: req.user.id,
        conversation_id,
        url,
        media_type: media_type || "image",
        prompt,
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------
// ROUTES: ADMIN
// ----------------------------

app.get("/admin/audit-logs", authenticateUser, requireAdmin, async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const { data, error } = await supabase
      .from("admin_audit_logs")
      .select("*")
      .order("created_at", { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("Admin logs error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------
// WEBHOOKS (FIXED & CONSOLIDATED)
// ----------------------------
app.post("/stripe-webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  if (!sig) return res.status(400).send("Missing signature");

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        try {
          const result = await upgradeUser(session);
          console.log("✅ Webhook: checkout.session.completed processed", result.user_id);
        } catch (err) {
          console.error("❌ Webhook upgrade failed:", err.message);
        }
        break;
      }

      case "customer.subscription.updated": {
        const subscription = event.data.object;
        try {
          const { data: user } = await supabase
            .from("users")
            .select("id")
            .eq("stripe_subscription_id", subscription.id)
            .single();

          if (user) {
            // If subscription moves to unpaid states, handle cancellation
            if (["unpaid", "incomplete_expired"].includes(subscription.status)) {
              await handleSubscriptionCancellation(user.id);
            } else {
              // Otherwise just update status
              await supabase
                .from("users")
                .update({
                  subscription_status: subscription.status,
                  current_period_end: subscription.current_period_end
                    ? new Date(subscription.current_period_end * 1000).toISOString()
                    : null,
                  updated_at: new Date().toISOString(),
                })
                .eq("id", user.id);
            }
          }
        } catch (err) {
          console.error("❌ customer.subscription.updated error:", err.message);
        }
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object;
        const customerId = subscription.customer;
        try {
          const { data: user } = await supabase
            .from("users")
            .select("id")
            .eq("stripe_customer_id", customerId)
            .single();

          if (user) {
            await handleSubscriptionCancellation(user.id);
          }
        } catch (err) {
          console.error("❌ customer.subscription.deleted error:", err.message);
        }
        break;
      }

      case "invoice.payment_succeeded": {
        const invoice = event.data.object;
        try {
          if (invoice.subscription) {
            await supabase
              .from("users")
              .update({
                subscription_status: "active",
                updated_at: new Date().toISOString(),
              })
              .eq("stripe_subscription_id", invoice.subscription);
          }

          trackAnalytics("recurring_payment_success", {
            amount: invoice.amount_paid,
            currency: invoice.currency,
            subscription_id: invoice.subscription,
          });
        } catch (err) {
          console.error("❌ invoice.payment_succeeded error:", err.message);
        }
        break;
      }

      case "charge.refunded": {
        const charge = event.data.object;
        const paymentIntentId = charge.payment_intent;
        try {
          const { data: payment } = await supabase
            .from("payments")
            .select("user_id")
            .eq("stripe_payment_intent_id", paymentIntentId)
            .single();

          if (payment && payment.user_id) {
            const { data: user } = await supabase
              .from("users")
              .select("refund_count")
              .eq("id", payment.user_id)
              .single();

            // Only reset if they haven't used their refund yet
            if (user && user.refund_count < 1) {
              await handleRefundReset(payment.user_id);
            } else {
              console.log(`ℹ️ Webhook: Refund occurred for user ${payment.user_id}, but refund count is ${user?.refund_count}. Status not reset.`);
            }
          }
        } catch (err) {
          console.error("❌ charge.refunded error:", err.message);
        }
        break;
      }

      case "customer.subscription.trial_will_end": {
        const subscription = event.data.object;
        const customerId = subscription.customer;
        try {
          const customer = await stripe.customers.retrieve(customerId);
          const email = customer.email;

          let planName = "Subscription";
          // Ensure Price IDs match your environment variables
          if (subscription.items.data[0].price.id === process.env.STRIPE_MONTHLY_PRICE_ID) planName = "Ultimate Monthly";
          else if (subscription.items.data[0].price.id === process.env.STRIPE_YEARLY_PRICE_ID) planName = "Ultimate Yearly";

          console.log(`📧 Trial ending for ${email}`);
          await sendTrialEndingEmail(email, planName, subscription.trial_end);
          trackAnalytics("trial_ending_scheduled", { email, plan: planName, ends_at: subscription.trial_end });
        } catch (err) {
          console.error("❌ trial_will_end error:", err.message);
        }
        break;
      }

      default:
        console.log(`🔔 Unhandled webhook event: ${event.type}`);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Webhook processing error:", err.message);
    res.status(500).send(`Webhook Error: ${err.message}`);
  }
});

// ----------------------------
// HEALTH CHECK
// ----------------------------
app.get("/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// ----------------------------
// ROUTES: PLAN MANAGEMENT
// ----------------------------

app.get("/user/plan", authenticateUser, async (req, res) => {
  // Disable caching for plan updates
  res.setHeader('Cache-Control', 'no-store');

  try {
    const { data, error } = await supabase
      .from("users")
      .select("plan, is_premium, is_lifetime")
      .eq("id", req.user.id)
      .single();

    if (error) {
        console.error("Error fetching plan via backend:", error);
        return res.json({ plan: "free" });
    }
    
    const planStr = (data.plan || '').toLowerCase();
    if (data.is_lifetime) return res.json({ plan: "lifetime" });
    if (data.is_premium) return res.json({ plan: planStr === 'ultimate_yearly' ? 'yearly' : 'monthly' });
    
    return res.json({ plan: planStr || "free" });

  } catch (err) {
    console.error("GET /user/plan error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/user/plan", authenticateUser, async (req, res) => {
  try {
    const { plan } = req.body;
    const userId = req.user.id;

    if (!plan) {
      return res.status(400).json({ error: "Plan is required" });
    }

    const { data: currentUser, error: fetchError } = await supabase
      .from("users")
      .select("stripe_subscription_id")
      .eq("id", userId)
      .single();

    if (fetchError) throw fetchError;

    if (plan === "free" && currentUser?.stripe_subscription_id) {
      try {
        await stripe.subscriptions.cancel(currentUser.stripe_subscription_id);
        console.log(`🚫 Stripe subscription ${currentUser.stripe_subscription_id} cancelled for user ${userId}`);
      } catch (stripeError) {
        console.error("⚠️ Failed to cancel Stripe sub, updating DB anyway:", stripeError.message);
      }
    }

    const updateData = {
      plan: plan,
      updated_at: new Date().toISOString(),
    };

    if (plan === "free") {
      updateData.is_premium = false;
      updateData.is_lifetime = false;
      updateData.subscription_status = "canceled";
      updateData.stripe_subscription_id = null;
      updateData.current_period_end = null;
    } else if (plan === "lifetime") {
      updateData.plan = "lifetime";
      updateData.is_premium = true;
      updateData.is_lifetime = true;
      updateData.stripe_subscription_id = null; 
      updateData.subscription_status = null; 
      updateData.current_period_end = null; 
    } else if (plan === "ultimate_monthly") {
      updateData.plan = "ultimate_monthly";
      updateData.is_premium = true;
      updateData.is_lifetime = false;
    } else if (plan === "ultimate_yearly") {
      updateData.plan = "ultimate_yearly";
      updateData.is_premium = true;
      updateData.is_lifetime = false;
    }

    const { error: updateError } = await supabase
      .from("users")
      .update(updateData)
      .eq("id", userId);

    if (updateError) throw updateError;

    await supabase
      .from("user_profiles")
      .update({ plan: plan === "free" ? "free" : (plan === "lifetime" ? "lifetime" : "premium") })
      .eq("user_id", userId)
      .then(({ error }) => {
        if (error) console.warn("⚠️ user_profiles update failed:", error.message);
      });

    console.log(`✅ User ${userId} plan manually updated to: ${updateData.plan}`);
    res.json({ success: true, plan: updateData.plan });

  } catch (err) {
    console.error("❌ Manual plan update error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------
// ROUTES: SESSION VERIFICATION
// ----------------------------
app.get("/verify-session", async (req, res) => {
  const { session_id } = req.query;

  if (!session_id) {
    return res.status(400).json({ error: "Missing session_id" });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);

    if (session.payment_status !== 'paid') {
      return res.status(400).json({ error: "Payment not completed" });
    }

    const userId = session.client_reference_id;
    
    if (!userId) {
      return res.status(400).json({ error: "No user associated with session" });
    }

    await upgradeUser(session);
    
    const planMap = { 'monthly': 'ultimate_monthly', 'yearly': 'ultimate_yearly', 'lifetime': 'lifetime' };
    
    return res.json({ 
      status: "success", 
      plan: planMap[session.metadata.product] || 'free' 
    });

  } catch (err) {
    console.error("❌ Verify session error:", err);
    res.status(500).json({ error: "Failed to verify session" });
  }
});

// ----------------------------
// START
// ----------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
