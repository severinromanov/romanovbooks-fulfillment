import Stripe from 'stripe';
import getRawBody from 'raw-body';
import axios from 'axios';

export const config = {
  api: {
    bodyParser: false,
  },
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  let event;

  try {
    const rawBody = await getRawBody(req);
    const signature = req.headers['stripe-signature'];

    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    try {
      await handleCheckoutSessionCompleted(session);
    } catch (err) {
      console.error('Error handling checkout session:', err);
      // still return 200 so Stripe doesn't hammer retries
    }
  }

  return res.status(200).json({ received: true });
}

async function handleCheckoutSessionCompleted(session) {
  const customerDetails = session.customer_details;
  const shippingDetails = session.shipping_details;

  if (!shippingDetails || !shippingDetails.address) {
    console.error('No shipping details on session', session.id);
    return;
  }

  // Destination address from Stripe
  const addressTo = {
    name: customerDetails?.name || '',
    street1: shippingDetails.address.line1 || '',
    street2: shippingDetails.address.line2 || '',
    city: shippingDetails.address.city || '',
    state: shippingDetails.address.state || '',
    zip: shippingDetails.address.postal_code || '',
    country: shippingDetails.address.country || 'US',
    email: customerDetails?.email || '',
  };

  // Origin address from env vars
  const addressFrom = {
    name: process.env.FROM_NAME,
    street1: process.env.FROM_STREET,
    city: process.env.FROM_CITY,
    state: process.env.FROM_STATE,
    zip: process.env.FROM_ZIP,
    country: 'US',
    email: process.env.FROM_EMAIL,
  };

  // Basic line item for the book
  const lineItems = [
    {
      title: "Annick & Luca's Adventure – The Beetle in the Blossom",
      quantity: 1,
      sku: 'BOOK-ANNICK-001',
      total_price: (session.amount_total / 100).toFixed(2), // Stripe amounts are in cents
      currency: session.currency || 'usd',
      weight: 12,
      weight_unit: 'oz',
    },
  ];

  // Create an ORDER in Shippo (no labels purchased here)
  const orderResponse = await axios.post(
    'https://api.goshippo.com/orders/',
    {
      to_address: addressTo,
      from_address: addressFrom,
      line_items: lineItems,
      order_number: session.id, // you can change this to your own internal order number
      placed_at: session.created
        ? new Date(session.created * 1000).toISOString()
        : undefined,
      currency: session.currency || 'usd',
      weight: 12,
      weight_unit: 'oz',
    },
    {
      headers: {
        Authorization: `ShippoToken ${process.env.SHIPPO_API_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const order = orderResponse.data;

  console.log('Shippo order created:', order.object_id);

  // Optional: store Shippo order ID back in Stripe metadata for cross-reference
  if (session.payment_intent) {
    await stripe.paymentIntents.update(session.payment_intent, {
      metadata: {
        shippo_order_id: order.object_id,
      },
    });
  }
}
