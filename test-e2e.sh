#!/bin/bash
# test-e2e.sh - End-to-end test against local Docker Shopware
#
# Prerequisites:
# - Shopware running at localhost:8000
# - SW_ENV_URL, SW_CLIENT_ID, SW_CLIENT_SECRET set in .env
# - AI_PROVIDER configured (pollinations or openai)
#
# Usage:
#   ./test-e2e.sh                                                    # Full test: create → hydrate → upload → verify
#   ./test-e2e.sh --url=https://shop.com                             # Derive name + description from URL, crawl for inspiration
#   ./test-e2e.sh --name=myshop --description="..." --url=https://…  # Explicit name/description + inspiration crawl
#   ./test-e2e.sh --reuse=<name>                                     # Reuse existing blueprint, run hydrate → upload → verify
#   ./test-e2e.sh --reuse=<name> --skip-hydrate                      # Skip AI, just upload → verify
#   ./test-e2e.sh --reuse=<name> --skip-upload                       # Just verify existing data
#   ./test-e2e.sh --cleanup=<name>                                   # Only cleanup specific SalesChannel
#   ./test-e2e.sh --sw-dev=67 --reuse=<name> --skip-hydrate          # Run against a local sw-dev lane
#
# --sw-dev=<lane> targets a local sw-dev lane (see `sw-dev list`) instead of .env:
# - SW_ENV_URL is set to the lane's APP_URL
# - A temporary admin integration is created via bin/console integration:create
# - Its credentials are only exported to this script's child processes
# - The integration is deleted via the Admin API when the script exits (pass or fail)
#
# Post-processors run:
# - CMS homepage: cms-home (root category layout with welcome text + product listing)
# - CMS element pages: cms-text, cms-images, cms-video, cms-text-images, cms-commerce, cms-form
# - Images: images (upload pre-generated product + category images)
# - Digital product: digital-product (creates Gift Card €50)
# - CMS orchestrator: cms-testing (creates Testing category hierarchy)

set -e  # Exit on error

# Help
for arg in "$@"; do
    if [ "$arg" = "-h" ] || [ "$arg" = "--help" ]; then
        awk '/^# test-e2e\.sh/,/^set -e/' "$0" | grep '^#' | sed 's/^# \{0,1\}//'
        exit 0
    fi
done

# Parse arguments
SKIP_HYDRATE=false
SKIP_UPLOAD=false
SKIP_VERIFY=false
CLEANUP_ONLY=""
REUSE_NAME=""
INSPIRE_URL=""
CUSTOM_NAME=""
CUSTOM_DESCRIPTION=""
SW_DEV_LANE=""

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
        --url=*)
            INSPIRE_URL="${arg#*=}"
            ;;
        --name=*)
            CUSTOM_NAME="${arg#*=}"
            ;;
        --description=*)
            CUSTOM_DESCRIPTION="${arg#*=}"
            ;;
        --sw-dev=*)
            SW_DEV_LANE="${arg#*=}"
            ;;
    esac
done

# Temporary integration for --sw-dev runs (local only, removed on exit)
SW_DEV_BIN="${SW_DEV_BIN:-$HOME/shopware-dev/bin/sw-dev}"
TEMP_INTEGRATION_KEY=""
TEMP_INTEGRATION_SECRET=""

sw_dev_exec() {
    # sw-dev prints ANSI resets; strip escape codes and carriage returns
    "$SW_DEV_BIN" lane exec "$SW_DEV_LANE" "$@" 2>&1 | sed $'s/\x1b\\[[0-9;]*m//g' | tr -d '\r'
}

fetch_temp_integration_token() {
    curl -sf -X POST "$SW_ENV_URL/api/oauth/token" \
        -H 'Content-Type: application/json' \
        -d "{\"grant_type\":\"client_credentials\",\"client_id\":\"$TEMP_INTEGRATION_KEY\",\"client_secret\":\"$TEMP_INTEGRATION_SECRET\"}" |
        jq -r '.access_token // empty'
}

