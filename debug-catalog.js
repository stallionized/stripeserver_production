// Debug script to test product catalog organization locally
require('dotenv').config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

async function debugProductCatalog() {
  try {
    console.log('=== DEBUGGING PRODUCT CATALOG ===');
    
    // Fetch products and prices
    const products = await stripe.products.list({
      active: true,
      expand: ['data.default_price']
    });

    const prices = await stripe.prices.list({
      active: true,
      expand: ['data.product']
    });

    console.log(`\nFound ${products.data.length} products and ${prices.data.length} prices\n`);

    // Test the organization logic
    const organizedProducts = [];
    const organizedPrices = {};

    products.data.forEach(product => {
      const planId = product.metadata.plan_id || product.name.toLowerCase().replace(/\s+/g, '-');
      console.log(`Product: ${product.name} (${product.id})`);
      console.log(`  Generated planId: ${planId}`);
      console.log(`  Metadata:`, product.metadata);

      // Find prices for this product
      const productPrices = prices.data.filter(price => price.product === product.id);
      console.log(`  Found ${productPrices.length} prices:`);

      const priceVariations = {};
      productPrices.forEach(price => {
        console.log(`    Price ID: ${price.id}`);
        console.log(`    Amount: $${price.unit_amount / 100}`);
        console.log(`    Recurring: ${!!price.recurring}`);
        
        if (price.recurring) {
          const interval = price.recurring.interval;
          const intervalKey = interval === 'month' ? 'monthly' : 'yearly';
          console.log(`    Interval: ${interval} -> ${intervalKey}`);
          
          priceVariations[intervalKey] = {
            priceId: price.id,
            unitAmount: price.unit_amount,
            currency: price.currency,
            interval: price.recurring.interval,
            intervalCount: price.recurring.interval_count
          };
        }
      });

      console.log(`  Price variations:`, priceVariations);
      organizedPrices[planId] = priceVariations;
      console.log(`  Stored in organizedPrices[${planId}]:`, organizedPrices[planId]);
      console.log('---');
    });

    console.log('\n=== FINAL ORGANIZED PRICES ===');
    console.log(JSON.stringify(organizedPrices, null, 2));

    // Test specific lookups
    console.log('\n=== TESTING LOOKUPS ===');
    const testPlanId = 'essential-monthly-plan';
    const testBillingCycle = 'monthly';
    
    console.log(`Looking for planId: ${testPlanId}, billingCycle: ${testBillingCycle}`);
    
    if (organizedPrices[testPlanId]) {
      console.log(`Found plan: ${testPlanId}`);
      console.log(`Available billing cycles:`, Object.keys(organizedPrices[testPlanId]));
      
      if (organizedPrices[testPlanId][testBillingCycle]) {
        console.log(`✅ Found price for ${testBillingCycle}:`, organizedPrices[testPlanId][testBillingCycle]);
      } else {
        console.log(`❌ No price found for ${testBillingCycle}`);
      }
    } else {
      console.log(`❌ Plan ${testPlanId} not found`);
      console.log('Available plans:', Object.keys(organizedPrices));
    }

  } catch (error) {
    console.error('Error:', error);
  }
}

debugProductCatalog();
