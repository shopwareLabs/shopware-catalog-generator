# Concepts

This document explains the architecture and key concepts of the Shopware Catalog Generator.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [3-Phase Pipeline](#3-phase-pipeline)
- [HTTP Server Mode](#http-server-mode)
- [Property System](#property-system)
- [Post-Processor System](#post-processor-system)
- [AI Providers](#ai-providers)
- [Cache System](#cache-system)
- [Data Flow Examples](#data-flow-examples)

---

## Architecture Overview

The generator follows a modular architecture with clear separation of concerns:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              USER INPUT                                     │
│                        ┌───────────┐  ┌───────────┐                         │
│                        │    CLI    │  │ HTTP API  │                         │
│                        └─────┬─────┘  └─────┬─────┘                         │
└──────────────────────────────┼──────────────┼───────────────────────────────┘
                               │              │
                               ⯆              ⯆
┌─────────────────────────────────────────────────────────────────────────────┐
│                            CORE PIPELINE                                    │
│  ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐         │
│  │    Blueprint     │──>│    Blueprint     │──>│    Shopware      │         │
│  │    Generator     │   │    Hydrator      │   │    Uploader      │         │
│  └──────────────────┘   └────────┬─────────┘   └────────┬─────────┘         │
└──────────────────────────────────┼──────────────────────┼───────────────────┘
                                   │                      │
                    ┌──────────────┼──────────────────────┼──────────────┐
                    │              ⯆                      ⯆              │
                    │  ┌──────────────────┐   ┌──────────────────┐       │
                    │  │   AI Provider    │   │   Shopware API   │       │
                    │  │  (Text/Images)   │   │   (Admin API)    │       │
                    │  └──────────────────┘   └──────────────────┘       │
                    │           EXTERNAL SERVICES                        │
                    └────────────────────────────────────────────────────┘
                                              │
                                              ⯆
┌─────────────────────────────────────────────────────────────────────────────┐
│                          POST-PROCESSORS                                    │
│     ┌────────┐  ┌────────┐  ┌─────────┐  ┌──────────┐  ┌──────────┐         │
│     │ Images │  │  CMS   │  │ Reviews │  │Manufactu-│  │ Variants │         │
│     │        │  │ Pages  │  │         │  │   rers   │  │          │         │
│     └────────┘  └────────┘  └─────────┘  └──────────┘  └──────────┘         │
└─────────────────────────────────────────────────────────────────────────────┘
                               │
                               ⯆
┌─────────────────────────────────────────────────────────────────────────────┐
│                           LOCAL STORAGE                                     │
│              ┌──────────────────┐   ┌──────────────────┐                    │
│              │  generated/      │   │  logs/           │                    │
│              │  (cache)         │   │  (debug logs)    │                    │
│              └──────────────────┘   └──────────────────┘                    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3-Phase Pipeline

The generator uses a 3-phase pipeline that separates structure generation from AI content:

### Phase 1: Blueprint Creation

Creates the complete structure instantly without any AI calls:

- Category tree (3 levels, configurable depth)
- Product placeholders with metadata
- Cross-category assignments
- Variant flags and review counts

```
┌─────────────────┐      ┌─────────────────────────┐      ┌─────────────────┐
│     INPUT       │      │   BLUEPRINT GENERATOR   │      │     OUTPUT      │
│                 │      │                         │      │                 │
│  name: music    │─────>│  • Category Tree        │─────>│ blueprint.json  │
│  desc: "..."    │      │  • Product Placeholders │      │                 │
│  products: 90   │      │  • Metadata             │      │                 │
└─────────────────┘      └─────────────────────────┘      └─────────────────┘
                                   │
                                   │ No AI calls
                                   │ Instant (~100ms)
                                   ⯆
```

**Output:** `generated/sales-channels/{name}/blueprint.json`

### Phase 2: AI Hydration

Fills the blueprint with AI-generated content:

- Category names and descriptions
- Product names and descriptions
- Property assignments
- Image prompts
- Manufacturer names
- Variant property suggestions

```
┌─────────────────┐                                       ┌─────────────────┐
│     INPUT       │                                       │     OUTPUT      │
│                 │      ┌─────────────────────────┐      │                 │
│ blueprint.json  │─────>│    BLUEPRINT HYDRATOR   │─────>│ hydrated-       │
│                 │      │                         │      │ blueprint.json  │
│ Property Cache  │─────>│  • Category Content     │      │                 │
│                 │      │  • Product Content      │      │                 │
└─────────────────┘      │  • Variant Configs      │      └─────────────────┘
                         └───────────┬─────────────┘
                                     │
                              ┌──────┴──────┐
                              ⯆             ⯆
                    ┌──────────────┐  ┌──────────────┐
                    │ AI Provider  │  │ Property     │
                    │ (parallel)   │  │ Cache        │
                    └──────────────┘  └──────────────┘
```

**Output:** `generated/sales-channels/{name}/hydrated-blueprint.json`

### Phase 3: Upload + Post-Processing

Uploads to Shopware and runs post-processors:

```
┌─────────────────┐      ┌─────────────────────────┐      ┌─────────────────┐
│     INPUT       │      │    SHOPWARE UPLOAD      │      │  POST-PROCESS   │
│                 │      │                         │      │                 │
│ hydrated-       │─────>│  1. Create SalesChannel │─────>│  • Images       │
│ blueprint.json  │      │  2. Create Categories   │      │  • Manufacturers│
│                 │      │  3. Create Prop Groups  │      │  • Reviews      │
│                 │      │  4. Create Products     │      │  • Variants     │
└─────────────────┘      └───────────┬─────────────┘      │  • CMS Pages    │
                                     │                    └────────┬────────┘
                                     ⯆                             │
                         ┌──────────────────────┐                  │
                         │    Shopware API      │<─────────────────┘
                         └──────────────────────┘
```

---

## HTTP Server Mode

The generator can run as an HTTP service with background processing for long-running tasks.

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           HTTP SERVER (Bun.serve)                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   POST /generate              GET /status/:id              GET /health      │
│        │                           │                            │           │
│        ⯆                           ⯆                            ⯆           │
│   ┌──────────────┐          ┌──────────────┐           ┌──────────────┐     │
│   │    Start     │          │    Query     │           │    Stats     │     │
│   │  Background  │          │   Process    │           │   + Uptime   │     │
│   │    Task      │          │    State     │           │              │     │
│   └──────┬───────┘          └──────────────┘           └──────────────┘     │
│          │                         ↑                                        │
│          ⯆                         │                                        │
│   ┌─────────────────────────────────────────────────────────────────┐       │
│   │                      PROCESS MANAGER                            │       │
│   │                                                                 │       │
│   │   ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐            │       │
│   │   │ proc_1  │  │ proc_2  │  │ proc_3  │  │  ...    │            │       │
│   │   │ running │  │complete │  │ failed  │  │         │            │       │
│   │   └─────────┘  └─────────┘  └─────────┘  └─────────┘            │       │
│   │                                                                 │       │
│   │   • Tracks status, progress, logs                               │       │
│   │   • Auto-cleanup after 30 minutes                               │       │
│   └─────────────────────────────────────────────────────────────────┘       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Request Flow

```
Client                       Server                      ProcessManager
   │                           │                              │
   │  POST /generate           │                              │
   │  {salesChannel: "music"}  │                              │
   │──────────────────────────>│                              │
   │                           │                              │
   │                           │  start("Generate music")     │
   │                           │─────────────────────────────>│
   │                           │                              │
   │                           │      processId               │
   │                           │<─────────────────────────────│
   │                           │                              │
   │  {processId: "proc_xxx"}  │                              │  ┌──────────────┐
   │<──────────────────────────│                              │  │  Background  │
   │                           │                              │  │  Task Runs   │
   │                           │                              │  │  (async)     │
   │  GET /status/proc_xxx     │                              │  └──────────────┘
   │──────────────────────────>│                              │        │
   │                           │  get(processId)              │        │
   │                           │─────────────────────────────>│        │
   │                           │                              │        │
   │                           │  {status, progress, logs}    │        │
   │                           │<─────────────────────────────│        │
   │                           │                              │        │
   │  {status: "running",      │                              │        │
   │   progress: {phase:...},  │                              │        │
   │   logs: [...]}            │                              │        │
   │<──────────────────────────│                              │        │
   │                           │                              │        │
   │  ... (poll periodically)  │                              │        ⯆
   │                           │                              │
   │  GET /status/proc_xxx     │                              │  Task completes
   │──────────────────────────>│                              │
   │                           │                              │
   │  {status: "completed",    │                              │
   │   result: {products: 90}} │                              │
   │<──────────────────────────│                              │
```

### Endpoints

| Method | Endpoint       | Description                              |
|--------|----------------|------------------------------------------|
| POST   | `/generate`    | Start background generation              |
| GET    | `/status/:id`  | Poll process status, progress, and logs  |
| GET    | `/health`      | Health check with active process count   |

### Process States

```
    ┌─────────┐
    │ pending │ ← Initial state
    └────┬────┘
         │ Task starts
         ⯆
    ┌─────────┐
    │ running │ ← Processing
    └────┬────┘
         │
    ┌────┴────┐
    │         │
    ⯆         ⯆
┌─────────┐ ┌────────┐
│completed│ │ failed │
└─────────┘ └────────┘
    │           │
    └─────┬─────┘
          │ After 30 min
          ⯆
    ┌──────────┐
    │ (deleted)│
    └──────────┘
```

### Progress Phases

The generate task reports progress through these phases:

| Phase       | Steps | Description                           |
|-------------|-------|---------------------------------------|
| auth        | 0-1   | Shopware authentication               |
| blueprint   | 0-2   | Create/load/hydrate blueprint         |
| upload      | 0-4   | Sync to Shopware                      |
| processors  | 0-N   | Run post-processors                   |

---

## Property System

The property system handles variant options with a smart caching approach.

### Property Cache

Located at `generated/properties/`, stores property group definitions:

```
generated/
  properties/
    size.json          # Common: Size options
    color.json         # Common: Color options
    guitar-finish.json # Domain-specific: Guitar finishes
    pickup-type.json   # AI-generated: New groups
    ...
```

### Variant Generation Flow

```
                         DURING AI HYDRATION
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  Variant Product                                                 │
│       │                                                          │
│       ⯆                                                          │
│  AI suggests group names                                         │
│  (e.g., ["Finish", "Body Wood"])                                 │
│       │                                                          │
│       ⯆                                                          │
│  ┌────────────────────────────┐                                  │
│  │   Group in cache?          │                                  │
│  └────────────┬───────────────┘                                  │
│               │                                                  │
│       ┌───────┴───────┐                                          │
│       │               │                                          │
│      YES              NO                                         │
│       │               │                                          │
│       ⯆               ⯆                                          │
│  Use cached      AI generates                                    │
│  options         new options                                     │
│       │               │                                          │
│       │               ⯆                                          │
│       │          Save to cache ──────> generated/properties/     │
│       │               │                                          │
│       └───────┬───────┘                                          │
│               │                                                  │
│               ⯆                                                  │
│  Select 40-60% of options                                        │
│               │                                                  │
│               ⯆                                                  │
│  Build variantConfigs                                            │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
                               │
                               ⯆
                    VARIANT PROCESSOR
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  ┌─────────────────────────┐                                     │
│  │  Group in Shopware?     │                                     │
│  └───────────┬─────────────┘                                     │
│              │                                                   │
│      ┌───────┴───────┐                                           │
│      │               │                                           │
│     NO              YES                                          │
│      │               │                                           │
│      ⯆               │                                           │
│  Create from         │                                           │
│  cache definition    │                                           │
│      │               │                                           │
│      └───────┬───────┘                                           │
│              │                                                   │
│              ⯆                                                   │
│  Create variant products (cartesian product)                     │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### How It Works

1. **AI suggests group names** based on product context
   - Guitar → `["Finish", "Body Wood"]`
   - T-Shirt → `["Size", "Color"]`

2. **Cache lookup** for each suggested group
   - Hit: Reuse cached options (consistency)
   - Miss: AI generates options, saved to cache

3. **Option selection**: 40-60% of available options per group

4. **Variant creation**: Cartesian product of all selected options

### Default Property Groups

Seeded from `src/fixtures/property-groups.ts` on first use:

| Category | Groups |
|----------|--------|
| Common | Size, Color, Material, Finish, Style, Pattern |
| Music | Body Wood, Pickup Configuration, Neck Wood, Guitar Finish, Drum Size |
| Fashion | Shoe Size, Waist Size, Length |

---

## Post-Processor System

Post-processors run after the main upload for resource-intensive tasks.

### Execution Order

Processors can declare dependencies to control execution order:

```
       ┌──────────────────────────────────────────────────┐
       │           NO DEPENDENCIES (parallel)             │
       │                                                  │
       │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ │
       │  │  CMS    │ │ Images  │ │Manufact-│ │ Reviews │ │
       │  │  Pages  │ │         │ │  urers  │ │         │ │
       │  └─────────┘ └─────────┘ └────┬────┘ └─────────┘ │
       │                               │                  │
       └───────────────────────────────┼──────────────────┘
                                       │
                                       │ depends on
                                       ⯆
                               ┌─────────────┐
                               │  Variants   │
                               └─────────────┘
```

### Available Processors

| Processor | Description | Dependencies |
|-----------|-------------|--------------|
| `cms` | CMS landing pages and category links | None |
| `images` | Product and category images | None |
| `manufacturers` | Fictional manufacturer creation | None |
| `reviews` | Product reviews (0-10 per product) | None |
| `variants` | Variant product creation | manufacturers |

### Processor Interface

Each processor implements:

```typescript
interface PostProcessor {
    readonly name: string;
    readonly description: string;
    readonly dependsOn: string[];

    process(context: PostProcessorContext): Promise<PostProcessorResult>;
    cleanup?(context: PostProcessorContext): Promise<PostProcessorCleanupResult>;
}
```

### Cleanup Support

Processors can implement `cleanup()` for reversible operations:

```bash
# Cleanup specific processor
bun run cleanup -- --salesChannel="furniture" --processors=cms

# Cleanup all processors
bun run cleanup -- --salesChannel="furniture" --processors=all
```

---

## AI Providers

The generator supports multiple AI providers with a unified interface.

### Provider Comparison

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            AI PROVIDERS                                     │
├─────────────────┬─────────────────────┬─────────────────────────────────────┤
│    PROVIDER     │   TEXT GENERATION   │   IMAGE GENERATION                  │
├─────────────────┼─────────────────────┼─────────────────────────────────────┤
│  OpenAI         │   GPT-4o            │   GPT Image 1.5                     │
│                 │   Parallel (5x)     │   Paid                              │
├─────────────────┼─────────────────────┼─────────────────────────────────────┤
│  GitHub Models  │   GPT-4o (Azure)    │   Uses Pollinations                 │
│                 │   Limited (2x)      │   Free                              │
├─────────────────┼─────────────────────┼─────────────────────────────────────┤
│  Pollinations   │   Various models    │   Flux models                       │
│                 │   Parallel w/ sk_*  │   Free                              │
└─────────────────┴─────────────────────┴─────────────────────────────────────┘
```

### Provider Selection

| Use Case | Recommended | Why |
|----------|-------------|-----|
| Testing/Demos | Pollinations | Free, no API key |
| GitHub users | GitHub Models | Uses existing token |
| Production | OpenAI | Best quality, parallel |
| High volume | OpenAI + sk_* | Maximum throughput |

### Interface

Providers implement `TextProvider` and/or `ImageProvider`:

```typescript
interface TextProvider {
    readonly name: string;
    readonly maxConcurrency: number;
    readonly tokenLimit: number;

    generateCompletion(
        messages: ChatMessage[],
        schema?: z.ZodTypeAny
    ): Promise<string>;
}
```

---

## Cache System

The generator caches all data locally for fast re-runs.

### Directory Structure

```
generated/
├── properties/                    # Global property cache
│   ├── size.json
│   ├── color.json
│   └── ...
└── sales-channels/
    └── furniture/                 # Per-SalesChannel data
        ├── metadata.json          # SalesChannel info
        ├── blueprint.json         # Phase 1 output
        ├── hydrated-blueprint.json# Phase 2 output
        ├── categories.json        # Category tree
        ├── property-groups.json   # Synced from Shopware
        ├── manufacturers.json     # Created manufacturers
        ├── metadata/
        │   └── {productId}.json   # Per-product metadata
        └── images/
            ├── {productId}-front.webp
            └── {productId}-front.json

logs/
└── generator-{timestamp}.log      # Detailed logs
```

### Cache Operations

```
┌────────────────────────────────────────────────────────────┐
│                    CACHE OPERATIONS                        │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  cache:list          List all cached SalesChannels         │
│       │                                                    │
│       ⯆                                                    │
│  cache:clear         Move to .trash/ (recoverable)         │
│       │                                                    │
│       ⯆                                                    │
│  cache:trash         View trash contents                   │
│       │                                                    │
│       ├─────────────────────────────┐                      │
│       ⯆                             ⯆                      │
│  cache:restore        OR       cache:empty-trash           │
│  (recover files)               (permanent delete)          │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

### Idempotent Operation

Running generate multiple times is safe:

```
  Run generate
       │
       ⯆
  ┌──────────────────────┐
  │ SalesChannel exists? │
  └──────────┬───────────┘
             │
     ┌───────┴───────┐
     │               │
    NO              YES
     │               │
     ⯆               ⯆
  Create        ┌────────────────┐
  new           │ Cache exists?  │
     │          └───────┬────────┘
     │                  │
     │          ┌───────┴───────┐
     │          │               │
     │         NO              YES
     │          │               │
     │          ⯆               ⯆
     │     Sync from        Use cache
     │     Shopware              │
     │          │               │
     └──────────┴───────┬───────┘
                        │
                        ⯆
               Generate missing
               (idempotent)
```

---

## Data Flow Examples

### Full Generation Flow

```
User                CLI              Blueprint        Hydrator          AI            Shopware
 │                   │               Generator           │              │                │
 │  generate         │                   │               │              │                │
 │  --name=music     │                   │               │              │                │
 │──────────────────>│                   │               │              │                │
 │                   │                   │               │              │                │
 │                   │  Create blueprint │               │              │                │
 │                   │──────────────────>│               │              │                │
 │                   │                   │               │              │                │
 │                   │   blueprint.json  │               │              │                │
 │                   │<──────────────────│               │              │                │
 │                   │                   │               │              │                │
 │                   │  Hydrate                          │              │                │
 │                   │──────────────────────────────────>│              │                │
 │                   │                                   │              │                │
 │                   │                                   │  Generate    │                │
 │                   │                                   │  content     │                │
 │                   │                                   │─────────────>│                │
 │                   │                                   │              │                │
 │                   │                                   │  Names, etc  │                │
 │                   │                                   │<─────────────│                │
 │                   │                                   │              │                │
 │                   │   hydrated-blueprint.json         │              │                │
 │                   │<──────────────────────────────────│              │                │
 │                   │                   │               │              │                │
 │                   │  Upload                                                           │
 │                   │──────────────────────────────────────────────────────────────────>│
 │                   │                                                                   │
 │                   │  Post-processors (images, manufacturers, reviews, variants)       │
 │                   │──────────────────────────────────────────────────────────────────>│
 │                   │                                                                   │
 │   Complete!       │                                                                   │
 │<──────────────────│                                                                   │
```

### Property Resolution Flow

```
Hydrator          AI           Property         Variant         Shopware
    │              │            Cache           Processor           │
    │              │              │                │                │
    │  Suggest     │              │                │                │
    │  groups for  │              │                │                │
    │  "guitar"    │              │                │                │
    │─────────────>│              │                │                │
    │              │              │                │                │
    │  ["Finish",  │              │                │                │
    │   "Body      │              │                │                │
    │    Wood"]    │              │                │                │
    │<─────────────│              │                │                │
    │              │              │                │                │
    │  Has "Finish"?              │                │                │
    │────────────────────────────>│                │                │
    │              │              │                │                │
    │  Yes (cached)               │                │                │
    │<────────────────────────────│                │                │
    │              │              │                │                │
    │  Get options                │                │                │
    │────────────────────────────>│                │                │
    │              │              │                │                │
    │  [Sunburst,                 │                │                │
    │   Natural, ...]             │                │                │
    │<────────────────────────────│                │                │
    │              │              │                │                │
    │  Select 40-60%              │                │                │
    │  Build variantConfigs       │                │                │
    │              │              │                │                │
    │              │              │                │                │
    │  ════════════════════════════════════════════╪════════════════│
    │              │              │                │                │
    │              │              │  During post-  │                │
    │              │              │  processing    │                │
    │              │              │       │        │                │
    │              │              │       ⯆        │                │
    │              │              │  Check Shopware│                │
    │              │              │────────────────┼───────────────>│
    │              │              │                │                │
    │              │              │   Not found    │                │
    │              │              │<───────────────┼────────────────│
    │              │              │                │                │
    │              │  Get definition               │                │
    │              │<──────────────────────────────│                │
    │              │              │                │                │
    │              │  Full options + modifiers     │                │
    │              │───────────────────────────────>                │
    │              │              │                │                │
    │              │              │  Create group  │                │
    │              │              │────────────────┼───────────────>│
    │              │              │                │                │
    │              │              │  Create        │                │
    │              │              │  variants      │                │
    │              │              │────────────────┼───────────────>│
```

---

## See Also

- [AGENTS.md](AGENTS.md) - Developer documentation
- [README.md](README.md) - Quick start and CLI usage
