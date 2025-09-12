const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const winston = require('winston');
require('dotenv').config();

// Initialize Stripe
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Initialize Supabase (optional - for server-side database updates)
const { createClient } = require('@supabase/supabase-js');
const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY 
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null;

const app = express();
const PORT = process.env.PORT || 3000;

// Configure Winston Logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'linkby6-stripe-server' },
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

// Stripe Price IDs Configuration
const STRIPE_PRICE_IDS = {
  essential: {
    monthly: process.env.STRIPE_PRICE_ESSENTIAL_MONTHLY || 'price_essential_monthly',
    yearly: process.env.STRIPE_PRICE_ESSENTIAL_YEARLY || 'price_essential_yearly',
  },
  growth: {
    monthly: process.env.STRIPE_PRICE_GROWTH_MONTHLY || 'price_growth_monthly',
    yearly: process.env.STRIPE_PRICE_GROWTH_YEARLY || 'price_growth_yearly',
  },
  'pro-enterprise': {
    monthly: process.env.STRIPE_PRICE_PRO_MONTHLY || 'price_pro_monthly',
    yearly: process.env.STRIPE_PRICE_PRO_YEARLY || 'price_pro_yearly',
  },
};

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
  credentials: true
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Webhook endpoint (before express.json middleware)
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!endpointSecret) {
    logger.warn('Webhook endpoint secret not configured');
    return res.status(400).send('Webhook endpoint secret not configured');
  }

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    logger.info(`Webhook received: ${event.type}`);
  } catch (err) {
    logger.error(`Webhook signature verification failed: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    await handleWebhookEvent(event);
    res.json({ received: true });
  } catch (error) {
    logger.error('Webhook handler error:', error);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
});

// JSON middleware (after webhook endpoint)
app.use(express.json({ limit: '10mb' }));

// Request logging middleware
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`, {
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    body: req.method === 'POST' ? req.body : undefined
  });
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development'
  });
});

// Get available price IDs (for debugging)
app.get('/price-ids', (req, res) => {
  res.json({
    priceIds: STRIPE_PRICE_IDS,
    environment: process.env.NODE_ENV || 'development'
  });
});

// Create or retrieve customer
async function createOrRetrieveCustomer(email, userId = null) {
  try {
    // First, try to find existing customer by email
    const existingCustomers = await stripe.customers.list({
      email: email,
      limit: 1
    });

    if (existingCustomers.data.length > 0) {
      const customer = existingCustomers.data[0];
      logger.info(`Found existing customer: ${customer.id} for email: ${email}`);
      return customer;
    }

    // Create new customer
    const customerData = {
      email: email,
      metadata: {}
    };

    if (userId) {
      customerData.metadata.userId = userId;
    }

    const customer = await stripe.customers.create(customerData);
    logger.info(`Created new customer: ${customer.id} for email: ${email}`);
    return customer;

  } catch (error) {
    logger.error('Error creating/retrieving customer:', error);
    throw new Error(`Failed to create or retrieve customer: ${error.message}`);
  }
}

