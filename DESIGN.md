---
name: Nemo public website
description: Warm editorial settings around an honest personal AI preview.
colors:
  editorial-paper: "#faf6ee"
  editorial-forest: "#25372f"
  editorial-cream: "#fff7e9"
  editorial-orange: "#ff8b45"
  message-outgoing: "#f88009"
  orange-dark: "#bd4d20"
  ink: "#20242a"
  muted: "#56514b"
  line: "#dbc7b8"
  illustration-paper: "#fff7ee"
  illustration-reply: "#f1e8df"
typography:
  display:
    fontFamily: "Ranade, Arial, sans-serif"
    fontSize: "clamp(48px, 5.6vw, 88px)"
    fontWeight: 500
    lineHeight: 1.035
    letterSpacing: "-0.04em"
  headline:
    fontFamily: "Ranade, Arial, sans-serif"
    fontSize: "clamp(42px, 5.3vw, 76px)"
    fontWeight: 500
    lineHeight: 1.08
    letterSpacing: "-0.04em"
  chapter:
    fontFamily: "Ranade, Arial, sans-serif"
    fontSize: "clamp(40px, 4vw, 58px)"
    fontWeight: 500
    lineHeight: 1.08
    letterSpacing: "-0.04em"
  title:
    fontFamily: "Ranade, Arial, sans-serif"
    fontSize: "clamp(24px, 2.5vw, 30px)"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "-0.045em"
  body:
    fontFamily: "Ranade, Arial, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.6
  disclosure:
    fontFamily: "Ranade, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.7
rounded:
  field: "8px"
  calendar: "12px"
  illustration: "16px"
  panel: "28px"
  action: "30px"
  navigation-action: "40px"
spacing:
  editorial-gutter: "clamp(22px, 5vw, 80px)"
  section-space: "clamp(88px, 10vw, 160px)"
  small: "12px"
  medium: "24px"
  large: "32px"
  composition: "48px"
  editorial-section: "120px"
components:
  button-primary:
    backgroundColor: "{colors.editorial-orange}"
    textColor: "{colors.ink}"
    rounded: "{rounded.action}"
    padding: "12px 24px"
  button-primary-hover:
    backgroundColor: "#ffb77f"
  button-dark:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.editorial-cream}"
    rounded: "{rounded.action}"
    padding: "12px 20px"
  navigation-action:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.editorial-cream}"
    rounded: "{rounded.navigation-action}"
    padding: "12px 22px"
  policy-summary:
    backgroundColor: "{colors.illustration-paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "32px"
  illustration-field:
    backgroundColor: "{colors.illustration-paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    padding: "16px 20px"
---

# Design System: Nemo public website

## Overview

**Creative North Star: "Personal AI, at home"**

Nemo places personal AI in a warm, lived-in setting. Ranade, orange conversation cues and the upright fictional phone remain the established identity; architectural daylight, forest-green narrative fields and open editorial spacing extend it. Photographic settings supply atmosphere while real HTML product illustrations explain the experience.

This records the local six-page implementation on 9 November 2026, not a published release. Visual authority is `docs/styles.css` followed by `docs/editorial.css`; the latter overrides the older peach stage and capsule navigation. This was an approved amplification of an existing world, with no selected comp, random seed or new identity tournament. Home persuades; Setup, About and policy pages remain readable reference surfaces.

**Key Characteristics:**

- Warm paper, forest shadow and clear orange, grounded by architectural photography.
- One Ranade voice for site copy; platform typography only inside the phone illustration.
- Open page composition, generous transitions and a large closing wordmark.
- Preview availability and current-versus-future boundaries travel with the visual story.

## Colors

Sunlit paper and timber tones meet a forest field. Frontmatter values are normative; these names explain their roles.

### Primary

- **Clear Orange** (`editorial-orange`): the setup action on the paper hero and emphasis on forest, plus active story progress.
- **Conversation Orange** (`message-outgoing`): outgoing fictional messages and illustrated setup actions.
- **Burnt Orange** (`orange-dark`): wordmark punctuation, policy emphasis and SVG detail on pale surfaces.

