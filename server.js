require("dotenv").config();

const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const admin = require("firebase-admin");
const { Resend } = require("resend");
const resend = new Resend(process.env.RESEND_API_KEY);


const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);


app.use(
  cors({
    origin: "http://localhost:3000",
  })
);

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});

const db = admin.firestore();

const PRICE_IDS = {
  access_code: "price_1TGNI5GX3WHSpRg06f74PoKS",
  tattoos_8: "price_1TGNJCGX3WHSpRg0MtaBwj3p",
  tattoos_16: "price_1TGNJmGX3WHSpRg0ed4fVuYH",
};

const SHIPPING_RATE_ID = "shr_1TG2GPGX3WHSpRg0HH8HgDOT";

app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (error) {
      console.error("Webhook signature verification failed:", error.message);
      return res.status(400).send(`Webhook Error: ${error.message}`);
    }

    try {
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;

        if (session.payment_status === "paid") {
          await fulfillOrder(session);
        }
      }

      res.json({ received: true });
    } catch (error) {
      console.error("Webhook handler failed:", error.message);
      res.status(500).send("Webhook handler failed");
    }
  }
);

app.use(express.json());

function generateAccessCode(length = 10) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";

  for (let i = 0; i < length; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }

  return code;
}

async function sendAccessCodeEmail(toEmail, accessCode) {
  try {
    const { data, error } = await resend.emails.send({
      from: process.env.EMAIL_FROM,
      to: toEmail,
      subject: "Your Safrly Access Code",
      html: `
        <div style="margin:0; padding:0; background-color:#f9f4f7; font-family:Arial, sans-serif; color:#333;">
          <div style="max-width:600px; margin:0 auto; background:#ffffff; border-radius:12px; overflow:hidden; box-shadow:0 4px 14px rgba(0,0,0,0.08);">
            
            <div style="background:#f7b6d2; padding:32px 24px; text-align:center;">
              <h1 style="margin:0; font-size:28px; color:#4a2142;">The Pink Collective</h1>
              <p style="margin:8px 0 0; font-size:16px; color:#4a2142;">Your Safrly Access Code</p>
            </div>

            <div style="padding:32px 24px;">
              <p style="font-size:16px; margin-top:0;">
                Thank you for your purchase!
              </p>

              <p style="font-size:16px; line-height:1.6;">
                Your Safrly access code is below. You’ll use this one-time code to create your parent portal account.
              </p>

              <div style="margin:28px 0; padding:20px; background:#fff0f6; border:2px dashed #f06292; border-radius:12px; text-align:center;">
                <p style="margin:0 0 10px; font-size:14px; color:#7a4b67;">Your Access Code</p>
                <div style="font-size:30px; font-weight:bold; letter-spacing:3px; color:#c2185b;">
                  ${accessCode}
                </div>
              </div>

              <p style="font-size:15px; line-height:1.6;">
                This code can only be used <strong>once</strong>. Please keep it in a safe place until you create your account.
              </p>

              <div style="text-align:center; margin:32px 0;">
                <a
                  href="https://safrly.thepinkcollective.org/edit"
                  style="display:inline-block; background:#ec4899; color:#ffffff; text-decoration:none; padding:14px 24px; border-radius:999px; font-weight:bold; font-size:15px;"
                >
                  Create Your Account
                </a>
              </div>

              <p style="font-size:14px; line-height:1.6; color:#555;">
                If you have any questions about your order, please contact us at
                <a href="mailto:orders@thepinkcollective.org" style="color:#c2185b;"> orders@thepinkcollective.org</a>.
              </p>

              <p style="font-size:14px; line-height:1.6; color:#555; margin-bottom:0;">
                Thank you,<br />
                <strong>The Pink Collective</strong>
              </p>
            </div>
          </div>
        </div>
      `,
    });

    if (error) {
      console.error("Resend error:", error);
      return;
    }

    console.log("Access code email sent:", data);
  } catch (error) {
    console.error("Error sending access code email:", error.message);
  }
}

