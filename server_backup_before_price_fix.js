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

    // Process each product
    products.forEach(product => {
      // Get product metadata for organization
      const planId = product.metadata.plan_id || product.name.toLowerCase().replace(/\s+/g, '-');
      const planType = product.metadata.plan_type || 'subscription';
      const displayOrder = parseInt(product.metadata.display_order) || 999;

      // Find all prices for this product
      const productPrices = prices.filter(price => price.product === product.id);
      
      const priceVariations = {};
      productPrices.forEach(price => {
        if (price.recurring) {
          const interval = price.recurring.interval; // 'month' or 'year'
          const intervalKey = interval === 'month' ? 'monthly' : 'yearly';
          
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
    });

    // Sort products by display order
    organizedProducts.sort((a, b) => a.displayOrder - b.displayOrder);

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
      logger.info(`Found existing customer: ${