### Secondary

- **Forest Shadow** (`editorial-forest`): continuous story ground, shared question bubble and oversized footer wordmark.

### Neutral

- **Warm Paper / Warm Cream** (`editorial-paper`, `editorial-cream`): page/navigation ground and primary text on forest respectively.
- **Charcoal / Warm Graphite** (`ink`, `muted`): primary and secondary copy on pale surfaces.
- **Warm Rule** (`line`): separators in personal examples, setup and reading layouts.
- **Illustration Paper / Reply** (`illustration-paper`, `illustration-reply`): distinct message surfaces retained from the established phone.

**The Two Oranges Rule.** Use clear orange for emphasis on forest and the Home action; retain message orange inside product conversations. Dark orange carries emphasis on pale reading surfaces.

Photographic overlays, the orange closing band and hardware light use local composition colors, not general-purpose status tokens. The sidecar's eight-step tonal strips are synthesized display aids, not implemented CSS scales.

## Typography

**Display Font:** Ranade, with Arial and sans-serif fallback.

**Body Font:** Ranade, with the same fallback.

**Illustrative Phone Font:** `-apple-system`, BlinkMacSystemFont, Segoe UI, Arial, sans-serif, confined to the product illustration.

Regular and medium weights keep the voice direct. Large headings use tight tracking and balanced wrapping; orange emphasis is upright rather than italic. Frontmatter records desktop roles, with responsive overrides below.

### Hierarchy

- **Display:** Home promise; narrow layouts progressively scale to a 36–48px clamp at the smallest breakpoint.
- **Headline:** story and personal-example introductions; mobile steps are 48px and then 40px.
- **Chapter:** the three story headings; the smallest layout uses 40px.
- **Title:** policy-section headings. Page and setup titles have their own editorial scales.
- **Body:** main reading text; long explanations use 1.7–1.8 line-height. Policy text is at most 720px wide.
- **Disclosure:** availability, future-feature boundaries and captions. Small image credits never replace critical disclosures.

**The Readable Boundary Rule.** Main narrative copy stays at least 16px and critical preview, consent and future-feature statements at least 14px. Inert illustrative UI may scale with its artwork; its surrounding explanation and accessible transcript carry the meaning.

The decorative footer wordmark scales from 100px to 300px and is hidden from assistive technology. Prepare Ranade regular/medium WOFF2 files through the existing deployment process; retain licence/provenance notices rather than adding font binaries to public source.

## Layout

General content is at most 1280px wide. Desktop reading sections use 48px outer gutters, then 32px on narrower desktop; mobile uses the existing compact gutters. The full-bleed hero and navigation use the editorial gutter. Story introduction and personal sections use 120px desktop separation, falling to 88px and then 72px where appropriate.

Home retains phone left and promise right on one continuous cream surface. The approved composition uses continuous paper instead of a contained apricot stage or an orange field. Do not restore the rejected domestic photograph or split apricot background. The upright phone is fully visible at 270px wide, with a diffuse offset shadow and its caption below. Desktop columns have a 90px gap; at 960px and below, copy and availability precede the phone with a 32px gap. The three chapters share one continuous forest surface on desktop and mobile; mobile stacks explanation and illustration with separators.

Setup and About pair the Nemo wordmark and promise with a large photograph; below 760px text comes first. Setup remains three numbered, unboxed rows: Open Nemo, Connect your AI, Start a conversation. Rules and whitespace connect copy to inert illustrations. About retains its unframed Hermes comparison. Personal examples use three columns and separators, stacking on mobile. Policy pages pair sticky contents with readable text; mobile moves the index into normal flow and stacks summary cells. Page identity belongs in headings or ordinary copy without an above-heading kicker. The functional “On this page” index label remains.