// Create subscription endpoint
app.post('/create-subscription', [
  body('email').isEmail().normalizeEmail(),
  body('paymentMethodId').isString().notEmpty(),
  body('priceId').isString().notEmpty(),
  body('userId').optional().isString(),
  body('planId').isString().notEmpty(),
  body('planName').isString().notEmpty(),
  body('billingCycle').isIn(['monthly', 'yearly'])
], async (req, res) => {
  try {
    // Validate input
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn('Validation errors in create-subscription:', errors.array());
      return res.status(400).json({
        error: 'Invalid input data',
        details: errors.array()
      });
    }

    const {
      email,
      paymentMethodId,
      priceId,
      userId,
      planId,
      planName,
      billingCycle,
      createCustomerIfNeeded = true
    } = req.body;

    logger.info(`Creating subscription for ${email} with plan ${planId} (${billingCycle})`);

    // Validate price ID exists in our configuration
    const validPriceId = STRIPE_PRICE_IDS[planId]?.[billingCycle];
    if (!validPriceId || validPriceId !== priceId) {
      logger.warn(`Invalid price ID: ${priceId} for plan ${planId} (${billingCycle})`);
      return res.status(400).json({
        error: 'Invalid price ID for the selected plan'
      });
    }

    // Create or retrieve customer
    const customer = await createOrRetrieveCustomer(email, userId);

    // Attach payment method to customer
    await stripe.paymentMethods.attach(paymentMethodId, {
      customer: customer.id,
    });

    // Set as default payment method
    await stripe.customers.update(customer.id, {
      invoice_settings: {
        default_payment_method: paymentMethodId,
      },
    });

    // Create subscription
    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{
        price: priceId,
      }],
      payment_behavior: 'default_incomplete',
      payment_settings: {
        save_default_payment_method: 'on_subscription',
      },
      expand: ['latest_invoice.payment_intent'],
      metadata: {
        userId: userId || '',
        planId: planId,
        planName: planName,
        billingCycle: billingCycle,
        source: 'mobile_app'
      }
    });

    logger.info(`Subscription created: ${subscription.id} for customer: ${customer.id}`);

    // Update Supabase if configured
    if (supabase && userId) {
      try {
        await updateSupabaseProfile(userId, {
          stripe_customer_id: customer.id,
          subscription_id: subscription.id,
          subscription_status: subscription.status,
          plan_id: planId,
          plan_name: planName,
          billing_cycle: billingCycle
        });
        logger.info(`Updated Supabase profile for user: ${userId}`);
      } catch (dbError) {
        logger.warn('Failed to update Supabase profile:', dbError);
        // Don't fail the request if database update fails
      }
    }

    const response = {
      subscriptionId: subscription.id,
      customerId: customer.id,
      status: subscription.status,
      clientSecret: subscription.latest_invoice?.payment_intent?.client_secret,
      planId: planId,
      planName: planName,
      billingCycle: billingCycle
    };

    // Only include client secret if payment requires action
    if (subscription.status === 'incomplete') {
      response.requiresAction = true;
    }

    res.json(response);

  } catch (error) {
    logger.error('Error creating subscription:', error);
    
    // Provide user-friendly error messages
    let errorMessage = 'Failed to create subscription';
    
    if (error.type === 'StripeCardError') {
      errorMessage = error.message;
    } else if (error.type === 'StripeInvalidRequestError') {
      errorMessage = 'Invalid payment information provided';
    } else if (error.message.includes('customer')) {
      errorMessage = 'Failed to process customer information';
    }

    res.status(500).json({
      error: errorMessage,
      type: error.type || 'server_error'
    });
  }
});

// Create payment intent for platform payments (Apple Pay/Google Pay)
app.post('/create-payment-intent', [
  body('amount').isInt({ min: 50 }), // Minimum $0.50
  body('currency').isIn(['usd']),
  body('email').isEmail().normalizeEmail(),
  body('userId').optional().isString(),
  body('planId').isString().notEmpty(),
  body('planName').isString().notEmpty(),
  body('billingCycle').isIn(['monthly', 'yearly'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Invalid input data',
        details: errors.array()
      });
    }

    const {
      amount,
      currency,
      email,
      userId,
      planId,
      planName,
      billingCycle
    } = req.body;

    logger.info(`Creating payment intent for ${email} - Amount: ${amount} ${currency}`);

    // Create or retrieve customer
    const customer = await createOrRetrieveCustomer(email, userId);

    // Create payment intent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount,
      currency: currency,
      customer: customer.id,
      setup_future_usage: 'off_session',
      metadata: {
        userId: userId || '',
        planId: planId,
        planName: planName,
        billingCycle: billingCycle,
        source: 'mobile_app_platform_pay'
      }
    });

    logger.info(`Payment intent created: ${paymentIntent.id}`);

    res.json({
      clientSecret: paymentIntent.client_secret,
      customerId: customer.id,
      paymentIntentId: paymentIntent.id
    });

  } catch (error) {
    logger.error('Error creating payment intent:', error);
    res.status(500).json({
      error: 'Failed to create payment intent',
      type: error.type || 'server_error'
    });
  }
});

// Cancel subscription endpoint
app.post('/cancel-subscription', [
  body('subscriptionId').isString().notEmpty(),
  body('userId').optional().isString()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Invalid input data',
        details: errors.array()
      });
    }

    const { subscriptionId, userId } = req.body;

    logger.info(`Canceling subscription: ${subscriptionId}`);

    const subscription = await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true
    });

    // Update Supabase if configured
    if (supabase && userId) {
      try {
        await updateSupabaseProfile(userId, {
          subscription_status: 'canceled'
        });
      } catch (dbError) {
        logger.warn('Failed to update Supabase profile:', dbError);
      }
    }

    res.json({
      subscriptionId: subscription.id,
      status: subscription.status,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      currentPeriodEnd: subscription.current_period_end
    });

  } catch (error) {
    logger.error('Error canceling subscription:', error);
    res.status(500).json({
      error: 'Failed to cancel subscription',
      type: error.type || 'server_error'
    });
  }
});

