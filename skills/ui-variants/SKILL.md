---
name: ui-variants
description: Shows UI variants in a live macOS picker window. Use it in this Flutter project when there are several equally good options for a layout, colors or a widget's look, or when the user asks for variants — instead of describing them with diagrams in the terminal.
argument-hint: "[what to show | close | clean]"
---

# UI variants in the picker window

Show variants for: $ARGUMENTS
If nothing follows the colon, show them for the current task. Usually 2–4 variants.

## Writing variants
- Write only in the temporary picker app, never in the project:
  widgets go into separate files in `{{VARIANTS_DIR}}/`, registration goes into the `variants` list in `{{REGISTRY}}`.
- The registry holds only the variants of the current show; remove earlier entries.
- A variant is `class X extends Variant` (import `../_host/variant.dart`): `id` (kebab-case),
  `title` (short, in the conversation's language), `category` (`VariantCategory.layout`, `.color` or `.widget`),
  `feature` (one per show), `build(context)`. A whole screen is `layout` or `isFullScreen => true`; otherwise the window centers the variant.
- One question is one `group` (the category by default). If there are several things to choose
  (layout and color, different elements), split them into groups: the user picks one variant in each
  and sends everything at once. Keep the alternatives for one thing in one group.
- Import project code as `package:{{PACKAGE}}/...`, assets and fonts with the `packages/{{PACKAGE}}/` prefix.
  If an import breaks the build, write the variant with plain Flutter widgets.
- Use realistic mock data, no network and no real services.
- The first time in a project, wire the app's theme into `{{THEME}}`
  (find the theme in the project and import it from `package:{{PACKAGE}}/...`).
- Before ending the turn, check: `flutter analyze {{APP_DIR}}/lib` reports no errors.

## Rules
- Do not create or change anything in the project to show variants. Do not describe variants with diagrams in the terminal.
- After writing the variants, name them briefly in your reply (id and one phrase) and end the turn.
  The window opens or refreshes by itself; the choice arrives as a separate message.
- A "Variant revision from the picker window" message: change only the named variants (keep the id, class and
  registration), do not touch the project, check analyze, reply in one sentence and end the turn.
- After the message with the choice, implement the chosen variant in the project and take the notes into account
  (all of them are in `{{DECISION}}`).
- Do not ask for permission to show variants. Never ask the user to run commands,
  open the window or give paths for this process.
