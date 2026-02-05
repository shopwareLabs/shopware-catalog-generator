#!/bin/bash
# test-e2e.sh - End-to-end test against local Docker Shopware
#
# Prerequisites:
# - Shopware running at localhost:8000
# - SW_ENV_URL, SW_CLIENT_ID, SW_CLIENT_SECRET set in .env
# - AI_PROVIDER configured (github-models recommended)
#
# Usage:
#   ./test-e2e.sh                    # Full test: create → hydrate → upload → verify
#   ./test-e2e.sh --reuse=<name>     # Reuse existing blueprint, run hydrate → upload → verify
#   ./test-e2e.sh --reuse=<name> --skip-hydrate   # Skip AI, just upload → verify
#   ./test-e2e.sh --reuse=<name> --skip-upload    # Just verify existing data
#   ./test-e2e.sh --cleanup=<name>   # Only cleanup specific SalesChannel
#
# Post-processors run:
# - CMS element pages: cms-text, cms-images, cms-video, cms-text-images, cms-commerce, cms-form
# - Digital product: digital-product (creates Gift Card €50)
# - CMS orchestrator: cms-testing (creates Testing category hierarchy)

set -e  # Exit on error

# Parse arguments
SKIP_HYDRATE=false
SKIP_UPLOAD=false
SKIP_VERIFY=false
CLEANUP_ONLY=""
REUSE_NAME=""

for arg in "$@"; do
    case $arg in
        --skip-hydrate)
            SKIP_HYDRATE=true
            ;;
        --skip-upload)
            SKIP_UPLOAD=true
            ;;
        --skip-verify)
            SKIP_VERIFY=true
            ;;
        --cleanup=*)
            CLEANUP_ONLY="${arg#*=}"
            ;;
        --reuse=*)
            REUSE_NAME="${arg#*=}"
            ;;
    esac
done

# Determine SalesChannel name
SKIP_CREATE=false
if [ -n "$REUSE_NAME" ]; then
    TEST_SALESCHANNEL="$REUSE_NAME"
    SKIP_CREATE=true
    echo "Reusing existing blueprint: $TEST_SALESCHANNEL"
elif [ -n "$CLEANUP_ONLY" ]; then
    TEST_SALESCHANNEL="$CLEANUP_ONLY"
else
    TEST_SALESCHANNEL="e2e-test-kids-store-$(date +%s)"
fi

SW_URL="${SW_ENV_URL:-http://localhost:8000}"

echo "=== E2E Test: $TEST_SALESCHANNEL ==="
echo "Target: $SW_URL"
echo "Phases: create=$([[ $SKIP_CREATE == true ]] && echo skip || echo run) | hydrate=$([[ $SKIP_HYDRATE == true ]] && echo skip || echo run) | upload=$([[ $SKIP_UPLOAD == true ]] && echo skip || echo run) | verify=$([[ $SKIP_VERIFY == true ]] && echo skip || echo run)"
echo ""

# Function to cleanup on exit
cleanup() {
    local exit_code=$?
    if [ $exit_code -ne 0 ]; then
        echo ""
        echo "=== E2E Test FAILED (exit code: $exit_code) ==="
        echo ""
        echo "Cleanup: Run 'bun run cleanup -- --salesChannel=\"$TEST_SALESCHANNEL\" --delete' to remove test data"
    fi
}
trap cleanup EXIT

# Cleanup only mode
if [ -n "$CLEANUP_ONLY" ]; then
    echo "Running cleanup for $CLEANUP_ONLY..."

    # Cleanup CMS processors first (reverse order)
    echo "  Cleaning up CMS processors..."
    bun run cleanup -- --salesChannel="$CLEANUP_ONLY" --processors=cms-testing || true
    bun run cleanup -- --salesChannel="$CLEANUP_ONLY" --processors=cms-text,cms-images,cms-video,cms-text-images,cms-commerce,cms-form || true

    # Cleanup digital product
    echo "  Cleaning up digital product..."
    bun run cleanup -- --salesChannel="$CLEANUP_ONLY" --processors=digital-product || true

    # Cleanup SalesChannel and data
    echo "  Cleaning up SalesChannel..."
    bun run cleanup -- --salesChannel="$CLEANUP_ONLY" --delete --props || echo "Cleanup skipped (nothing to clean)"

    echo "Cleanup complete."
    exit 0