Story pinning requires width at least 961px, height at least 740px and no reduced-motion preference. Native scrolling drives reversible transitions and progress without wheel/touch interception. Editorial parallax applies only above 960px without reduced motion. Smaller/shorter viewports, missing CSS/libraries and initialization failure retain complete normal-flow chapters. Preserve `#everyday`, `#family`, `#memory`, `#start`, `#hardware` and legacy `#how-it-works`/`#questions` mappings. Keep `#memory` outside the pinned stage so fragment navigation does not depend on animation geometry.

## Elevation & Depth

The page is open and mostly flat. Photography, forest-to-paper transitions, text scale and whitespace supply depth. The phone has a diffuse environmental shadow and metallic inset edges; illustrated messages retain local shadows. The calendar sheet uses a translucent pale surface and blur over the picnic. Hardware light/parallax belongs to the explicitly labelled abstract future impression.

### Shadow Vocabulary

- **Phone in setting:** `inset 0 0 0 1px #ecebe8, inset 0 0 0 3px #767572, 0 30px 60px #15201980`.
- **Illustrated reply:** `0 16px 40px #60432e17`, for memory and child-learning examples.
- **Action hover:** `0 8px 24px #5c38252a`, inherited by dark actions; the orange hero action removes it.

**The Grounded Surface Rule.** Page sections use color, spacing and rules to establish structure. Depth belongs to the phone, message illustrations and the explicitly abstract hardware impression; the navigation and policy summary have no shadow.

## Shapes

Full-width imagery, navigation, hardware and closing sections have square outer geometry. The policy summary retains its panel radius and border without shadow. Product illustrations use softer forms: 16px chapter surfaces, a 12px calendar sheet, an 8px setup field and pill-shaped actions. The phone preserves its proportional rounded silhouette and upright orientation. Asymmetric bubble corners convey speaker direction without rounded containers around prose.

## Components

### Buttons

Comfortable, destination-specific actions. The Home setup action has clear-orange fill, charcoal text, a 52px minimum height and 24px horizontal padding. Hover lightens the orange without a shadow. Closing actions use charcoal and cream. Text links have 44px minimum targets, hover underlines and inline SVG arrows where useful. Focus is a 3px burnt-orange outline with 5px offset; the hero uses the same burnt-orange focus outline. Real links identify setup preview, GitHub source or contact rather than implying an available download.

### Navigation

A full-width opaque paper bar places the wordmark left and About / How it works right, with a dark setup pill. Its header reserves 88px on desktop and 76px below 760px. Link targets remain at least 44px; current-page links underline; spacing/type tighten at 480px and 360px. The fixed bar hides after downward travel of one bar height, returns after 8px upward travel, stays visible near the top and returns immediately on focus. Reduced motion removes the transition. The former glass capsule is not the current form.

### Cards / Containers

Chapter surfaces hold product demonstrations. Personal examples and setup use rules and whitespace. Policy summaries use three pale cells, a shared border, panel radius and 32px desktop padding, decreasing on small screens, with no shadow. Policy data flow and contact retain explanatory frames. Icons and flow connectors use stroked SVG rather than text glyphs.

### Inputs / Fields

The website has no live account or contact form. First-name fields and chat composers are inert illustrations. The setup field uses illustration paper, a warm 1px border, an 8px radius and 16px by 20px padding. Do not invent validation, error, disabled or focus states for illustrations. Contact uses the existing public email.

### Native disclosures and policy tabs

FAQ and policy details use native `details`/`summary`, meaningful labels and visible focus. Policy summaries are at least 56px tall with an SVG plus rotating when open. Tabs preserve full accessible names when visible text shortens to Privacy / Terms / Credits. Core eligibility and data flow remain visible without expansion.

### Signature product story

The Home hero now uses the accepted fixed heading “A personal AI. For everyday life.” at up to 76px, with a 28px group rhythm. The original plan/day/ideas benefit copy and preview limitations remain visible. The fictional phone shows its complete school-update reply with an accessible transcript; illustrative UI is hidden from assistive technology. The optional paired audience/chat loop is not mounted on this fixed-heading composition, so neither the heading nor the message changes while reading. No live-region announcements, replay/skip controls or live app operations are introduced.

