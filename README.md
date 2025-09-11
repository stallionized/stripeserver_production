# LinkBy6 Stripe Server

A comprehensive Stripe payment server for the LinkBy6 mobile application, designed to handle subscriptions, payments, and business profile activation.

## Features

- ✅ **Subscription Management**: Create, update, and cancel subscriptions
- ✅ **Payment Processing**: Support for card payments and platform payments (Apple Pay/Google Pay)
- ✅ **Customer Management**: Automatic customer creation and retrieval
- ✅ **Webhook Handling**: Real-time subscription status updates
- ✅ **Supabase Integration**: Optional database synchronization
- ✅ **Production Ready**: Comprehensive logging, error handling, and security
- ✅ **Render.com Optimized**: Ready for deployment with health checks

## API Endpoints

### Core Endpoints

- `GET /health` - Health check endpoint
- `GET /price-ids` - Get configured price IDs (for debugging)
- `POST /create-subscription` - Create a new subscription
- `POST /create-payment-intent` - Create payment intent for platform payments
- `POST /cancel-subscription` - Cancel a subscription
- `GET /subscription/:subscriptionId` - Get subscription details
- `POST /webhook` - Stripe webhook handler

### Subscription Plans

The server supports three subscription tiers:

1. **Essential**: $49/month or $499/year
2. **Growth**: $99/month or $999/year  
3. **Pro/Enterprise**: $199/month or $1999/year

## Setup Instructions

### 1. Prerequisites

- Node.js 18+ installed
- Stripe account with test/live keys
- Render.com account (for deployment)
- Supabase project (optional, for database integration)

### 2. Stripe Dashboard Setup

#### Create Products and Prices