create_temp_integration() {
    if [ ! -x "$SW_DEV_BIN" ]; then
        echo "ERROR: sw-dev not found at $SW_DEV_BIN (set SW_DEV_BIN)"
        exit 1
    fi

    local app_url
    app_url=$(sw_dev_exec printenv APP_URL | tail -1)
    if [ -z "$app_url" ]; then
        echo "ERROR: Could not read APP_URL from sw-dev lane '$SW_DEV_LANE'"
        exit 1
    fi
    export SW_ENV_URL="${app_url%/}"

    TEMP_INTEGRATION_KEY="SWIA$(openssl rand -hex 11 | tr 'a-f' 'A-F')"
    TEMP_INTEGRATION_SECRET="$(openssl rand -hex 32)"
    local integration_name
    integration_name="catalog-generator-e2e-$(date +%s)"

    local create_output
    create_output=$(sw_dev_exec bin/console integration:create "$integration_name" --admin \
        --access-key="$TEMP_INTEGRATION_KEY" \
        --secret-access-key="$TEMP_INTEGRATION_SECRET")

    # The pipe in sw_dev_exec hides the exit code, so prove the credentials work instead
    if [ -z "$(fetch_temp_integration_token || true)" ]; then
        echo "ERROR: Temporary integration does not authenticate in sw-dev lane '$SW_DEV_LANE'"
        echo "$create_output" | grep -v -e "$TEMP_INTEGRATION_SECRET" | tail -5
        TEMP_INTEGRATION_KEY=""
        exit 1
    fi

    export SW_CLIENT_ID="$TEMP_INTEGRATION_KEY"
    export SW_CLIENT_SECRET="$TEMP_INTEGRATION_SECRET"
    echo "Created temporary integration '$integration_name' in sw-dev lane '$SW_DEV_LANE'"
}

delete_temp_integration() {
    [ -z "$TEMP_INTEGRATION_KEY" ] && return 0

    local token integration_id
    token=$(fetch_temp_integration_token || true)
    if [ -z "$token" ]; then
        echo "WARNING: Could not authenticate to delete temporary integration $TEMP_INTEGRATION_KEY. Delete it in the admin."
        return 0
    fi

    integration_id=$(curl -sf -X POST "$SW_ENV_URL/api/search/integration" \
        -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
        -d "{\"filter\":[{\"type\":\"equals\",\"field\":\"accessKey\",\"value\":\"$TEMP_INTEGRATION_KEY\"}],\"includes\":{\"integration\":[\"id\"]}}" |
        jq -r '.data[0].id // empty' || true)

    if [ -n "$integration_id" ] &&
        curl -sf -o /dev/null -X DELETE "$SW_ENV_URL/api/integration/$integration_id" -H "Authorization: Bearer $token"; then
        echo "Deleted temporary integration $TEMP_INTEGRATION_KEY"
        TEMP_INTEGRATION_KEY=""
        return 0
    fi
    echo "WARNING: Failed to delete temporary integration $TEMP_INTEGRATION_KEY. Delete it in the admin."
}

# Derive name from URL if --url is provided and --name is not
if [ -z "$CUSTOM_NAME" ] && [ -n "$INSPIRE_URL" ]; then
    CUSTOM_NAME=$(echo "$INSPIRE_URL" | sed -E 's|https?://||' | sed 's|^www\.||' | cut -d. -f1 | cut -d/ -f1)
fi

# Determine SalesChannel name and description
SKIP_CREATE=false
if [ -n "$REUSE_NAME" ]; then
    TEST_SALESCHANNEL="$REUSE_NAME"
    SKIP_CREATE=true
    echo "Reusing existing blueprint: $TEST_SALESCHANNEL"
elif [ -n "$CLEANUP_ONLY" ]; then
    TEST_SALESCHANNEL="$CLEANUP_ONLY"