The chapters are Remembers you, Brings you together and Makes room to grow. Memory is an on-demand example using separately configured Gmail and automatic Hermes notes. Shared family calendars and Child mode are future concepts; current calendars remain private and public child access is not open. Calendar stripes encode busy cells in an inert illustration.

**The Complete Without Motion Rule.** Every chapter, preview disclosure and route remains available in ordinary HTML. Animation may stage the explanation but never supply otherwise missing information.

### Editorial imagery and provenance

Two original AI-generated settings shape the site: `home-v1.webp` on Setup, and `picnic-v1.webp` behind future planning, in Home's later photograph and on About. Both have 1536px and 768px WebP variants. Standalone images have descriptive alternatives and visible imagined-scene captions. Home’s opening section has no background photograph. These settings are atmosphere, not evidence of a shipping feature or actual home.

Exact prompts, generator attribution and original filenames are in `docs/assets/editorial/prompts.json`; all four shipping WebPs carry the exact prompt in EXIF ImageDescription. Original PNGs remain private local evidence. Preserve metadata when re-encoding. The home image is an editorial setting on the Setup page only; the Home hero uses dark text and a complete phone on continuous cream. Product UI remains HTML, not text baked into photography.

### Product truth and release boundaries

The public Windows source is a development preview for invited adults aged 18+. Downloads and hosted phone access are being prepared. Setup requires an eligible ChatGPT plan; limits and credit settings apply. Nemo is independent and built around Nous Research's Hermes, which has its own interfaces, memory and skills. Nemo adds guided setup, personal spaces and family controls; the local owner's workspace exposes native Hermes tools and approvals on the home PC. Native memory saves useful notes in each person's private store; relevant notes, conversation context and permitted tool results go to ChatGPT. GBrain extraction/embeddings and local AI models remain deferred.

Calendar/Gmail are optional with separate setup. Child-learning examples do not guarantee prevention of every unsuitable answer or workaround; public child access awaits provider and safety review. The hardware teaser is abstract, with no actual prototype, specification or availability promise. Policies identify Dan Zheng, Australia, and the existing contact address. Do not add a waitlist, form, tracking, Google-verification claim, enabled-zero-retention claim or legal certification.

GitHub Pages publishes only the verified `docs/` artifact through the existing main-branch workflow; this local revision is not a publication. GSAP/ScrollTrigger 3.13.0 are checked in and locally served with their notices, without library-CDN requests. The static site needs no npm installation/build. Preserve font preparation, both custom-script syntax checks and static fallbacks. VERSION/CHANGELOG track the website only. This visual system authorizes no application, installed-software, private-data, hardware or legacy Sites redirect changes.

## Do's and Don'ts

### Do:

- **Do** retain the upright fictional phone, Ranade identity, orange conversation language and visible Windows-preview availability before the first action.
- **Do** preserve the stable accessible heading, complete transcript, skip links, visible focus, 44px functional targets and native disclosures.
- **Do** label generated settings as imagined, examples as fictional, family planning and Child mode as future, and hardware as an abstract future impression.
- **Do** preserve relative `/nemo/` asset paths, source/contact destination labels, shared policy links and original library/font notices.
- **Do** verify keyboard navigation, history, anchors, reverse scrolling, pin release, resize, static content and reduced motion before release; local browser evidence does not establish physical Safari or phone acceptance.

### Don't:

- **Don't** promote obsolete peach-hero, glass-capsule or no-photography descriptions into new surfaces; the final editorial stylesheet defines this build.
- **Don't** turn illustrations into live forms, add ornamental heading kickers, or substitute text glyphs for SVG affordances.
- **Don't** imply public downloads, hosted phone access, public child access, all-local inference, automatic connections, guaranteed setup time or a release date.
- **Don't** imply background email monitoring or scheduled work, or change the current private-calendar boundary through future planning examples.
- **Don't** publish private app data, original generated-image evidence, QA captures, real hardware designs, CAD, component lists, dimensions, prices or specifications.
- **Don't** describe source/capture review as automated, accessibility or physical-device certification, or treat this documentation refresh as deployment approval.
