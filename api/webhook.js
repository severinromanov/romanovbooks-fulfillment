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
      // We still reply 200 so Stripe doesn't keep retrying forever
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

  const addressFrom = {
    name: process.env.FROM_NAME,
    street1: process.env.FROM_STREET,
    city: process.env.FROM_CITY,
    state: process.env.FROM_STATE,
    zip: process.env.FROM_ZIP,
    country: 'US',
    email: process.env.FROM_EMAIL,
  };

  // Parcel for Annick's book (adjust if needed)
  const parcel = {
    length: 9,
    width: 6,
    height: 1,
    distance_unit: 'in',
    weight: 12,
    mass_unit: 'oz',
  };

  // 1️⃣ Create shipment in Shippo
  const shipmentResponse = await axios.post(
    'https://api.goshippo.com/shipments/',
    {
      address_from: addressFrom,
      address_to: addressTo,
      parcels: [parcel],
      async: false,
    },
    {
      headers: {
        Authorization: `ShippoToken ${process.env.SHIPPO_API_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const shipment = shipmentResponse.data;

  if (!shipment.rates || shipment.rates.length === 0) {
    console.error('No rates returned by Shippo for session', session.id);
    return;
  }

  // 2️⃣ Pick the cheapest rate for now
  const cheapestRate = shipment.rates.reduce((prev, current) =>
    parseFloat(current.amount) < parseFloat(prev.amount) ? current : prev
  );

  // 3️⃣ Buy label
  const transactionResponse = await axios.post(
    'https://api.goshippo.com/transactions/',
    {
      rate: cheapestRate.object_id,
      label_file_type: 'PDF',
    },
    {
      headers: {
        Authorization: `ShippoToken ${process.env.SHIPPO_API_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const transaction = transactionResponse.data;

  if (transaction.status !== 'SUCCESS') {
    console.error('Shippo label purchase failed', transaction);
    return;
  }

  const labelUrl = transaction.label_url;
  const trackingNumber = transaction.tracking_number;
  const trackingUrl = transaction.tracking_url_provider;

  console.log('Label created:', labelUrl, trackingNumber, trackingUrl);

  // 4️⃣ Save tracking info into Stripe so you can see it on the Payment
  if (session.payment_intent) {
    await stripe.paymentIntents.update(session.payment_intent, {
      metadata: {
        shipping_label_url: labelUrl,
        tracking_number: trackingNumber,
        tracking_url: trackingUrl,
      },
    });
  }
}