fi

# Phase 1: Create blueprint
if [ "$SKIP_CREATE" = true ]; then
    echo "[1/5] Skipping blueprint creation (--skip-create or --reuse)"
    if [ ! -f "generated/sales-channels/$TEST_SALESCHANNEL/blueprint.json" ]; then
        echo "ERROR: No blueprint found at generated/sales-channels/$TEST_SALESCHANNEL/blueprint.json"
        exit 1
    fi
else
    echo "[1/5] Creating blueprint..."
    bun run blueprint create --name="$TEST_SALESCHANNEL" --description="Kids store selling toys, books and games." --products=10

    if [ ! -f "generated/sales-channels/$TEST_SALESCHANNEL/blueprint.json" ]; then
        echo "ERROR: blueprint.json not created"
        exit 1
    fi
    echo "✓ Blueprint created"
fi
echo ""

# Phase 2: Hydrate with AI
if [ "$SKIP_HYDRATE" = true ]; then
    echo "[2/5] Skipping AI hydration (--skip-hydrate)"
    if [ ! -f "generated/sales-channels/$TEST_SALESCHANNEL/hydrated-blueprint.json" ]; then
        echo "WARNING: No hydrated blueprint found. Upload may fail."
    fi
elif [ -f "generated/sales-channels/$TEST_SALESCHANNEL/hydrated-blueprint.json" ]; then
    echo "[2/5] Skipping AI hydration (hydrated blueprint already exists)"
else
    echo "[2/5] Hydrating blueprint with AI..."
    bun run blueprint hydrate --name="$TEST_SALESCHANNEL"

    if [ ! -f "generated/sales-channels/$TEST_SALESCHANNEL/hydrated-blueprint.json" ]; then
        echo "ERROR: hydrated-blueprint.json not created"
        exit 1
    fi
    echo "✓ Blueprint hydrated"
fi
echo ""

# Phase 3: Generate (upload to Shopware)
if [ "$SKIP_UPLOAD" = true ]; then
    echo "[3/5] Skipping Shopware upload"
elif [ ! -f "generated/sales-channels/$TEST_SALESCHANNEL/hydrated-blueprint.json" ]; then
    echo "[3/5] Skipping upload (no hydrated blueprint)"
else
    echo "[3/5] Uploading to Shopware..."
    bun run generate --name="$TEST_SALESCHANNEL"
    echo "✓ Uploaded to Shopware"
fi
echo ""

# Phase 4: Run post-processors
if [ "$SKIP_UPLOAD" = true ]; then
    echo "[4/5] Skipping post-processors"
elif [ ! -f "generated/sales-channels/$TEST_SALESCHANNEL/hydrated-blueprint.json" ]; then
    echo "[4/5] Skipping post-processors (no hydrated blueprint)"
else
    echo "[4/5] Running post-processors..."

    # Run CMS element processors (create demo pages)
    echo "  Running CMS processors..."
    bun run process --name="$TEST_SALESCHANNEL" --only=cms-text,cms-images,cms-video,cms-text-images,cms-commerce,cms-form

    # Run digital product processor (create gift card)
    echo "  Running digital product processor..."
    bun run process --name="$TEST_SALESCHANNEL" --only=digital-product

    # Run CMS testing processor (create Testing category hierarchy)
    echo "  Running CMS testing orchestrator..."
    bun run process --name="$TEST_SALESCHANNEL" --only=cms-testing

    echo "✓ Post-processors complete"
fi
echo ""

# Phase 5: Verify via API
if [ "$SKIP_VERIFY" = true ]; then
    echo "[5/5] Skipping verification"
else
    echo "[5/5] Verifying via Shopware API..."
    bun run test:verify --name="$TEST_SALESCHANNEL"
    echo "✓ API verification passed"
fi
echo ""

echo "=== E2E Test PASSED ==="
echo ""
echo "Storefront URL: http://$TEST_SALESCHANNEL.localhost:8000"
echo ""
echo "To inspect the generated data:"
echo "  cat generated/sales-channels/$TEST_SALESCHANNEL/blueprint.json | jq ."
echo ""
echo "To cleanup:"
echo "  bun run cleanup -- --salesChannel=\"$TEST_SALESCHANNEL\" --delete"
echo ""
