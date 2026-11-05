#!/bin/bash
# test-e2e-lanes.sh - Run the same catalog against several local sw-dev lanes
#
# Creates and hydrates the catalog once (AI cost is paid once, without any shop),
# then runs upload → post-processors → verify on every lane via ./test-e2e.sh --sw-dev.
# A failing lane does not stop the others. A summary table is printed at the end.
#
# Each lane gets its own cache copy under generated-lanes/<lane>/, because the cache
# stores shop-specific data (Shopware IDs, synced property groups).
#
# Usage:
#   ./test-e2e-lanes.sh                                          # New kids store on all default lanes
#   ./test-e2e-lanes.sh --lanes=67,trunk                         # Pick lanes (sw67 works as well)
#   ./test-e2e-lanes.sh --reuse=music                            # Reuse a blueprint from generated/
#   ./test-e2e-lanes.sh --name=myshop --description="..."        # Explicit name and description
#   ./test-e2e-lanes.sh --url=https://shop.com                   # Crawl for inspiration first
#   ./test-e2e-lanes.sh --lanes=65,67 --cleanup=<name>           # Remove the store from these lanes
#
# Default lanes: 65,66,67,68,trunk (see `sw-dev list`, LANE column)
#
# Output: e2e-results/<timestamp>/<lane>/{e2e.log,steps.tsv,verify.json} and summary.md
# Exit code: 0 only if every lane passed.

set -e

for arg in "$@"; do
    if [ "$arg" = "-h" ] || [ "$arg" = "--help" ]; then
        awk '/^# test-e2e-lanes\.sh/,/^set -e/' "$0" | grep '^#' | sed 's/^# \{0,1\}//'
        exit 0
    fi
done

LANES_ARG="65,66,67,68,trunk"
REUSE_NAME=""
CUSTOM_NAME=""
CUSTOM_DESCRIPTION=""
INSPIRE_URL=""
CLEANUP_NAME=""

for arg in "$@"; do
    case $arg in
        --lanes=*) LANES_ARG="${arg#*=}" ;;
        --reuse=*) REUSE_NAME="${arg#*=}" ;;
        --name=*) CUSTOM_NAME="${arg#*=}" ;;
        --description=*) CUSTOM_DESCRIPTION="${arg#*=}" ;;
        --url=*) INSPIRE_URL="${arg#*=}" ;;
        --cleanup=*) CLEANUP_NAME="${arg#*=}" ;;
        *)
            echo "ERROR: Unknown option $arg (see --help)"
            exit 1
            ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

SW_DEV_BIN="${SW_DEV_BIN:-$HOME/shopware-dev/bin/sw-dev}"
SOURCE_CACHE="${CACHE_DIR:-./generated}"
LANE_CACHE_ROOT="${LANE_CACHE_ROOT:-./generated-lanes}"
RUN_DIR="e2e-results/$(date +%Y%m%d-%H%M%S)"

# sw-dev expects the LANE column (67, trunk); accept the instance id (sw67) too
IFS=',' read -r -a RAW_LANES <<< "$LANES_ARG"
LANES=()
for lane in "${RAW_LANES[@]}"; do
    LANES+=("${lane#sw}")
done

if [ ! -x "$SW_DEV_BIN" ]; then
    echo "ERROR: sw-dev not found at $SW_DEV_BIN (set SW_DEV_BIN)"
    exit 1
fi

lane_shopware_version() {
    "$SW_DEV_BIN" lane exec "$1" bin/console --version 2>/dev/null |
        sed $'s/\x1b\\[[0-9;]*m//g' | tr -d '\r' |
        grep -oE 'Shopware [0-9][^ ]*' | head -1 | sed 's/^Shopware //'
}

# Fresh per-lane cache copy of the hydrated store (APFS clone when possible)
prepare_lane_cache() {
    local lane_cache="$LANE_CACHE_ROOT/$1"
    mkdir -p "$lane_cache/sales-channels"
    rm -rf "${lane_cache:?}/sales-channels/$NAME"
    cp -Rc "$SOURCE_CACHE/sales-channels/$NAME" "$lane_cache/sales-channels/" 2>/dev/null ||
        cp -R "$SOURCE_CACHE/sales-channels/$NAME" "$lane_cache/sales-channels/"
    if [ -d "$SOURCE_CACHE/properties" ]; then
        rm -rf "${lane_cache:?}/properties"
        cp -R "$SOURCE_CACHE/properties" "$lane_cache/"
    fi
}

# Cleanup mode: remove the store from every lane, using each lane's cache
if [ -n "$CLEANUP_NAME" ]; then
    FAILED=0
    for lane in "${LANES[@]}"; do
        echo "=== Cleanup $CLEANUP_NAME on lane $lane ==="
        mkdir -p "$LANE_CACHE_ROOT/$lane"
        CACHE_DIR="$LANE_CACHE_ROOT/$lane" ./test-e2e.sh --sw-dev="$lane" --cleanup="$CLEANUP_NAME" || FAILED=1
        rm -rf "${LANE_CACHE_ROOT:?}/$lane/sales-channels/$CLEANUP_NAME"
    done
    exit $FAILED
fi

# Phase A: create + hydrate once, without any shop, so content is lane-neutral
if [ -n "$REUSE_NAME" ]; then
    NAME="$REUSE_NAME"
    PREPARE_ARGS=(--reuse="$NAME")