elif [ -n "$CUSTOM_NAME" ]; then
    TEST_SALESCHANNEL="$CUSTOM_NAME"
else
    TEST_SALESCHANNEL="e2e-test-kids-store-$(date +%s)"
fi

# Default description: custom if provided, otherwise a generic fallback
if [ -n "$CUSTOM_DESCRIPTION" ]; then
    TEST_DESCRIPTION="$CUSTOM_DESCRIPTION"
elif [ -z "$INSPIRE_URL" ]; then
    TEST_DESCRIPTION="Kids store selling toys, books and games."
else
    TEST_DESCRIPTION="$TEST_SALESCHANNEL webshop"
fi

if [ -n "$SW_DEV_LANE" ]; then
    trap delete_temp_integration EXIT
    create_temp_integration
fi

SW_URL="${SW_ENV_URL:-http://localhost:8000}"

echo "=== E2E Test: $TEST_SALESCHANNEL ==="
echo "Target: $SW_URL"
echo "Description: $TEST_DESCRIPTION"
[ -n "$INSPIRE_URL" ] && echo "Inspire URL: $INSPIRE_URL"
echo "Phases: create=$([[ $SKIP_CREATE == true ]] && echo skip || echo run) | inspire=$([[ -z $INSPIRE_URL ]] && echo skip || echo run) | hydrate=$([[ $SKIP_HYDRATE == true ]] && echo skip || echo run) | upload=$([[ $SKIP_UPLOAD == true ]] && echo skip || echo run) | verify=$([[ $SKIP_VERIFY == true ]] && echo skip || echo run)"
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
    delete_temp_integration
}
trap cleanup EXIT

# Cleanup only mode
if [ -n "$CLEANUP_ONLY" ]; then
    echo "Running cleanup for $CLEANUP_ONLY..."

    # Cleanup CMS processors first (reverse order)
    echo "  Cleaning up CMS processors..."
    bun run cleanup -- --salesChannel="$CLEANUP_ONLY" --processors=cms-testing || true
    bun run cleanup -- --salesChannel="$CLEANUP_ONLY" --processors=cms-text,cms-images,cms-video,cms-text-images,cms-commerce,cms-form || true
    bun run cleanup -- --salesChannel="$CLEANUP_ONLY" --processors=cms-home || true
    bun run cleanup -- --salesChannel="$CLEANUP_ONLY" --processors=images || true

    # Cleanup digital product, cross-selling, customers, promotions, theme
    echo "  Cleaning up digital product, cross-selling, customers, promotions, theme..."
    bun run cleanup -- --salesChannel="$CLEANUP_ONLY" --processors=digital-product || true
    bun run cleanup -- --salesChannel="$CLEANUP_ONLY" --processors=cross-selling || true
    bun run cleanup -- --salesChannel="$CLEANUP_ONLY" --processors=customers || true
    bun run cleanup -- --salesChannel="$CLEANUP_ONLY" --processors=promotions || true
    bun run cleanup -- --salesChannel="$CLEANUP_ONLY" --processors=theme || true

    # Cleanup SalesChannel and data
    echo "  Cleaning up SalesChannel..."
    bun run cleanup -- --salesChannel="$CLEANUP_ONLY" --delete || echo "Cleanup skipped (nothing to clean)"

    # Safely remove property groups no longer used by any product
    echo "  Cleaning up unused property groups..."
    bun run cleanup -- --unused-props || true

    echo "Cleanup complete."
    exit 0
fi

