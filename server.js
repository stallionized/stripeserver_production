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

// Dynamic Product Catalog Cache
let productCatalogCache = {
  products: [],
  prices: {},
  lastUpdated: null,
  cacheExpiry: 5 * 60 * 1000 // 5 minutes
};

// Dynamic Product Catalog Service
class ProductCatalogService {
  static async fetchProducts() {
    try {
      logger.info('Fetching products from Stripe...');
      
      // Fetch all active products
      const products = await stripe.products.list({
        active: true,
        expand: ['data.default_price']
      });

      // Fetch all active prices
      const prices = await stripe.prices.list({
        active: true,
        expand: ['data.product']
      });

      // Organize products and prices
      const organizedCatalog = this.organizeProductCatalog(products.data, prices.data);
      
      // Update cache
      productCatalogCache = {
        products: organizedCatalog.products,
        prices: organizedCatalog.prices,
        lastUpdated: Date.now(),
        cacheExpiry: 5 * 60 * 1000
      };

      logger.info(`Successfully cached ${organizedCatalog.products.length} products with ${Object.keys(organizedCatalog.prices).length} price variations`);
      
      return productCatalogCache;
    } catch (error) {
      logger.error('Error fetching products from Stripe:', error);
      throw error;
    }
  }

  static organizeProductCatalog(products, prices) {
    const organizedProducts = [];
    const organizedPrices = {};

    logger.info('Organizing product catalog...');
    logger.info(`Processing ${products.length} products and ${prices.length} prices`);

    // Process each product
    products.forEach(product => {
      // Get product metadata for organization
      const planId = product.metadata.plan_id || product.name.toLowerCase().replace(/\s+/g, '-');
      const planType = product.metadata.plan_type || 'subscription';
      const displayOrder = parseInt(product.metadata.display_order) || 999;

      logger.info(`Processing product: ${product.name} (${product.id}) -> planId: ${planId}`);

      // Find all prices for this product
      const productPrices = prices.filter(price => price.product === product.id);
      logger.info(`Found ${productPrices.length} prices for product ${product.name}`);
      
      const priceVariations = {};
      productPrices.forEach(price => {
        logger.info(`Processing price: ${price.id}, recurring: ${!!price.recurring}`);
        
        if (price.recurring) {
          const interval = price.recurring.interval; // 'month' or 'year'
          const intervalKey = interval === 'month' ? 'monthly' : 'yearly';
          
          logger.info(`Mapping interval '${interval}' to key '${intervalKey}'`);
          
          priceVariations[intervalKey] = {
            priceId: price.id,
            unitAmount: price.unit_amount,
            currency: price.currency,
            interval: price.recurring.interval,
            intervalCount: price.recurring.interval_count
          };
        } else {
          // One-time payment
          priceVariations['one_time'] = {
            priceId: price.id,
            unitAmount: price.unit_amount,
            currency: price.currency
          };
        }
      });

      logger.info(`Price variations for ${planId}:`, priceVariations);

      // Add to organized structure
      const organizedProduct = {
        id: product.id,
        name: product.name,
        description: product.description,
        planId: planId,
        planType: planType,
        displayOrder: displayOrder,
        features: product.metadata.features ? JSON.parse(product.metadata.features) : [],
        metadata: product.metadata,
        prices: priceVariations,
        active: product.active
      };

      organizedProducts.push(organizedProduct);
      
      // Also store in prices lookup for quick access
      organizedPrices[planId] = priceVariations;
      logger.info(`Stored prices for planId '${planId}':`, organizedPrices[planId]);
    });

    // Sort products by display order
    organizedProducts.sort((a, b) => a.displayOrder - b.displayOrder);

    logger.info('Final organized prices structure:', organizedPrices);

    return {
      products: organizedProducts,
      prices: organizedPrices
    };
  }

  static async getProductCatalog(forceRefresh = false) {
    const now = Date.now();
    const cacheExpired = !productCatalogCache.lastUpdated || 
                        (now - productCatalogCache.lastUpdated) > productCatalogCache.cacheExpiry;

    if (forceRefresh || cacheExpired || productCatalogCache.products.length === 0) {
      return await this.fetchProducts();
    }

    return productCatalogCache;
  }