// Get subscription details
app.get('/subscription/:subscriptionId', async (req, res) => {
  try {
    const { subscriptionId } = req.params;

    const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['default_payment_method', 'items.data.price.product']
    });

    res.json({
      id: subscription.id,
      status: subscription.status,
      currentPeriodStart: subscription.current_period_start,
      currentPeriodEnd: subscription.current_period_end,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      items: subscription.items.data.map(item => ({
        id: item.id,
        priceId: item.price.id,
        productName: item.price.product.name,
        unitAmount: item.price.unit_amount,
        currency: item.price.currency,
        interval: item.price.recurring.interval
      }))
    });

  } catch (error) {
    logger.error('Error retrieving subscription:', error);
    res.status(500).json({
      error: 'Failed to retrieve subscription',
      type: error.type || 'server_error'
    });
  }
});

// Webhook event handler
async function handleWebhookEvent(event) {
  switch (event.type) {
    case 'customer.subscription.created':
      logger.info(`Subscription created: ${event.data.object.id}`);
      await handleSubscriptionCreated(event.data.object);
      break;

    case 'customer.subscription.updated':
      logger.info(`Subscription updated: ${event.data.object.id}`);
      await handleSubscriptionUpdated(event.data.object);
      break;

    case 'customer.subscription.deleted':
      logger.info(`Subscription deleted: ${event.data.object.id}`);
      await handleSubscriptionDeleted(event.data.object);
      break;

    case 'invoice.payment_succeeded':
      logger.info(`Payment succeeded for invoice: ${event.data.object.id}`);
      await handlePaymentSucceeded(event.data.object);
      break;

    case 'invoice.payment_failed':
      logger.info(`Payment failed for invoice: ${event.data.object.id}`);
      await handlePaymentFailed(event.data.object);
      break;

    default:
      logger.info(`Unhandled event type: ${event.type}`);
  }
}

// Webhook handlers
async function handleSubscriptionCreated(subscription) {
  if (supabase && subscription.metadata.userId) {
    try {
      await updateSupabaseProfile(subscription.metadata.userId, {
        subscription_status: subscription.status,
        subscription_id: subscription.id
      });
    } catch (error) {
      logger.error('Error updating profile on subscription created:', error);
    }
  }
}

async function handleSubscriptionUpdated(subscription) {
  if (supabase && subscription.metadata.userId) {
    try {
      await updateSupabaseProfile(subscription.metadata.userId, {
        subscription_status: subscription.status
      });
    } catch (error) {
      logger.error('Error updating profile on subscription updated:', error);
    }
  }
}

async function handleSubscriptionDeleted(subscription) {
  if (supabase && subscription.metadata.userId) {
    try {
      await updateSupabaseProfile(subscription.metadata.userId, {
        subscription_status: 'canceled',
        subscription_id: null
      });
    } catch (error) {
      logger.error('Error updating profile on subscription deleted:', error);
    }
  }
}

async function handlePaymentSucceeded(invoice) {
  if (supabase && invoice.subscription) {
    try {
      const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
      if (subscription.metadata.userId) {
        await updateSupabaseProfile(subscription.metadata.userId, {
          subscription_status: 'active'
        });
      }
    } catch (error) {
      logger.error('Error updating profile on payment succeeded:', error);
    }
  }
}

async function handlePaymentFailed(invoice) {
  if (supabase && invoice.subscription) {
    try {
      const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
      if (subscription.metadata.userId) {
        await updateSupabaseProfile(subscription.metadata.userId, {
          subscription_status: 'past_due'
        });
      }
    } catch (error) {
      logger.error('Error updating profile on payment failed:', error);
    }
  }
}

// Supabase helper function
async function updateSupabaseProfile(userId, updates) {
  if (!supabase) {
    logger.warn('Supabase not configured, skipping profile update');
    return;
  }

  const { error } = await supabase
    .from('business_profiles')
    .upsert({
      user_id: userId,
      ...updates,
      updated_at: new Date().toISOString()
    });

  if (error) {
    throw new Error(`Supabase update failed: ${error.message}`);
  }
}

// Error handling middleware
app.use((error, req, res, next) => {
  logger.error('Unhandled error:', error);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    path: req.path,
    method: req.method
  });
});

// Start server
app.listen(PORT, () => {
  logger.info(`LinkBy6 Stripe Server running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
  logger.info(`Supabase integration: ${supabase ? 'enabled' : 'disabled'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  process.exit(0);
});