async function fulfillOrder(session) {
  console.log("=== PAYMENT RECEIVED ===");
  console.log("Session ID:", session.id);
  console.log("Customer email:", session.customer_details?.email || "No email");

  const customerEmail = session.customer_details?.email || null;

  const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
    limit: 100,
  });

  console.log("Items purchased:");
  lineItems.data.forEach((item) => {
    console.log(`- ${item.description} x${item.quantity}`);
  });

  const shippingDetails =
    session.collected_information?.shipping_details || null;

  // ----------------------------
  // ACCESS CODE FULFILLMENT
  // ----------------------------
  const accessCodeItem = lineItems.data.find(
    (item) => item.description === "Safrly Access Code"
  );

  if (accessCodeItem) {
    for (let i = 0; i < accessCodeItem.quantity; i++) {
      const accessCode = generateAccessCode();

      await db.collection("accessCodes").add({
        code: accessCode,
        email: customerEmail,
        stripeSessionId: session.id,
        createdAt: new Date().toISOString(),
        used: false,
      });

      console.log("Generated and saved access code:", accessCode);

      if (customerEmail) {
        await sendAccessCodeEmail(customerEmail, accessCode);
      }
    }
  }

  // ----------------------------
  // TATTOO ORDER FULFILLMENT
  // ----------------------------
  const tattooItems = lineItems.data.filter((item) =>
    item.description.includes("Tattoos")
  );

  if (tattooItems.length > 0) {
    const orderRef = await db.collection("tattooOrders").add({
      stripeSessionId: session.id,
      email: customerEmail,
      createdAt: new Date().toISOString(),
      status: "paid",
      items: tattooItems.map((item) => ({
        description: item.description,
        quantity: item.quantity,
      })),
      shippingDetails: shippingDetails,
    });

    console.log("Saved tattoo order to Firestore.");
    console.log("Tattoo order document ID:", orderRef.id);
  }

  if (shippingDetails) {
    console.log("Shipping details:", shippingDetails);
  }

  console.log("========================");
}

app.get("/", (req, res) => {
  res.send("Server is running!");
});

app.get("/test-stripe", async (req, res) => {
  try {
    const balance = await stripe.balance.retrieve();
    res.json({
      message: "Stripe connected successfully!",
      balance: balance,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/test-checkout", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price: PRICE_IDS.access_code,
          quantity: 1,
        },
      ],
      success_url: "http://localhost:3000/success",
      cancel_url: "http://localhost:3000",
    });

    res.redirect(session.url);
  } catch (error) {
    console.error(error);
    res.status(500).send(error.message);
  }
});

app.post("/create-checkout-session", async (req, res) => {
  try {
    const { items } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Cart is empty" });
    }

    const lineItems = items.map((item) => {
      let price;

      if (item.productType === "access_code") {
        price = PRICE_IDS.access_code;
      } else if (item.productType === "tattoos_8") {
        price = PRICE_IDS.tattoos_8;
      } else if (item.productType === "tattoos_16") {
        price = PRICE_IDS.tattoos_16;
      } else {
        throw new Error(`Invalid product type: ${item.productType}`);
      }

      return {
        price,
        quantity: item.quantity || 1,
      };
    });

    const hasPhysicalItems = items.some(
      (item) =>
        item.productType === "tattoos_8" || item.productType === "tattoos_16"
    );

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: lineItems,
      success_url: "http://localhost:3000/success",
      cancel_url: "http://localhost:3000/parents",
      automatic_tax: { enabled: true },

      ...(hasPhysicalItems && {
        shipping_address_collection: {
          allowed_countries: ["US"],
        },
        shipping_options: [
          {
            shipping_rate: SHIPPING_RATE_ID,
          },
        ],
      }),
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error("Checkout error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/create-account-with-code", async (req, res) => {
  try {
    const { email, password, accessCode } = req.body;

    if (!email || !password || !accessCode) {
      return res.status(400).json({
        error: "Email, password, and access code are required.",
      });
    }

    const codeQuery = await db
      .collection("accessCodes")
      .where("code", "==", accessCode.trim().toUpperCase())
      .limit(1)
      .get();

    if (codeQuery.empty) {
      return res.status(400).json({
        error: "Invalid access code.",
      });
    }

    const codeDoc = codeQuery.docs[0];
    const codeData = codeDoc.data();

    if (codeData.used) {
      return res.status(400).json({
        error: "This access code has already been used.",
      });
    }

    const userRecord = await admin.auth().createUser({
      email,
      password,
    });

    await codeDoc.ref.update({
      used: true,
      usedAt: new Date().toISOString(),
      usedByUid: userRecord.uid,
      usedByEmail: email,
    });

    res.json({
      success: true,
      uid: userRecord.uid,
      message: "Account created successfully.",
    });
  } catch (error) {
    console.error("Account creation error:", error);
    res.status(500).json({
      error: error.message || "Failed to create account.",
    });
  }
});

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(
    "Stripe key loaded:",
    process.env.STRIPE_SECRET_KEY ? "YES" : "NO"
  );
});