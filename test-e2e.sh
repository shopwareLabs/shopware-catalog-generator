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
#   ./test-e2e.sh --reuse=<name> --languages=none                    # English only (default: de-DE)
#
#   ./test-e2e-lanes.sh --lanes=sw65,sw66,sw67,sw68,trunk           # Same content on several lanes (see that script)
#
# Environment:
# - CACHE_DIR       cache root (default ./generated)
# - E2E_LANGUAGES   translation locales for the hydrate phase (default de-DE, "none" to skip);
#                   --languages=... overrides it. Unchanged texts are reused, so reruns are cheap.
# - E2E_RESULT_DIR  if set, writes steps.tsv (step, status) and verify.json there
#
# --sw-dev=<lane> targets a local sw-dev lane (see `sw-dev list`) instead of .env:
# - SW_ENV_URL is set to the lane's APP_URL
# - A temporary admin integration is created via bin/console integration:create
# - Its credentials are only exported to this script's child processes
# - The integration is deleted via the Admin API when the script exits (pass or fail)
#
# `generate` already runs every processor. Phase 4 runs them again in groups to check that
# each one is idempotent (each group runs even if an earlier one failed; the phase fails at the end):
# - Catalog: manufacturers, variants, variant-images (colour images per colour variant)
# - Reviews: reviews (spread across the SalesChannel languages)
# - CMS homepage: customers, promotions, cross-selling, cms-home (one group: the homepage only
#   shows the credentials, promotion codes and cross-selling of processors in the same run)
# - CMS element pages: cms-text, cms-images, cms-video, cms-text-images, cms-commerce, cms-form,
#   cms-footer-pages
# - Images: images (upload pre-generated product + category images)
# - Fixture products: digital-product (Gift Card €50), media-product (3D models + videos)
# - CMS orchestrator: cms-testing (creates Testing category hierarchy)
# - Theme: theme (child theme with brand colors + media)
# - Translations: translations (cached translations per SalesChannel language, runs last)
#
# Verify then checks every feature (tests/e2e/checks/). Checks for a feature the connected
# Shopware version does not support are skipped, using src/fixtures/shopware-features.ts.

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
LANGUAGES="${E2E_LANGUAGES:-de-DE}"

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
        --languages=*)
            LANGUAGES="${arg#*=}"
            ;;
    esac
done

CACHE_ROOT="${CACHE_DIR:-./generated}"
CURRENT_STEP=""

# Record step results for the lane matrix (no-op without E2E_RESULT_DIR)
record_step() {
    [ -z "$E2E_RESULT_DIR" ] && return 0
    mkdir -p "$E2E_RESULT_DIR"
    printf '%s\t%s\n' "$1" "$2" >> "$E2E_RESULT_DIR/steps.tsv"
}

# Run a step; on failure record it and let set -e stop the script
run_step() {
    local step="$1"
    shift
    CURRENT_STEP="$step"
    "$@"
    record_step "$step" pass
    CURRENT_STEP=""
}

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