  static async validatePriceId(planId, billingCycle) {
    const catalog = await this.getProductCatalog();
    const planPrices = catalog.prices[planId];
    
    if (!planPrices || !planPrices[billingCycle]) {
      return null;
    }

    return planPrices[billingCycle].priceId;
  }

  static async getProductByPlanId(planId) {
    const catalog = await this.getProductCatalog();
    return catalog.products.find(product => product.planId === planId);
  }
}

// Middleware
app.use(helmet());

// CORS Configuration - defaults to allow all origins for flexibility
const corsOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',')
  : '*'; // Allow all origins by default

app.use(cors({
  origin: corsOrigins,
  credentials: true
}));

// Log CORS configuration on startup
if (corsOrigins === '*') {
  logger.info('CORS: Allowing all origins (ALLOWED_ORIGINS not set)');
} else {
  logger.info(`CORS: Allowing specific origins: ${corsOrigins.join(', ')}`);
}

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
    environment: process.env.NODE_ENV || 'development',
    productCacheStatus: {
      lastUpdated: productCatalogCache.lastUpdated,
      productsCount: productCatalogCache.products.length,
      pricesCount: Object.keys(productCatalogCache.prices).length
    }
  });
});

// Get product catalog endpoint
app.get('/products', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const catalog = await ProductCatalogService.getProductCatalog(forceRefresh);
    
    res.json({
      products: catalog.products,
      lastUpdated: catalog.lastUpdated,
      cacheExpiry: catalog.cacheExpiry
    });
  } catch (error) {
    logger.error('Error fetching product catalog:', error);
    res.status(500).json({
      error: 'Failed to fetch product catalog',
      message: error.message
    });
  }
});

// Get specific product details
app.get('/products/:planId', async (req, res) => {
  try {
    const { planId } = req.params;
    const product = await ProductCatalogService.getProductByPlanId(planId);
    
    if (!product) {
      return res.status(404).json({
        error: 'Product not found',
        planId: planId
      });
    }

    res.json(product);
  } catch (error) {
    logger.error('Error fetching product details:', error);
    res.status(500).json({
      error: 'Failed to fetch product details',
      message: error.message
    });
  }
});

// Get available price IDs (for debugging - now dynamic)
app.get('/price-ids', async (req, res) => {
  try {
    const catalog = await ProductCatalogService.getProductCatalog();
    res.json({
      priceIds: catalog.prices,
      environment: process.env.NODE_ENV || 'development',
      lastUpdated: catalog.lastUpdated
    });
  } catch (error) {
    logger.error('Error fetching price IDs:', error);
    res.status(500).json({
      error: 'Failed to fetch price IDs',
      message: error.message
    });
  }
});

// Refresh product catalog endpoint
app.post('/refresh-catalog', async (req, res) => {
  try {
    logger.info('Manual catalog refresh requested');
    const catalog = await ProductCatalogService.getProductCatalog(true);
    
    res.json({
      message: 'Product catalog refreshed successfully',
      productsCount: catalog.products.length,
      pricesCount: Object.keys(catalog.prices).length,
      lastUpdated: catalog.lastUpdated
    });
  } catch (error) {
    logger.error('Error refreshing product catalog:', error);
    res.status(500).json({
      error: 'Failed to refresh product catalog',
      message: error.message
    });
  }
});

