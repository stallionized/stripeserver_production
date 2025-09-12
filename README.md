# LinkBy6 Stripe Server

A Node.js Express server that handles Stripe payments and subscriptions for the LinkBy6 mobile application with **dynamic product catalog** support.

## 🚀 New Features

### Dynamic Product Catalog
- **No more hardcoded environment variables** for product prices
- **Automatic product fetching** from your Stripe account
- **Real-time updates** when products change in Stripe Dashboard
- **Intelligent caching** with 5-minute expiry
- **Webhook integration** for instant catalog updates

## Features

- **Subscription Management**: Create, update, and cancel subscriptions
- **Dynamic Product Catalog**: Automatically fetch products from Stripe
- **Payment Processing**: Handle one-time payments and recurring subscriptions
- **Webhook Handling**: Process Stripe events securely
- **Supabase Integration**: Optional database updates
- **Security**: Rate limiting, CORS, input validation
- **Logging**: Comprehensive Winston logging
- **Error Handling**: User-friendly error messages

## Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Environment Setup
Copy `.env.example` to `.env` and configure:
```bash
cp .env.example .env
```

Required environment variables:
- `STRIPE_SECRET_KEY`: Your Stripe secret key
- `STRIPE_WEBHOOK_SECRET`: Your webhook endpoint secret

### 3. Set Up Products in Stripe Dashboard
Follow the [Stripe Setup Guide](./STRIPE_SETUP_GUIDE.md) to configure your products with proper metadata.

### 4. Start the Server
```bash
# Development
npm run dev

# Production
npm start
```

## API Endpoints

### Product Catalog
- `GET /products` - Get all available products
- `GET /products/:planId` - Get specific product details
- `POST /refresh-catalog` - Manually refresh product catalog
- `GET /price-ids` - Get current price mappings (debug)

### Subscriptions
- `POST /create-subscription` - Create a new subscription
- `POST /cancel-subscription` - Cancel a subscription
- `GET /subscription/:subscriptionId` - Get subscription details

### Payments
- `POST /create-payment-intent` - Create payment intent for platform payments

### System
- `GET /health` - Health check with cache status
- `POST /webhook` - Stripe webhook handler

### Testing & Status
- `GET /payment-status/:userId` - Get payment and business profile status with user-friendly messages
- `POST /test-payment-complete` - Simulate payment completion for testing (success/failure)

## Dynamic Product Catalog

### How It Works
1. Server fetches all active products and prices from Stripe on startup
2. Products are organized using metadata fields (`plan_id`, `display_order`, etc.)
3. Cache is automatically refreshed every 5 minutes or via webhooks
4. Mobile app fetches product catalog via `/products` endpoint

### Product Metadata Fields
Configure these in your Stripe Dashboard:

- **`plan_id`** (required): Unique identifier (e.g., "essential", "growth")
- **`display_order`** (required): Display order (1, 2, 3...)
- **`plan_type`** (optional): Plan type (default: "subscription")
- **`features`** (optional): JSON array of features

### Example Usage
```javascript
// Fetch products
const response = await fetch('/products');
const { products } = await response.json();

// Find specific plan
const essentialPlan = products.find(p => p.planId === 'essential');
const monthlyPrice = essentialPlan.prices.monthly.priceId;
```

## Migration from Environment Variables

If you're upgrading from the old system:

1. ✅ Set up products in Stripe Dashboard with metadata
2. ✅ Remove old `STRIPE_PRICE_*` environment variables
3. ✅ Update mobile app to use `/products` endpoint
4. ✅ Deploy updated server

## Webhook Events

The server handles these Stripe events:
- `customer.subscription.*` - Subscription lifecycle
- `invoice.payment_*` - Payment events
- `product.*` - Product changes (auto-refreshes catalog)
- `price.*` - Price changes (auto-refreshes catalog)

## Security Features

- **Rate Limiting**: 100 requests per 15 minutes per IP
- **CORS Protection**: Configurable allowed origins
- **Input Validation**: Express-validator for all endpoints
- **Helmet**: Security headers
- **Webhook Verification**: Stripe signature validation

## Logging

Winston logging with multiple levels:
- **Error logs**: `error.log`
- **Combined logs**: `combined.log`
- **Console output**: Colorized for development

## Error Handling

- User-friendly error messages
- Stripe-specific error handling
- Graceful fallbacks for non-critical failures
- Comprehensive error logging

## Deployment

### Render.com (Recommended)
```bash
# Build command
npm install

# Start command
npm start
```

### Environment Variables for Production
```
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
NODE_ENV=production
PORT=3000
```

**Optional Variables:**
```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=eyJ...
LOG_LEVEL=info
ALLOWED_ORIGINS=https://your-app.com  # Only if you need to restrict origins
```

## Development

### File Structure
```
stripe-server/
├── server.js                 # Main server file
├── package.json              # Dependencies
├── .env.example              # Environment template
├── README.md                 # This file
├── STRIPE_SETUP_GUIDE.md     # Product setup guide
└── server_backup_*.js        # Backup files
```

### Key Classes
- **`ProductCatalogService`**: Manages dynamic product fetching and caching
- **Webhook handlers**: Process Stripe events
- **Validation middleware**: Input validation and sanitization

## Troubleshooting

### Product Catalog Issues
- Check `/health` endpoint for cache status
- Use `/refresh-catalog` to manually refresh
- Verify products are active in Stripe Dashboard
- Ensure metadata fields are set correctly

### Common Errors
- **Invalid price ID**: Product not found in catalog
- **Webhook verification failed**: Check webhook secret
- **Rate limit exceeded**: Implement client-side rate limiting

## Support

For issues related to:
- **Stripe integration**: Check Stripe Dashboard and logs
- **Product catalog**: See [Stripe Setup Guide](./STRIPE_SETUP_GUIDE.md)
- **Server errors**: Check Winston logs
- **Mobile app integration**: Verify API endpoint responses

## License

MIT License - see LICENSE file for details.