# Fallback for lanes without `integration:create --access-key`: log in as the lane admin
# (SW_DEV_ADMIN_USER / SW_DEV_ADMIN_PASSWORD, default admin / shopware) and POST the integration
create_temp_integration_via_api() {
    local admin_token
    admin_token=$(curl -sf -X POST "$SW_ENV_URL/api/oauth/token" \
        -H 'Content-Type: application/json' \
        -d "$(jq -n --arg u "${SW_DEV_ADMIN_USER:-admin}" --arg p "${SW_DEV_ADMIN_PASSWORD:-shopware}" \
            '{grant_type: "password", client_id: "administration", scopes: "write", username: $u, password: $p}')" |
        jq -r '.access_token // empty' || true)
    [ -z "$admin_token" ] && return 1

    curl -sf -o /dev/null -X POST "$SW_ENV_URL/api/integration" \
        -H "Authorization: Bearer $admin_token" -H 'Content-Type: application/json' \
        -d "$(jq -n --arg label "$1" --arg key "$TEMP_INTEGRATION_KEY" --arg secret "$TEMP_INTEGRATION_SECRET" \
            '{label: $label, accessKey: $key, secretAccessKey: $secret, admin: true}')" || return 1

    [ -n "$(fetch_temp_integration_token || true)" ]
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

    # The pipe in sw_dev_exec hides the exit code, so prove the credentials work instead.
    # Before 6.7 the command is missing (6.5) or has no key options (6.6): use the Admin API.
    if [ -z "$(fetch_temp_integration_token || true)" ] &&
        ! create_temp_integration_via_api "$integration_name"; then
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
    record_step connect pass
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
        [ -n "$CURRENT_STEP" ] && record_step "$CURRENT_STEP" fail
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

    # Product images stay on disk after their products are deleted
    echo "  Cleaning up orphaned product media..."
    bun run cleanup -- --orphaned-media || true

    echo "Cleanup complete."
    exit 0
fi

# Phase 0: Crawl real store for inspiration (optional, runs BEFORE blueprint creation
# so the brand description can inform the blueprint)
if [ -n "$INSPIRE_URL" ] && [ "$SKIP_CREATE" = false ]; then
    if [ -f "$CACHE_ROOT/sales-channels/$TEST_SALESCHANNEL/inspiration.json" ]; then
        echo "[0/5] Skipping inspire (inspiration.json already exists)"
    else
        echo "[0/5] Crawling $INSPIRE_URL for inspiration..."
        bun run blueprint inspire --name="$TEST_SALESCHANNEL" --url="$INSPIRE_URL"
        echo "✓ Inspiration saved"
    fi
    # Use brandDescription from inspiration as description fallback if not explicitly provided
    if [ -z "$CUSTOM_DESCRIPTION" ] && [ -f "$CACHE_ROOT/sales-channels/$TEST_SALESCHANNEL/inspiration.json" ]; then
        BRAND_DESC=$(jq -r '.brandDescription // empty' "$CACHE_ROOT/sales-channels/$TEST_SALESCHANNEL/inspiration.json" 2>/dev/null || true)
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
    if [ ! -f "$CACHE_ROOT/sales-channels/$TEST_SALESCHANNEL/blueprint.json" ]; then
        echo "ERROR: No blueprint found at $CACHE_ROOT/sales-channels/$TEST_SALESCHANNEL/blueprint.json"
        exit 1
    fi
else
    echo "[1/5] Creating blueprint..."
    run_step create bun run blueprint create --name="$TEST_SALESCHANNEL" --description="$TEST_DESCRIPTION" --products=10

    if [ ! -f "$CACHE_ROOT/sales-channels/$TEST_SALESCHANNEL/blueprint.json" ]; then
        echo "ERROR: blueprint.json not created"
        exit 1
    fi
    echo "✓ Blueprint created"
fi
echo ""

# Phase 2: Hydrate with AI (products + categories + CMS text)
if [ "$SKIP_HYDRATE" = true ]; then
    echo "[2/5] Skipping AI hydration (--skip-hydrate)"
    if [ ! -f "$CACHE_ROOT/sales-channels/$TEST_SALESCHANNEL/hydrated-blueprint.json" ]; then
        echo "WARNING: No hydrated blueprint found. Upload may fail."
    fi
elif [ -f "$CACHE_ROOT/sales-channels/$TEST_SALESCHANNEL/hydrated-blueprint.json" ]; then
    echo "[2/5] Skipping AI hydration (hydrated blueprint already exists)"
    # Still hydrate CMS text if not done yet
    if [ ! -f "$CACHE_ROOT/sales-channels/$TEST_SALESCHANNEL/cms-blueprint.json" ]; then
        echo "  Hydrating CMS text content..."
        bun run blueprint hydrate --name="$TEST_SALESCHANNEL" --only=cms
        echo "  ✓ CMS text hydrated"
    fi
else
    echo "[2/5] Hydrating blueprint with AI (includes CMS text)..."
    run_step hydrate bun run blueprint hydrate --name="$TEST_SALESCHANNEL"

    if [ ! -f "$CACHE_ROOT/sales-channels/$TEST_SALESCHANNEL/hydrated-blueprint.json" ]; then
        echo "ERROR: hydrated-blueprint.json not created"
        exit 1
    fi
    if [ ! -f "$CACHE_ROOT/sales-channels/$TEST_SALESCHANNEL/cms-blueprint.json" ]; then
        echo "WARNING: cms-blueprint.json not created (CMS text will use fixture defaults)"
    fi
    echo "✓ Blueprint hydrated (products + categories + CMS text)"
fi

# Phase 2b: translate (AI, reuses unchanged entries of earlier runs)
if [ "$SKIP_HYDRATE" = true ] || [ "$LANGUAGES" = "none" ]; then
    echo "[2b/5] Skipping translation (cached translations are still uploaded)"
elif [ -f "$CACHE_ROOT/sales-channels/$TEST_SALESCHANNEL/hydrated-blueprint.json" ]; then
    echo "[2b/5] Translating catalog ($LANGUAGES)..."
    run_step translate bun run blueprint translate --name="$TEST_SALESCHANNEL" --languages="$LANGUAGES"
    echo "✓ Catalog translated"
fi
echo ""

# Phase 3: Generate (upload to Shopware)
if [ "$SKIP_UPLOAD" = true ]; then
    echo "[3/5] Skipping Shopware upload"
elif [ ! -f "$CACHE_ROOT/sales-channels/$TEST_SALESCHANNEL/hydrated-blueprint.json" ]; then
    echo "[3/5] Skipping upload (no hydrated blueprint)"
else
    echo "[3/5] Uploading to Shopware..."
    run_step upload bun run generate --name="$TEST_SALESCHANNEL"
    echo "✓ Uploaded to Shopware"
fi
echo ""

# Phase 4: Run post-processors
if [ "$SKIP_UPLOAD" = true ]; then
    echo "[4/5] Skipping post-processors"
elif [ ! -f "$CACHE_ROOT/sales-channels/$TEST_SALESCHANNEL/hydrated-blueprint.json" ]; then
    echo "[4/5] Skipping post-processors (no hydrated blueprint)"
else
    echo "[4/5] Running post-processors..."

    # Order matters: cms-testing links the CMS pages, the digital and the media product;
    # translations go last because they translate what the other processors created
    PROCESSOR_STEPS=(
        "manufacturers,variants,variant-images"
        "reviews"
        "customers,promotions,cross-selling,cms-home"
        "cms-text,cms-images,cms-video,cms-text-images,cms-commerce,cms-form,cms-footer-pages"
        "images"
        "digital-product,media-product"
        "cms-testing"
        "theme"
        "translations"
    )
    FAILED_PROCESSORS=()
    for processors in "${PROCESSOR_STEPS[@]}"; do
        echo "  Running $processors..."
        if bun run process --name="$TEST_SALESCHANNEL" --only="$processors"; then
            record_step "process:$processors" pass
            continue
        fi
        record_step "process:$processors" fail
        FAILED_PROCESSORS+=("$processors")
    done

    if [ ${#FAILED_PROCESSORS[@]} -gt 0 ]; then
        echo "ERROR: Post-processors failed: ${FAILED_PROCESSORS[*]}"
        exit 1
    fi
    echo "✓ Post-processors complete"
fi
echo ""

# Phase 5: Verify via API
if [ "$SKIP_VERIFY" = true ]; then
    echo "[5/5] Skipping verification"
else
    echo "[5/5] Verifying via Shopware API..."
    VERIFY_ARGS=(--name="$TEST_SALESCHANNEL")
    [ -n "$E2E_RESULT_DIR" ] && VERIFY_ARGS+=(--json="$E2E_RESULT_DIR/verify.json")
    run_step verify bun run test:verify "${VERIFY_ARGS[@]}"
    echo "✓ API verification passed"
fi
echo ""

echo "=== E2E Test PASSED ==="
echo ""
echo "Storefront URL: http://$TEST_SALESCHANNEL.${SW_URL#*://}"
echo ""
echo "To inspect the generated data:"
echo "  cat $CACHE_ROOT/sales-channels/$TEST_SALESCHANNEL/blueprint.json | jq ."
echo ""
echo "To cleanup:"
echo "  bun run cleanup -- --salesChannel=\"$TEST_SALESCHANNEL\" --delete"
echo ""