// Debug endpoint to troubleshoot product catalog issues
app.get('/debug-catalog', async (req, res) => {
  try {
    logger.info('Debug catalog endpoint requested');
    
    // Fetch fresh data from Stripe
    const products = await stripe.products.list({
      active: true,
      expand: ['data.default_price']
    });

    const prices = await stripe.prices.list({
      active: true,
      expand: ['data.product']
    });

    // Test the organization logic step by step
    const debugInfo = {
      rawData: {
        productsCount: products.data.length,
        pricesCount: prices.data.length,
        products: products.data.map(p => ({
          id: p.id,
          name: p.name,
          metadata: p.metadata
        })),
        prices: prices.data.map(p => ({
          id: p.id,
          product: p.product,
          unitAmount: p.unit_amount,
          currency: p.currency,
          recurring: p.recurring
        }))
      },
      organizationSteps: [],
      finalResult: {}
    };

    // Process each product with detailed logging
    const organizedPrices = {};
    
    products.data.forEach(product => {
      const planId = product.metadata.plan_id || product.name.toLowerCase().replace(/\s+/g, '-');
      const productPrices = prices.data.filter(price => price.product === product.id);
      
      const stepInfo = {
        productName: product.name,
        productId: product.id,
        generatedPlanId: planId,
        metadata: product.metadata,
        foundPricesCount: productPrices.length,
        priceDetails: []
      };

      const priceVariations = {};
      productPrices.forEach(price => {
        const priceDetail = {
          priceId: price.id,
          unitAmount: price.unit_amount,
          currency: price.currency,
          recurring: !!price.recurring
        };

        if (price.recurring) {
          const interval = price.recurring.interval;
          const intervalKey = interval === 'month' ? 'monthly' : 'yearly';
          
          priceDetail.interval = interval;
          priceDetail.intervalKey = intervalKey;
          
          priceVariations[intervalKey] = {
            priceId: price.id,
            unitAmount: price.unit_amount,
            currency: price.currency,
            interval: price.recurring.interval,
            intervalCount: price.recurring.interval_count
          };
        }

        stepInfo.priceDetails.push(priceDetail);
      });

      stepInfo.finalPriceVariations = priceVariations;
      organizedPrices[planId] = priceVariations;
      debugInfo.organizationSteps.push(stepInfo);
    });

    debugInfo.finalResult = organizedPrices;

    // Test specific lookup that's failing
    const testPlanId = 'essential-monthly-plan';
    const testBillingCycle = 'monthly';
    
    debugInfo.testLookup = {
      searchingFor: {
        planId: testPlanId,
        billingCycle: testBillingCycle
      },
      availablePlans: Object.keys(organizedPrices),
      planFound: !!organizedPrices[testPlanId],
      planData: organizedPrices[testPlanId] || null,
      priceFound: !!(organizedPrices[testPlanId] && organizedPrices[testPlanId][testBillingCycle]),
      priceData: (organizedPrices[testPlanId] && organizedPrices[testPlanId][testBillingCycle]) || null
    };

    res.json(debugInfo);

  } catch (error) {
    logger.error('Error in debug catalog endpoint:', error);
    res.status(500).json({
      error: 'Debug catalog failed',
      message: error.message,
      stack: error.stack
    });
  }
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

    // Validate price ID exists in our dynamic catalog
    const validPriceId = await ProductCatalogService.validatePriceId(planId, billingCycle);
    if (!validPriceId || validPriceId !== priceId) {
      logger.warn(`Invalid price ID: ${priceId} for plan ${planId} (${billingCycle})`);
      return res.status(400).json({
        error: 'Invalid price ID for the selected plan',
        availablePlans: Object.keys((await ProductCatalogService.getProductCatalog()).prices)
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

// Get payment status for testing purposes
app.get('/payment-status/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    if (!supabase) {
      return res.status(500).json({
        error: 'Database not configured',
        message: 'Supabase integration is not available'
      });
    }

    // Get business profile status
    const { data: businessProfile, error: profileError } = await supabase
      .from('business_profiles')
      .select('business_status, is_active, stripe_customer_id')
      .eq('user_id', userId)
      .single();

    if (profileError && profileError.code !== 'PGRST116') {
      return res.status(500).json({
        error: 'Failed to get business profile',
        message: profileError.message
      });
    }

    // Get subscription status
    const { data: subscription, error: subscriptionError } = await supabase
      .from('business_subscriptions')
      .select('status, stripe_subscription_id, plan_id, billing_cycle, start_date')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (subscriptionError && subscriptionError.code !== 'PGRST116') {
      return res.status(500).json({
        error: 'Failed to get subscription',
        message: subscriptionError.message
      });
    }

    // Determine overall status
    let status = 'no_subscription';
    let message = 'No subscription found';
    let isActive = false;

    if (subscription && businessProfile) {
      isActive = businessProfile.is_active && businessProfile.business_status === 'Active';
      
      if (subscription.status === 'active' && isActive) {
        status = 'success';
        message = '🎉 Payment successful! Your business profile has been activated and is ready to use.';
      } else if (subscription.status === 'incomplete') {
        status = 'pending';
        message = '⏳ Payment is being processed. Please wait for confirmation.';
      } else if (subscription.status === 'past_due') {
        status = 'error';
        message = '❌ Payment failed. Your business profile has been deactivated. Please update your payment method.';
      } else if (subscription.status === 'canceled') {
        status = 'canceled';
        message = '⚠️ Subscription has been canceled. Your business profile is inactive.';
      } else {
        status = 'error';
        message = `❌ Subscription status: ${subscription.status}. Business profile status: ${businessProfile.business_status}`;
      }
    } else if (!businessProfile) {
      status = 'no_profile';
      message = '⚠️ No business profile found. Please create a business profile first.';
    }

    res.json({
      status,
      message,
      isActive,
      businessProfile: businessProfile ? {
        businessStatus: businessProfile.business_status,
        isActive: businessProfile.is_active,
        hasStripeCustomer: !!businessProfile.stripe_customer_id
      } : null,
      subscription: subscription ? {
        status: subscription.status,
        stripeSubscriptionId: subscription.stripe_subscription_id,
        planId: subscription.plan_id,
        billingCycle: subscription.billing_cycle,
        startDate: subscription.start_date
      } : null
    });

  } catch (error) {
    logger.error('Error getting payment status:', error);
    res.status(500).json({
      status: 'error',
      message: '❌ Failed to check payment status. Please try again.',
      error: error.message
    });
  }
});

// Test payment completion endpoint (for testing purposes)
app.post('/test-payment-complete', [
  body('userId').isString().notEmpty(),
  body('subscriptionId').isString().notEmpty(),
  body('success').isBoolean()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        status: 'error',
        message: '❌ Invalid request data',
        details: errors.array()
      });
    }

    const { userId, subscriptionId, success } = req.body;

    if (!supabase) {
      return res.status(500).json({
        status: 'error',
        message: '❌ Database not configured'
      });
    }

    if (success) {
      // Simulate successful payment
      try {
        // Get subscription from Stripe
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        
        // Update business subscription
        const subscriptionData = {
          subscriptionId: subscription.id,
          customerId: subscription.customer,
          status: 'active',
          planName: subscription.metadata.planName || 'Test Plan',
          billingCycle: subscription.metadata.billingCycle || 'monthly',
          currentPeriodStart: new Date(subscription.current_period_start * 1000).toISOString(),
          currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
          nextBillingDate: new Date(subscription.current_period_end * 1000).toISOString()
        };

        await createOrUpdateBusinessSubscription(userId, subscriptionData);

        // Activate business profile
        await activateBusinessProfile(userId, {
          customerId: subscription.customer,
          subscriptionId: subscription.id
        });

        res.json({
          status: 'success',
          message: '🎉 Test payment completed successfully! Your business profile has been activated.',
          businessActivated: true
        });

      } catch (error) {
        logger.error('Error processing test payment success:', error);
        res.status(500).json({
          status: 'error',
          message: '❌ Failed to process test payment success: ' + error.message
        });
      }
    } else {
      // Simulate failed payment
      try {
        // Update business profile to inactive
        await updateSupabaseProfile(userId, {
          subscription_status: 'past_due',
          business_status: 'Not Active',
          is_active: false
        });

        res.json({
          status: 'error',
          message: '❌ Test payment failed. Business profile has been deactivated.',
          businessActivated: false
        });

      } catch (error) {
        logger.error('Error processing test payment failure:', error);
        res.status(500).json({
          status: 'error',
          message: '❌ Failed to process test payment failure: ' + error.message
        });
      }
    }

  } catch (error) {
    logger.error('Error in test payment completion:', error);
    res.status(500).json({
      status: 'error',
      message: '❌ Test payment processing failed: ' + error.message
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

    case 'product.created':
    case 'product.updated':
    case 'product.deleted':
    case 'price.created':
    case 'price.updated':
    case 'price.deleted':
      logger.info(`Product/Price catalog changed: ${event.type}`);
      // Refresh product catalog when products or prices change
      try {
        await ProductCatalogService.getProductCatalog(true);
        logger.info('Product catalog refreshed due to webhook event');
      } catch (error) {
        logger.error('Failed to refresh product catalog:', error);
      }
      break;

    default:
      logger.info(`Unhandled event type: ${event.type}`);
  }
}

// Webhook handlers
async function handleSubscriptionCreated(subscription) {
  if (supabase && subscription.metadata.userId) {
    try {
      // Create business subscription record
      const subscriptionData = {
        subscriptionId: subscription.id,
        customerId: subscription.customer,
        status: subscription.status,
        planName: subscription.metadata.planName || 'Unknown Plan',
        billingCycle: subscription.metadata.billingCycle || 'monthly',
        currentPeriodStart: new Date(subscription.current_period_start * 1000).toISOString(),
        currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
        nextBillingDate: new Date(subscription.current_period_end * 1000).toISOString()
      };

      await createOrUpdateBusinessSubscription(subscription.metadata.userId, subscriptionData);

      // Also update the business profile
      await updateSupabaseProfile(subscription.metadata.userId, {
        subscription_status: subscription.status,
        subscription_id: subscription.id,
        stripe_customer_id: subscription.customer
      });

      logger.info(`Successfully processed subscription creation for user: ${subscription.metadata.userId}`);
    } catch (error) {
      logger.error('Error updating profile on subscription created:', error);
    }
  }
}

async function handleSubscriptionUpdated(subscription) {
  if (supabase && subscription.metadata.userId) {
    try {
      // Update business subscription record
      const subscriptionData = {
        subscriptionId: subscription.id,
        customerId: subscription.customer,
        status: subscription.status,
        planName: subscription.metadata.planName || 'Unknown Plan',
        billingCycle: subscription.metadata.billingCycle || 'monthly',
        currentPeriodStart: new Date(subscription.current_period_start * 1000).toISOString(),
        currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
        nextBillingDate: new Date(subscription.current_period_end * 1000).toISOString()
      };

      await createOrUpdateBusinessSubscription(subscription.metadata.userId, subscriptionData);

      // Also update the business profile
      await updateSupabaseProfile(subscription.metadata.userId, {
        subscription_status: subscription.status
      });

      logger.info(`Successfully processed subscription update for user: ${subscription.metadata.userId}`);
    } catch (error) {
      logger.error('Error updating profile on subscription updated:', error);
    }
  }
}

async function handleSubscriptionDeleted(subscription) {
  if (supabase && subscription.metadata.userId) {
    try {
      // Update business subscription status to canceled
      const subscriptionData = {
        subscriptionId: subscription.id,
        customerId: subscription.customer,
        status: 'canceled',
        planName: subscription.metadata.planName || 'Unknown Plan',
        billingCycle: subscription.metadata.billingCycle || 'monthly'
      };

      await createOrUpdateBusinessSubscription(subscription.metadata.userId, subscriptionData);

      // Update business profile to inactive
      await updateSupabaseProfile(subscription.metadata.userId, {
        subscription_status: 'canceled',
        subscription_id: null,
        business_status: 'Not Active',
        is_active: false
      });

      logger.info(`Successfully processed subscription deletion for user: ${subscription.metadata.userId}`);
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
        // Update business subscription to active
        const subscriptionData = {
          subscriptionId: subscription.id,
          customerId: subscription.customer,
          status: 'active',
          planName: subscription.metadata.planName || 'Unknown Plan',
          billingCycle: subscription.metadata.billingCycle || 'monthly',
          currentPeriodStart: new Date(subscription.current_period_start * 1000).toISOString(),
          currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
          nextBillingDate: new Date(subscription.current_period_end * 1000).toISOString()
        };

        await createOrUpdateBusinessSubscription(subscription.metadata.userId, subscriptionData);

        // Activate business profile
        await activateBusinessProfile(subscription.metadata.userId, {
          customerId: subscription.customer,
          subscriptionId: subscription.id
        });

        logger.info(`Successfully activated business profile and subscription for user: ${subscription.metadata.userId}`);
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
        // Update business subscription to past_due
        const subscriptionData = {
          subscriptionId: subscription.id,
          customerId: subscription.customer,
          status: 'past_due',
          planName: subscription.metadata.planName || 'Unknown Plan',
          billingCycle: subscription.metadata.billingCycle || 'monthly'
        };

        await createOrUpdateBusinessSubscription(subscription.metadata.userId, subscriptionData);

        // Update business profile status
        await updateSupabaseProfile(subscription.metadata.userId, {
          subscription_status: 'past_due',
          business_status: 'Not Active',
          is_active: false
        });

        logger.info(`Successfully processed payment failure for user: ${subscription.metadata.userId}`);
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

// Create or update business subscription
async function createOrUpdateBusinessSubscription(userId, subscriptionData) {
  if (!supabase) {
    logger.warn('Supabase not configured, skipping subscription update');
    return;
  }

  try {
    // First, get the business profile for this user
    const { data: businessProfile, error: profileError } = await supabase
      .from('business_profiles')
      .select('business_id')
      .eq('user_id', userId)
      .single();

    if (profileError && profileError.code !== 'PGRST116') { // PGRST116 = no rows returned
      throw new Error(`Failed to get business profile: ${profileError.message}`);
    }

    // Get the plan_id from the plans table based on the product metadata
    const { data: plan, error: planError } = await supabase
      .from('plans')
      .select('plan_id')
      .eq('name', subscriptionData.planName)
      .single();

    if (planError) {
      logger.warn(`Plan not found in database: ${subscriptionData.planName}. Creating subscription without plan reference.`);
    }

    // Create or update the business subscription
    const subscriptionRecord = {
      business_id: businessProfile?.business_id || null,
      plan_id: plan?.plan_id || null,
      user_id: userId,
      status: subscriptionData.status,
      billing_cycle: subscriptionData.billingCycle,
      stripe_subscription_id: subscriptionData.subscriptionId,
      stripe_customer_id: subscriptionData.customerId,
      start_date: new Date().toISOString(),
      next_billing_date: subscriptionData.nextBillingDate || null,
      current_period_start: subscriptionData.currentPeriodStart || new Date().toISOString(),
      current_period_end: subscriptionData.currentPeriodEnd || null,
      updated_at: new Date().toISOString()
    };

    // Check if subscription already exists
    const { data: existingSubscription, error: existingError } = await supabase
      .from('business_subscriptions')
      .select('subscription_id')
      .eq('stripe_subscription_id', subscriptionData.subscriptionId)
      .single();

    if (existingError && existingError.code !== 'PGRST116') {
      throw new Error(`Failed to check existing subscription: ${existingError.message}`);
    }

    let result;
    if (existingSubscription) {
      // Update existing subscription
      const { data, error } = await supabase
        .from('business_subscriptions')
        .update(subscriptionRecord)
        .eq('stripe_subscription_id', subscriptionData.subscriptionId)
        .select();
      
      result = { data, error };
    } else {
      // Create new subscription
      const { data, error } = await supabase
        .from('business_subscriptions')
        .insert([subscriptionRecord])
        .select();
      
      result = { data, error };
    }

    if (result.error) {
      throw new Error(`Failed to create/update subscription: ${result.error.message}`);
    }

    logger.info(`Successfully created/updated business subscription for user: ${userId}`);
    return result.data[0];

  } catch (error) {
    logger.error('Error creating/updating business subscription:', error);
    throw error;
  }
}

// Activate business profile when payment succeeds
async function activateBusinessProfile(userId, subscriptionData) {
  if (!supabase) {
    logger.warn('Supabase not configured, skipping profile activation');
    return;
  }

  try {
    // Update business profile to active status
    const { data, error } = await supabase
      .from('business_profiles')
      .update({
        business_status: 'Active',
        is_active: true,
        stripe_customer_id: subscriptionData.customerId,
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId)
      .select();

    if (error) {
      throw new Error(`Failed to activate business profile: ${error.message}`);
    }

    if (data && data.length > 0) {
      logger.info(`Successfully activated business profile for user: ${userId}`);
      return data[0];
    } else {
      logger.warn(`No business profile found to activate for user: ${userId}`);
      return null;
    }

  } catch (error) {
    logger.error('Error activating business profile:', error);
    throw error;
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

// Initialize product catalog on startup
async function initializeProductCatalog() {
  try {
    logger.info('Initializing product catalog on startup...');
    await ProductCatalogService.getProductCatalog(true);
    logger.info('Product catalog initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize product catalog:', error);
    // Don't fail startup if catalog initialization fails
  }
}

// Start server
app.listen(PORT, async () => {
  logger.info(`LinkBy6 Stripe Server running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
  logger.info(`Supabase integration: ${supabase ? 'enabled' : 'disabled'}`);
  
  // Initialize product catalog
  await initializeProductCatalog();
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