# Phase 0: Crawl real store for inspiration (optional, runs BEFORE blueprint creation
# so the brand description can inform the blueprint)
if [ -n "$INSPIRE_URL" ] && [ "$SKIP_CREATE" = false ]; then
    if [ -f "generated/sales-channels/$TEST_SALESCHANNEL/inspiration.json" ]; then
        echo "[0/5] Skipping inspire (inspiration.json already exists)"
    else
        echo "[0/5] Crawling $INSPIRE_URL for inspiration..."
        bun run blueprint inspire --name="$TEST_SALESCHANNEL" --url="$INSPIRE_URL"
        echo "✓ Inspiration saved"
    fi
    # Use brandDescription from inspiration as description fallback if not explicitly provided
    if [ -z "$CUSTOM_DESCRIPTION" ] && [ -f "generated/sales-channels/$TEST_SALESCHANNEL/inspiration.json" ]; then
        BRAND_DESC=$(jq -r '.brandDescription // empty' "generated/sales-channels/$TEST_SALESCHANNEL/inspiration.json" 2>/dev/null || true)
        if [ -n "$BRAND_DESC" ]; then
            TEST_DESCRIPTION="$BRAND_DESC"
            echo "  Using brand description from inspiration: $TEST_DESCRIPTION"
        fi
    fi
    echo ""
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
    bun run blueprint create --name="$TEST_SALESCHANNEL" --description="$TEST_DESCRIPTION" --products=10

    if [ ! -f "generated/sales-channels/$TEST_SALESCHANNEL/blueprint.json" ]; then
        echo "ERROR: blueprint.json not created"
        exit 1
    fi
    echo "✓ Blueprint created"
fi
echo ""

# Phase 2: Hydrate with AI (products + categories + CMS text)
if [ "$SKIP_HYDRATE" = true ]; then
    echo "[2/5] Skipping AI hydration (--skip-hydrate)"
    if [ ! -f "generated/sales-channels/$TEST_SALESCHANNEL/hydrated-blueprint.json" ]; then
        echo "WARNING: No hydrated blueprint found. Upload may fail."
    fi
elif [ -f "generated/sales-channels/$TEST_SALESCHANNEL/hydrated-blueprint.json" ]; then
    echo "[2/5] Skipping AI hydration (hydrated blueprint already exists)"
    # Still hydrate CMS text if not done yet
    if [ ! -f "generated/sales-channels/$TEST_SALESCHANNEL/cms-blueprint.json" ]; then
        echo "  Hydrating CMS text content..."
        bun run blueprint hydrate --name="$TEST_SALESCHANNEL" --only=cms
        echo "  ✓ CMS text hydrated"
    fi
else
    echo "[2/5] Hydrating blueprint with AI (includes CMS text)..."
    bun run blueprint hydrate --name="$TEST_SALESCHANNEL"

    if [ ! -f "generated/sales-channels/$TEST_SALESCHANNEL/hydrated-blueprint.json" ]; then
        echo "ERROR: hydrated-blueprint.json not created"
        exit 1
    fi
    if [ ! -f "generated/sales-channels/$TEST_SALESCHANNEL/cms-blueprint.json" ]; then
        echo "WARNING: cms-blueprint.json not created (CMS text will use fixture defaults)"
    fi
    echo "✓ Blueprint hydrated (products + categories + CMS text)"
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

    # Run CMS homepage processor (root category layout)
    echo "  Running CMS homepage processor..."
    bun run process --name="$TEST_SALESCHANNEL" --only=cms-home

    # Run CMS element processors (create demo pages)
    echo "  Running CMS processors..."
    bun run process --name="$TEST_SALESCHANNEL" --only=cms-text,cms-images,cms-video,cms-text-images,cms-commerce,cms-form

    # Upload pre-generated product + category images
    echo "  Running image processor..."
    bun run process --name="$TEST_SALESCHANNEL" --only=images

    # Run digital product processor (create gift card)
    echo "  Running digital product processor..."
    bun run process --name="$TEST_SALESCHANNEL" --only=digital-product

    # Run CMS testing processor (create Testing category hierarchy)
    echo "  Running CMS testing orchestrator..."
    bun run process --name="$TEST_SALESCHANNEL" --only=cms-testing

    # Run theme processor (child theme with brand colors + media)
    echo "  Running theme processor..."
    bun run process --name="$TEST_SALESCHANNEL" --only=theme

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