else
    NAME="${CUSTOM_NAME:-e2e-lanes-$(date +%s)}"
    PREPARE_ARGS=(--name="$NAME")
    [ -n "$CUSTOM_DESCRIPTION" ] && PREPARE_ARGS+=(--description="$CUSTOM_DESCRIPTION")
    [ -n "$INSPIRE_URL" ] && PREPARE_ARGS+=(--url="$INSPIRE_URL")
fi

mkdir -p "$RUN_DIR"
echo "=== Lane matrix: $NAME on ${LANES[*]} ==="
echo "Results: $RUN_DIR"
echo ""
echo "[prepare] Creating and hydrating content once (log: $RUN_DIR/prepare.log)..."
if ! SW_ENV_URL="" CACHE_DIR="$SOURCE_CACHE" \
    ./test-e2e.sh "${PREPARE_ARGS[@]}" --skip-upload --skip-verify > "$RUN_DIR/prepare.log" 2>&1; then
    echo "ERROR: Preparing content failed. Last lines of $RUN_DIR/prepare.log:"
    tail -20 "$RUN_DIR/prepare.log"
    exit 1
fi
if [ ! -f "$SOURCE_CACHE/sales-channels/$NAME/hydrated-blueprint.json" ]; then
    echo "ERROR: No hydrated blueprint for $NAME after preparation"
    exit 1
fi
echo "✓ Content ready"
echo ""

# Phase B: upload → post-processors → verify on each lane (sequential, isolated caches)
for lane in "${LANES[@]}"; do
    lane_dir="$RUN_DIR/$lane"
    mkdir -p "$lane_dir"
    lane_shopware_version "$lane" > "$lane_dir/version.txt" || true
    echo "[lane $lane] Shopware $(cat "$lane_dir/version.txt") ..."

    prepare_lane_cache "$lane"
    if CACHE_DIR="$LANE_CACHE_ROOT/$lane" E2E_RESULT_DIR="$lane_dir" \
        ./test-e2e.sh --sw-dev="$lane" --reuse="$NAME" --skip-hydrate > "$lane_dir/e2e.log" 2>&1; then
        echo "  ✓ passed"
        continue
    fi
    echo "  ✗ failed (log: $lane_dir/e2e.log)"
done
echo ""

# Summary
step_status() {
    local file="$1/steps.tsv" status
    [ -f "$file" ] || { echo "-"; return; }
    status=$(awk -F'\t' -v s="$2" '$1 == s { print $2 }' "$file" | tail -1)
    echo "${status:--}"
}

processor_status() {
    local file="$1/steps.tsv" failed
    [ -f "$file" ] || { echo "-"; return; }
    grep -q $'^process:' "$file" || { echo "-"; return; }
    failed=$(awk -F'\t' '$1 ~ /^process:/ && $2 == "fail" { sub(/^process:/, "", $1); print $1 }' "$file" | paste -sd ' ' -)
    [ -z "$failed" ] && { echo "pass"; return; }
    echo "fail: $failed"
}

storefront_status() {
    local json="$1/verify.json"
    [ -f "$json" ] || { echo "-"; return; }
    # EN domain is <store>.<host>, DE domain is <store>-de.<host>
    jq -r '[.storefront.domains[] | "\(if (.url | sub("^https?://"; "") | split(".")[0] | endswith("-de")) then "DE" else "EN" end) \(.status // "error")"] | sort | if length == 0 then "-" else join(", ") end' "$json"
}

verify_errors() {
    local json="$1/verify.json"
    [ -f "$json" ] || { echo ""; return; }
    jq -r '.errors | if length == 0 then "" else "\(length) error(s): \(.[0])" end' "$json"
}

lane_passed() {
    local file="$1/steps.tsv"
    [ -f "$file" ] && ! grep -q $'\tfail$' "$file" && [ "$(step_status "$1" verify)" = "pass" ]
}

SUMMARY="$RUN_DIR/summary.md"
{
    echo "# Lane matrix: $NAME"
    echo ""
    echo "| Lane | Shopware | Result | Connect | Upload | Post-processors | Verify | Storefront | Notes |"
    echo "| ---- | -------- | ------ | ------- | ------ | --------------- | ------ | ---------- | ----- |"
    for lane in "${LANES[@]}"; do
        lane_dir="$RUN_DIR/$lane"
        result="FAIL"
        lane_passed "$lane_dir" && result="PASS"
        echo "| $lane | $(cat "$lane_dir/version.txt" 2>/dev/null) | $result | $(step_status "$lane_dir" connect) | $(step_status "$lane_dir" upload) | $(processor_status "$lane_dir") | $(step_status "$lane_dir" verify) | $(storefront_status "$lane_dir") | $(verify_errors "$lane_dir" | tr '|' '/') |"
    done
} > "$SUMMARY"

cat "$SUMMARY"
echo ""
echo "Logs: $RUN_DIR/<lane>/e2e.log"
echo "Cleanup: ./test-e2e-lanes.sh --lanes=$(IFS=,; echo "${LANES[*]}") --cleanup=$NAME"

for lane in "${LANES[@]}"; do
    lane_passed "$RUN_DIR/$lane" || exit 1
done
