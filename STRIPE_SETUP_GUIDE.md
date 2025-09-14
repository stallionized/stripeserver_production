# Stripe Dynamic Product Catalog Setup Guide

This guide explains how to set up your products in the Stripe Dashboard to work with the new dynamic product catalog system.

## Overview

The LinkBy6 Stripe server now automatically fetches products and prices from your Stripe account, eliminating the need for hardcoded environment variables. This makes it easy to add new subscription plans without touching code.

## Setting Up Products in Stripe Dashboard

### 1. Create Products

1. Go to your [Stripe Dashboard](https://dashboard.stripe.com)
2. Navigate to **Products** in the left sidebar
3. Click **+ Add product**
4. Fill in the basic product information:
   - **Name**: Display name (e.g., "Essential Plan", "Growth Plan", "Pro Enterprise")
   - **Description**: Brief description of the plan
   - **Image**: Optional product image

### 2. Configure Product Metadata

For each product, add the following metadata fields to organize them properly:

#### Required Metadata Fields:

- **`plan_id`**: Unique identifier for the plan
  - Examples: `essential`, `growth`, `pro-enterprise`
  - Used by your mobile app to reference specific plans
  - Should be lowercase with hyphens instead of spaces

- **`display_order`**: Numeric value to control display order
  - Examples: `1`, `2`, `3`
  - Lower numbers appear first in the product catalog

#### Optional Metadata Fields:

- **`plan_type`**: Type of plan (defaults to "subscription")
  - Examples: `subscription`, `one-time`, `usage-based`

- **`features`**: JSON array of plan features
  - Example: `["Basic support", "Up to 100 connections", "Mobile app access"]`
  - Must be valid JSON format

### 3. Create Prices for Each Product

For each product, create the pricing options:

1. In the product details, click **+ Add another price**
2. Configure the price:
   - **Price**: Amount in your currency
   - **Billing period**: Choose `Monthly` or `Yearly`
   - **Currency**: Select your currency (e.g., USD)

### 4. Example Product Setup

Here's how to set up a typical subscription plan:

#### Product: Essential Plan
- **Name**: Essential Plan
- **Description**: Perfect for small businesses getting started
- **Metadata**:
  - `plan_id`: `essential`
  - `display_order`: `1`
  - `plan_type`: `subscription`
  - `features`: `["Email support", "Up to 50 connections", "Basic analytics"]`

#### Prices for Essential Plan:
- **Monthly**: $9.99/month
- **Yearly**: $99.99/year

#### Product: Growth Plan
- **Name**: Growth Plan
- **Description**: Ideal for growing businesses
- **Metadata**:
  - `plan_id`: `growth`
  - `display_order`: `2`
  - `plan_type`: `subscription`
  - `features`: `["Priority support", "Up to 500 connections", "Advanced analytics", "Team collaboration"]`

#### Prices for Growth Plan:
- **Monthly**: $29.99/month
- **Yearly**: $299.99/year

## API Endpoints

Once your products are set up, the server provides these endpoints:

### Get All Products
```
GET /products
```
Returns all active products with their prices and metadata.

### Get Specific Product
```
GET /products/:planId
```
Returns details for a specific product by plan ID.

### Refresh Product Catalog
```
POST /refresh-catalog
```
Manually refreshes the product catalog cache.

### Get Price IDs (Debug)
```
GET /price-ids
```
Returns the current price ID mappings for debugging.

## Mobile App Integration

Your mobile app can now fetch the product catalog dynamically:

```javascript
// Fetch available subscription plans
const response = await fetch('https://your-server.com/products');
const { products } = await response.json();

// Find a specific plan
const essentialPlan = products.find(p => p.planId === 'essential');

// Get monthly price for essential plan
const monthlyPrice = essentialPlan.prices.monthly;
```

## Benefits of This Approach

1. **No Code Changes**: Add new products in Stripe Dashboard without touching code
2. **Real-time Updates**: Product changes reflect immediately (with 5-minute cache)
3. **Centralized Management**: Single source of truth in Stripe
4. **Flexible Pricing**: Easy to create promotional prices or limited-time offers
5. **Automatic Validation**: Server validates price IDs against current catalog

## Webhook Integration

The server automatically refreshes the product catalog when these Stripe events occur:
- `product.created`
- `product.updated`
- `product.deleted`
- `price.created`
- `price.updated`
- `price.deleted`

## Troubleshooting

### Product Not Appearing
- Ensure the product is marked as **Active** in Stripe
- Check that required metadata fields are set correctly
- Verify the `plan_id` is unique and follows naming conventions

### Price Validation Errors
- Ensure prices are marked as **Active** in Stripe
- Check that both monthly and yearly prices exist if your app expects them
- Verify the billing period is set correctly (`month` or `year`)

### Cache Issues
- Use the `/refresh-catalog` endpoint to manually refresh the cache
- Check the `/health` endpoint to see cache status
- Cache automatically expires every 5 minutes

## Migration from Environment Variables

If you're migrating from the old environment variable system:

1. Set up your products in Stripe Dashboard with proper metadata
2. Test the new endpoints to ensure products are fetched correctly
3. Remove the old `STRIPE_PRICE_*` environment variables
4. Update your mobile app to use the new `/products` endpoint
5. Deploy the updated server

The server will automatically fall back to dynamic fetching when environment variables are not present.