1. Go to your [Stripe Dashboard](https://dashboard.stripe.com/products)
2. Create three products:
   - **Essential Plan**
   - **Growth Plan** 
   - **Pro/Enterprise Plan**

3. For each product, create two prices:
   - Monthly recurring price
   - Yearly recurring price

4. Copy the Price IDs (they start with `price_`) - you'll need these for configuration.

#### Create Webhook Endpoint

1. Go to [Stripe Webhooks](https://dashboard.stripe.com/webhooks)
2. Click "Add endpoint"
3. Set endpoint URL to: `https://your-render-app.onrender.com/webhook`
4. Select these events:
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_succeeded`
   - `invoice.payment_failed`
5. Copy the webhook signing secret (starts with `whsec_`)

### 3. Local Development

```bash
# Clone or create the server directory
cd stripe-server

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env with your actual values
nano .env
```

#### Environment Variables

Update your `.env` file with actual values:

```env
# Your Stripe secret key (starts with sk_test_ or sk_live_)
STRIPE_SECRET_KEY=sk_test_51RXw4A4RjCM7xxHp...

# Your webhook secret (starts with whsec_)
STRIPE_WEBHOOK_SECRET=whsec_...

# Your actual Stripe Price IDs
STRIPE_PRICE_ESSENTIAL_MONTHLY=price_1234567890abcdef
STRIPE_PRICE_ESSENTIAL_YEARLY=price_1234567890abcdef
STRIPE_PRICE_GROWTH_MONTHLY=price_1234567890abcdef
STRIPE_PRICE_GROWTH_YEARLY=price_1234567890abcdef
STRIPE_PRICE_PRO_MONTHLY=price_1234567890abcdef
STRIPE_PRICE_PRO_YEARLY=price_1234567890abcdef

# Optional: Supabase integration
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=eyJ...

# Server configuration
NODE_ENV=development
PORT=3000
LOG_LEVEL=info
```

#### Start Development Server

```bash
# Start with auto-reload
npm run dev

# Or start normally
npm start
```

The server will be available at `http://localhost:3000`

### 4. Deploy to Render.com

#### Option A: Connect GitHub Repository

1. Push your code to a GitHub repository
2. Go to [Render Dashboard](https://dashboard.render.com)
3. Click "New +" → "Web Service"
4. Connect your GitHub repository
5. Configure:
   - **Name**: `linkby6-stripe-server`
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Health Check Path**: `/health`

#### Option B: Manual Deploy

1. Create a new Web Service on Render
2. Upload your code as a ZIP file
3. Use the same configuration as above

#### Environment Variables on Render

In your Render service settings, add these environment variables:

```
NODE_ENV=production
PORT=3000
LOG_LEVEL=info
STRIPE_SECRET_KEY=sk_test_51RXw4A4RjCM7xxHp...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_ESSENTIAL_MONTHLY=price_...
STRIPE_PRICE_ESSENTIAL_YEARLY=price_...
STRIPE_PRICE_GROWTH_MONTHLY=price_...
STRIPE_PRICE_GROWTH_YEARLY=price_...
STRIPE_PRICE_PRO_MONTHLY=price_...
STRIPE_PRICE_PRO_YEARLY=price_...
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=eyJ...
ALLOWED_ORIGINS=*
```

### 5. Update Mobile App

Update your mobile app's `billingscreen.js` to use the actual Stripe Price IDs:

```javascript
// Replace the placeholder price IDs with your actual ones
const STRIPE_PRICE_IDS = {
  essential: {
    monthly: 'price_your_actual_essential_monthly_id',
    yearly: 'price_your_actual_essential_yearly_id',
  },
  growth: {
    monthly: 'price_your_actual_growth_monthly_id',
    yearly: 'price_your_actual_growth_yearly_id',
  },
  'pro-enterprise': {
    monthly: 'price_your_actual_pro_monthly_id',
    yearly: 'price_your_actual_pro_yearly_id',
  },
};
```

Also update the server URL if needed:

```javascript
const STRIPE_SERVER_URL = 'https://your-render-app.onrender.com';
```

## Testing

### Test the Health Endpoint

```bash
curl https://your-render-app.onrender.com/health
```

Expected response:
```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "version": "1.0.0",
  "environment": "production"
}
```

### Test Price IDs Endpoint

```bash
curl https://your-render-app.onrender.com/price-ids
```

This will show your configured price IDs.

### Test Subscription Creation

Use your mobile app to test the full payment flow, or use a tool like Postman to test the API directly.

## Webhook Testing

### Local Testing with Stripe CLI

1. Install [Stripe CLI](https://stripe.com/docs/stripe-cli)
2. Login: `stripe login`
3. Forward webhooks: `stripe listen --forward-to localhost:3000/webhook`
4. Use the webhook secret provided by the CLI in your `.env` file

### Production Webhook Testing

1. Use Stripe Dashboard webhook logs to verify events are being received
2. Check your Render logs for webhook processing

## Monitoring and Logs

### Render Logs

View logs in your Render dashboard under "Logs" tab.

### Log Levels

- `error`: Critical errors
- `warn`: Warnings and non-critical issues  
- `info`: General information (default)
- `debug`: Detailed debugging information

Set `LOG_LEVEL=debug` for more verbose logging during development.

## Security Features

- **Helmet**: Security headers
- **CORS**: Cross-origin request protection
- **Rate Limiting**: Prevents abuse
- **Input Validation**: Validates all request data
- **Webhook Signature Verification**: Ensures webhooks are from Stripe

## Troubleshooting

### Common Issues

1. **"Invalid price ID" error**
   - Verify your price IDs in Stripe Dashboard
   - Ensure environment variables are set correctly
   - Check that price IDs match between mobile app and server

2. **Webhook signature verification failed**
   - Verify webhook secret is correct
   - Ensure webhook endpoint URL is correct in Stripe Dashboard

3. **Supabase connection issues**
   - Verify Supabase URL and service key
   - Check that `business_profiles` table exists
   - Ensure service key has proper permissions

4. **Mobile app can't connect to server**
   - Verify server URL in mobile app
   - Check CORS configuration
   - Ensure server is deployed and healthy

### Debug Mode

Set `LOG_LEVEL=debug` and `NODE_ENV=development` for detailed logging.

## Support

For issues related to:
- **Stripe Integration**: Check [Stripe Documentation](https://stripe.com/docs)
- **Render Deployment**: Check [Render Documentation](https://render.com/docs)
- **Supabase Integration**: Check [Supabase Documentation](https://supabase.com/docs)

## License

MIT License - see LICENSE file for details.
