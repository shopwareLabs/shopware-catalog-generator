# Browser Verification Guide

This guide describes how to use the `cursor-ide-browser` MCP to verify the generated storefront.

## Prerequisites

1. Storefront running at the generated URL (e.g., `http://e2e-test-xxx.localhost:8000`)
2. `cursor-ide-browser` MCP enabled in Cursor

## Verification Steps

### 1. Navigate to Storefront

```
browser_navigate to http://{salesChannel}.localhost:8000
browser_snapshot
```

**Check:**

- Page loads without errors
- Navigation shows generated category names
- Store logo/branding visible

### 2. Verify Category Navigation

```
browser_snapshot  # Get current page structure
browser_click on first category link
browser_snapshot  # Verify category page
```

**Check:**

- Category page shows products
- Product listing has images, names, prices
- Pagination works if 25+ products

### 3. Verify Product Detail Page

```
browser_click on first product
browser_snapshot
```

**Check:**

- Product name displayed
- Description visible (HTML rendered)
- Price shown correctly
- Add to cart button visible
- Properties listed (if generated)
- Reviews displayed (if generated)
- Manufacturer info (if generated)

### 4. Check Product Images

If image processor ran:

- Product has cover image
- Multiple images in gallery (if imageCount > 1)
- Images load correctly

### 5. Verify Reviews

If review processor ran:

- Reviews section visible on product page
- Review count matches expectations
- Review content is coherent

## Automated Browser Check Example

```typescript
// Example MCP commands for automated verification

// Step 1: Navigate to storefront
await mcpCall("browser_navigate", {
    url: `http://${salesChannelName}.localhost:8000`,
});

// Step 2: Take snapshot
const snapshot = await mcpCall("browser_snapshot", {});

// Step 3: Verify navigation has categories
const hasCategories = snapshot.includes("category") || snapshot.includes("navigation");

// Step 4: Click a category
await mcpCall("browser_click", { ref: "category-link-ref" });

// Step 5: Verify products displayed
const categorySnapshot = await mcpCall("browser_snapshot", {});
const hasProducts = categorySnapshot.includes("product");

// Step 6: Click a product
await mcpCall("browser_click", { ref: "product-link-ref" });

// Step 7: Verify product page
const productSnapshot = await mcpCall("browser_snapshot", {});
const hasDescription = productSnapshot.includes("description");
const hasPrice = productSnapshot.includes("price") || productSnapshot.includes("€");

console.log("Browser verification results:");
console.log(`  Categories visible: ${hasCategories}`);
console.log(`  Products visible: ${hasProducts}`);
console.log(`  Product description: ${hasDescription}`);
console.log(`  Product price: ${hasPrice}`);
```

## Common Issues

### Page not loading

- Ensure Shopware is running
- Check if SalesChannel subdomain is configured
- Verify `hosts` file has entry for subdomain

### Products not visible

- Check if products were created in Shopware
- Verify product visibility for the SalesChannel

### Images not showing

- Check if image processor ran
- Verify image uploads completed
- Check media folder permissions

## Cleanup After Testing

After browser verification, cleanup the test data:

```bash
bun run cleanup -- --salesChannel="e2e-test-xxx" --delete --props
```
