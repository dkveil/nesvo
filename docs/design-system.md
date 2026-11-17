# Design system

The desktop renderer has one component library in `apps/desktop/src/renderer/src/shared/ui`, a small set of domain glyphs in `entities/status` and `entities/file-change`, and the tokens in `apps/desktop/src/renderer/src/styles.css`. This page is the contract for both.

**Rule:** new UI uses only library components. When a screen needs a look the library does not have, extend the primitive with a variant (and show it in the catalog) instead of writing a local look-alike. Raw `<button>`, hand-written focus rings, arbitrary `text-[Npx]` sizes and one-off hover colours are review findings.

The development build lists **Settings → Development → Components**, a catalog of every component with its variants, sizes and states in the dark and light appearance. Packaged builds exclude it.

## Tokens

All colours are CSS variables defined for light on `:root` and for dark on `:root.dark`; components use the Tailwind names in the first column.

### Colour

| Token                                              | Dark                  | Light                 | Use                                            |
| -------------------------------------------------- | --------------------- | --------------------- | ---------------------------------------------- |
| `background`                                       | `#000000`             | `#fcfcfc`             | Canvas, panel bodies                           |
| `card`                                             | `#111111`             | `#ffffff`             | Cards, dialogs, sheets, settings navigation    |
| `popover`                                          | `#111111`             | `#ffffff`             | Menus, solid popovers                          |
| `accent`                                           | white 4%              | `#f4f4f5`             | **Hover** and highlighted menu items           |
| `highlight`                                        | white 7%              | `#f4f4f5`             | **Selected** rows, tabs and pressed toggles    |
| `sidebar-row-hover` / `sidebar-row-selected`       | `#131313` / `#1c1c1c` | `#f4f4f5` / `#ffffff` | Hover and selected in the sidebar tone         |
| `segment-track` / `segment-active`                 | `#1b1b1b` / `#2d2d2d` | `#f4f4f5` / `#ffffff` | SegmentedControl                               |
| `foreground`                                       | `#f5f5f5`             | `#18181b`             | Primary text                                   |
| `muted-foreground`                                 | `#a1a1a1`             | `#71717b`             | Secondary text, idle icons                     |
| `border` / `input`                                 | white 8% / 11%        | `#e4e4e7` / `#d4d4d8` | Dividers / control borders                     |
| `ring`                                             | `#0f9488`             | `#0f9488`             | Focus ring                                     |
| `primary`                                          | `#0f9488`             | `#0f9488`             | Primary buttons, send button                   |
| `destructive`                                      | `#fb414a`             | `#fb2c36`             | **Destructive actions only** (delete, discard) |
| `success-foreground`                               | `#5ad38c`             | `#1f8a4c`             | Passed, done, additions                        |
| `info-foreground`                                  | `#4fd1c5`             | `#0d7f75`             | Working, informational                         |
| `warning-foreground`                               | `#f2b94b`             | `#b4690e`             | Needs attention, stale                         |
| `error-foreground`                                 | `#f0707a`             | `#c2343d`             | Failures, invalid fields, deletions            |
| `--overlay`                                        | black 60%             | black 24%             | Dialog and sheet backdrop                      |
| `track` (`--usage-ring-track`)                     | white 12%             | black 10%             | Meter and progress track                       |
| `send-idle` / `send-idle-foreground`               | `#292929` / `#929393` | `#e4e4e7` / `#71717b` | Disabled send button                           |
| `--popover-glass`, `--composer-surface`            | 80% glass             | 80% glass             | `glass-popover`, `glass-composer` utilities    |

Status text uses `text-success-foreground`, `text-info-foreground`, `text-warning-foreground` and `text-error-foreground`. `text-destructive` is reserved for destructive actions such as a Delete menu item.

### Type

| Class        | Size / line height | Use                                                  |
| ------------ | ------------------ | ---------------------------------------------------- |
| `text-micro` | 10 / 14 px         | Kbd, counts inside segments, catalog captions        |
| `text-2xs`   | 11 / 16 px         | Meta, section labels, field labels, badges           |
| `text-xs`    | 12 / 16 px         | Descriptions, chips, tabs, notices                   |
| `text-ui`    | 13 / 20 px         | **Default UI body**: rows, menu items, controls      |
| `text-sm`    | 14 / 20 px         | Message composer, `lg` controls                      |
| `text-title` | 15 / 22 px         | Page and section titles, empty-state titles          |
| `text-base`  | 16 / 24 px         | Dialog titles                                        |
| `text-display` | 24 / 30 px       | Headline numbers (cost total), the new-thread heading |
| `text-display-lg` | 30 / 36 px    | The new-thread heading on wide windows (`sm:`)       |

`shared/ui` contains no arbitrary `text-[Npx]` classes. The project `cn` in `shared/lib/cn.ts` knows these scales; always import `cn` from there, never from the `cn` package, or `text-ui` is dropped when a text colour follows it.

### Size

| Name | Height | Button     | IconButton | Input / Select | Chip   |
| ---- | ------ | ---------- | ---------- | -------------- | ------ |
| xs   | 24 px  | `xs`       | `24`       | —              | `sm`   |
| sm   | 28 px  | `sm` (default) | `28` (default) | `sm` (default) | `md` (default) |
| md   | 32 px  | `md`       | `32`       | `md`           | —      |
| lg   | 36 px  | `lg`       | —          | `lg`           | —      |

28 px is the default for app controls. Rows: tree 22 px, compact 28 px, two-line 44 px, grid 32 px. Panel headers are 40 px (`h-10`), toolbars 36 px (`h-9`).

### Radius

| Class              | Value | Use                                          |
| ------------------ | ----- | -------------------------------------------- |
| `rounded-sm`       | 4 px  | Checkbox, Kbd, 16/20 px icon buttons         |
| `rounded-control`  | 6 px  | Controls, menu items, rows, chips            |
| `rounded-surface`  | 8 px  | Popovers, menus, cards, specimens            |
| `rounded-overlay`  | 12 px | Dialogs, the compact composer                |
| `rounded-composer` | 16 px | The message composer                         |
| `rounded-full`     |       | Round icon buttons, send, pills, badges      |

### Motion

| Token / class    | Value | Use                                             |
| ---------------- | ----- | ----------------------------------------------- |
| `duration-fast`  | 100ms | Colour and background changes                   |
| `duration-base`  | 150ms | Transform and opacity, popovers, tooltips       |
| `duration-slow`  | 200ms | Panels, dialogs, sheets, meter fills            |
| `ease-out`       |       | Every transition                                |
| `press`          |       | `scale: 0.97` while pressed, buttons and chips only |

`prefers-reduced-motion: reduce` disables transitions and animations globally.

## Interaction rules

**Focus.** Every interactive primitive uses one utility: `focus-ring`, a 1.5 px outline inset by 1.5 px in `--ring`, shown on `:focus-visible` only. Containers that hold a native input use `focus-ring-within`. Small controls whose inset ring would hide the glyph (Switch, Checkbox) use `focus-ring-offset` (2 px outside). Filled primary and destructive buttons set `--focus-ring-color` to their foreground so the ring stays visible. No `ring-offset`, no `ring-[3px]`, no `focus:` without `-visible`.

**Hover.** `bg-accent` plus `text-foreground` for muted items; the sidebar tone uses `bg-sidebar-row-hover`. Hover applies only to enabled elements: `enabled:hover:` on buttons, `not-disabled:hover:` when the element can be a link, `not-data-disabled:hover:` on rows.

**Selected.** Styling keys off one attribute, `data-selected`, set by the `selected` (or `pressed`) prop. The ARIA attribute follows the role: `aria-current="page"` for navigation (NavItem), `aria-current="true"` for list rows, `aria-selected` for tabs and listbox options, `aria-pressed` for toggle buttons (IconButton `pressed`, SegmentedControl in toggle mode), `aria-checked` for radios. Selected uses `bg-highlight` (sidebar tone: `bg-sidebar-row-selected` with its shadow).

**Expanded.** Triggers that open a menu or popover show `bg-accent` through `aria-expanded` or `data-state=open`. IconButton applies it only with `aria-haspopup` (set by menu, popover and dialog triggers), so disclosure toggles that carry `aria-expanded` keep their idle look.

**Disabled.** `opacity-50` and `cursor-not-allowed`; no hover. Disabled send buttons use the `send-idle` colours at full opacity instead.

**Tooltips.** One `TooltipProvider` is mounted in `app.tsx`. A tooltip opens on pointer hover, or on focus only when the focus came from keyboard navigation (Tab, arrows, Home, End, F6). Focus restored by closing a dialog does not open one. Prefer IconButton's built-in tooltip or `Hint` over `title=`.

**Overlays.** Dialog and Sheet share the `--overlay` backdrop with a 2 px blur.

**State preview.** `data-preview-hover`, `data-preview-focus` and `data-preview-active` force the hover, focus and pressed looks. They exist for the catalog; do not use them in product UI.

## Components

Paths are relative to `apps/desktop/src/renderer/src`.

### Primitives

**Button** — `shared/ui/button.tsx`. Labelled commands. Variants `default` (primary), `secondary`, `outline`, `ghost`, `destructive`, `link`; sizes `xs` `sm` `md` `lg`, `inline` (no height or padding, inherits the text size) for a `link` inside a sentence or a title, icon sizes `icon-xs` (24) `icon-sm` (28) `icon-md` (32). `selected` marks a ghost button as current. Not for glyph-only buttons (use IconButton) or list rows (use ListRow/NavItem). Do put the icon first as a child; don't override height with `h-*`, pick the size.
Deprecated aliases kept so existing callers compile: `default` = `lg` (36 px), `icon` = 36 px, `icon-lg` = 40 px. Before this change `sm` meant 32 px and the implicit default 36 px; existing callers were moved to `md` and `lg` so they render as before.

**IconButton** — `shared/ui/icon-button.tsx`. Glyph-only commands. `label` is required and becomes the accessible name and the tooltip (`tooltip={false}` when a parent already shows one; `shortcut` adds a key hint). Sizes `16 20 24 28 32` (default 28), `tone` `default | sidebar | danger`, `shape` `square | round`, `appearance="send"` for the round primary send button with idle disabled colours, `pressed` for toggles. `current` marks a navigation destination (`aria-current="page"`, selected look); `marker` adds the navigation rail's 2 px bar beside the button while it is current. Not for text buttons.

**Chip** — `shared/ui/chip.tsx`. Compact triggers in composers, filters and toolbars (`ComposerChip` re-exports it). Sizes `sm` (24) and `md` (28, default), optional `icon`, `selected`, `interactive={false}` for a static span. Wrap the label in a `<span>` so it truncates at 224 px.

**Input / Textarea** — `shared/ui/input.tsx`, `shared/ui/textarea.tsx`. Sizes `sm` `md` `lg`, `variant="ghost"` for inline titles and composer fields (no border, no ring; the container shows focus). Invalid uses `aria-invalid`, which draws an error border.

**SearchField** — `shared/ui/search-field.tsx`. Variants `panel` (panel headers and toolbars), `sidebar`, `underline` (top of a picker or popover), `palette` (command palette, history search). `onClear` adds a clear button while there is a value; `shortcut` shows a key hint while empty. `icon` replaces the search glyph for lookup fields (a repository, a link) and `trailing` holds an inline action such as an xs ghost Open button. `PanelSearch` is the panel variant.

**Select** — `shared/ui/select.tsx`. Native-like single choice from a short fixed list. Trigger sizes `sm` `md` `lg` (`default` = `lg`), `variant="ghost"` for toolbar pickers. Items use the shared menu item spec. For searchable or rich options use Combobox.

**Switch** and **Checkbox** — `shared/ui/switch.tsx`, `shared/ui/checkbox.tsx`. Switch for settings that apply immediately; Checkbox for selections inside forms and lists (viewed files, task lists), including `indeterminate`. Pair both with `Label`.

**SegmentedControl** — `shared/ui/segmented-control.tsx`. Two to five mutually related options shown at once. Sizes `sm` (24) and `md` (28), `fullWidth`, `iconOnly`, per-option `icon`, `count`, `disabled`, `title` and `ariaLabel` (an accessible name when the visible label is only a number or glyph). `mode` is `single` (radio group, arrow keys), `toggle` (pressed buttons) or `multiple` (array value). `orientation="vertical"` stacks the options in a column, for example a provider rail beside a list. `invalid` draws an error outline. A single value may be `null` while it is unknown; the first enabled option then takes the tab stop. Not for navigation between views with their own panels (use Tabs).

**Tabs** — `shared/ui/tabs.tsx`. `variant="underline"` with a sliding indicator for panel sections; `variant="editor"` for open documents with `closable` tabs (`onClose`, middle click, Delete). Render content in `TabPanel` with the same `idPrefix` so ARIA wiring matches.

**NavList / NavItem** — `shared/ui/nav-list.tsx`. Vertical navigation (settings sections, sidebar destinations). `selected` sets `aria-current="page"`; `trailing` holds a CountBadge; tones `default` and `sidebar`; sizes `sm` (28) and `md` (32).

**Tooltip / Hint** — `shared/ui/tooltip.tsx`. `TooltipContent` variants `label` (single line, optional `shortcut`) and `panel` (short explanation). `Hint` wraps any trigger in one line. Do not use for essential information.

**Popover** — `shared/ui/popover.tsx`. `surface` `glass` (default) | `solid` | `card`; `size` `default` (288 px) | `sm` (240) | `md` (320) | `lg` (416) | `trigger`; `padding` `md` | `sm` | `none`; `scroll` caps the height at 28 rem within the available space. Use presets instead of `w-[min(...)]` formulas.

**DropdownMenu** — `shared/ui/dropdown-menu.tsx`. Action menus. Item, CheckboxItem, RadioGroup/RadioItem, Label, Separator, Shortcut, Sub/SubTrigger/SubContent, Group. `variant="destructive"` on an item that deletes. Every item is 28 px, `text-ui`, `rounded-control`, `bg-accent` when highlighted; the classes live in `shared/ui/menu-styles.ts` and Select and Listbox reuse them.

**Listbox / Combobox** — `shared/ui/listbox.tsx`. Pickers with search, groups, descriptions, disabled options and full keyboard handling (arrows, Home, End, Enter; the search field keeps focus and drives `aria-activedescendant`). Options take an `ariaLabel` when the visible label is not the accessible name, and `description` accepts rich content such as a highlighted snippet (only string descriptions are searched). `onActiveChange` reports the highlighted option (for a preview beside the list). An input outside the list can drive it: pass `id` and `active`, and point `aria-activedescendant` at `listboxOptionId(id, value)` from `shared/ui/listbox-option-id.ts` (the skill picker keeps focus in the message field this way). Combobox puts a Listbox in a solid popover behind any trigger, usually a Chip. Replaces hand-written option lists in model, folder, branch and workflow pickers. `query` and `onQueryChange` control the search text when the caller needs it, for example to offer a "create" option for an unmatched name. `searchLabel` names the search field when the default `Search <label>` reads badly; an option's `attributes` carries `data-*` hooks for tests and drivers. A Listbox can also sit in a Popover anchored to a point (the graph editor's node picker).

**Dialog / Sheet** — `shared/ui/dialog.tsx`, `shared/ui/sheet.tsx`. Dialog titles are `text-base` semibold and descriptions `text-xs` muted by default; don't override them. Sheet content is `bg-card` with no padding; SheetHeader has the bordered `px-5 py-4` layout and SheetFooter a bordered action row. Both close with a 28 px IconButton.

**Badge / CountBadge** — `shared/ui/badge.tsx`. Short status labels. `tone` `neutral | info | success | warning | error | accent`, `appearance` `soft | outline`, `size` `xs | sm`. CountBadge shows a number (`max` collapses to `99+`), `strong` or `muted`. Not for interactive filters (use Chip).

**StatusDot** — `shared/ui/status-dot.tsx`. A 6 or 8 px dot with the same tones plus `strong`, `pulse`, and `ringClassName` to cut it out of a surface. Give it a `label` when the dot is the only signal.

**Kbd / KeyCombo** — `shared/ui/kbd.tsx`. Key hints; `KeyCombo keys="Ctrl K"` splits on spaces. Tone `tooltip` inside tooltips.

**Meter / Progress** — `shared/ui/progress.tsx`. 4 px bars. Meter (`role="meter"`) for remaining allowances and budgets: `tone`, `stale` fades the fill, `value={null}` draws the dashed unavailable track. Progress (`role="progressbar"`) for work in flight, with `indeterminate`.

**Spinner** — `shared/ui/spinner.tsx`. Inline loading glyph; `label` when it stands alone.

**Separator** — `shared/ui/separator.tsx`. Horizontal or vertical 1 px rule. `label` centres `text-2xs` muted text between two rules (history dividers such as "Mode changed to …").

### Composites

**ListRow** — `shared/ui/list-row.tsx`. Every list row. Densities `tree` (22), `compact` (28), `two-line` (title plus description), `grid` (cells laid out by `columns`), `block` (multi-line cells laid out by `columns` with auto height, for inbox items whose decisions sit beside a wrapped summary). Slots `leading`, `title`, `meta` (two-line: time or status at the end of the title line), `description`, `trailing`, `actions` (revealed on hover, focus within and selection). `selected`, `disabled`, `level` (12 px per tree level), `dropIndicator` `before | after | inside`, `tone` `default | sidebar`. `size="sm"` is the compact sidebar scale: 12 px titles, 40 px two-line rows with the leading glyph on the title line. `heading` gives group and section rows a muted medium title that brightens on hover. `actionsPlacement="overlay"` floats the actions over the trailing edge instead of reserving their width; while they show, `meta` and `trailing` hide, and the sidebar tone paints the row colour behind them. Passing `onClick` makes the main area a button; `mainProps` reaches it for ARIA and drag handlers. Actions sit beside the button, never inside it. A row can be a Radix trigger (`<PopoverTrigger asChild><ListRow …/></PopoverTrigger>`): `aria-expanded`, `aria-haspopup` and `aria-controls` move to the main button and `data-state=open` shows the expanded `bg-accent`.

**Panel / PanelHeader / PanelBody / Toolbar** — `shared/ui/panel.tsx`. Docked panels: PanelHeader is 40 px with an icon, title, meta and PanelAction buttons (28 px, 14 px glyphs; `label` sets the accessible name and a tooltip, like IconButton); `titleBar` aligns it with the window caption. `leading` takes a coloured domain glyph instead of `icon`, and `title` may be rich text (a muted prefix); without `meta` a long title truncates. Toolbar is a 36 px `role="toolbar"` row with ToolbarSeparator and ToolbarSpacer.

**EmptyState** — `shared/ui/empty-state.tsx`. Icon tile, `text-title` title, description and actions; `size` `md` for whole views, `sm` inside lists and popovers.

**StatusMessage / InlineNotice** — `shared/ui/status-message.tsx`, `shared/ui/inline-notice.tsx`. Replaces ad-hoc `role="status"` and `role="alert"` paragraphs. Tones `info | loading | success | warning | error`; error uses `role="alert"`, the others `role="status"`. `variant="inline"` is 11 px toned text; `variant="notice"` (InlineNotice) is a 12 px muted block with a toned icon and an accent background for anything but info.

**Composer** — `shared/ui/composer.tsx`. The only glass writing shell. `Composer` (`variant` `default` for messages, `compact` for review comments), `ComposerInput` (auto-sizing textarea), `ComposerToolbar` (`start` chips and hints, `end` actions) and `ComposerSend` (round send IconButton with `pending`). The caller owns the form and keyboard shortcuts.

**SectionLabel** — `shared/ui/section-label.tsx`. 24 px group heading with optional `count` and `action`.

**Field / FieldMessages** — `shared/ui/field.tsx`. Label, control, hint and error or warning messages (`${id}-messages` for `aria-describedby`); `layout` `stacked` or `inline`. A Select inside a form renders Radix's hidden native `<select>` after its trigger; Field drops the trigger's trailing spacing in that case, so put the Select directly in the Field without a wrapper `<div>`.

**KeyValueList** — `shared/ui/key-value-list.tsx`. Two-column `dl` for details and metadata.

**CodeBlock** — `shared/ui/code-block.tsx`. Monospace block with an optional file `label`, copy button and `wrap`.

**Disclosure / NativeDisclosure** — `shared/ui/disclosure.tsx`. A 28 px row with a rotating chevron, optional `icon`, `meta`, muted `description` lines under the title (a string clamps to two lines; a node renders its own lines) and collapsible content; controlled or uncontrolled. `triggerLabel` names the trigger when the visible title is not enough. NativeDisclosure renders the same row with `<details>` and `<summary>`: use it when the content must stay in the document while collapsed (find in page, deep links that open a section) or when callers rely on the `open` attribute, such as activity rows and saved result versions.

**SettingsSection / SettingsRow** — `shared/ui/settings-section.tsx`. Settings pages. SettingsSection heads a bordered card with a SectionLabel (`action` sits on its right); the page title lives in the settings header. SettingsRow is a title, a `text-xs` description and trailing controls; put status lines in the description as StatusMessage.

### Domain glyphs

**StatusIcon** and the tone map — `entities/status`. `status` `success | error | warning | info | pending | running | idle`; `statusTones` maps each to a `Tone`, `toneText` maps a tone to its text class. Session statuses use `statusTones` from `entities/session`; workflow tones re-export the same map. ChecksIcon is built on StatusIcon.

**DiffStat, StatusLetter, FileGlyph** — `entities/file-change`. `+N −N` counts, the A/M/D/R letter for a changed file and the coloured file-type glyph. `widgets/workspace-files/file-glyph.tsx` re-exports FileGlyph.

**ProjectChip** — `shared/ui/project-chip.tsx`. Hash-coloured project swatch; it carries no domain type, so it stays in shared.

## Migrating existing code

Later iterations move feature widgets onto the library area by area. Use these replacements:

| Hand-rolled pattern                                                           | Library                                                            |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `<Button variant="ghost" size="icon-sm" className="size-7 text-muted-foreground …">` | `<IconButton label="…">` (28)                                |
| `<Button size="icon-xs">` with a glyph                                        | `<IconButton size={24} label="…">`                                 |
| `cardIconButton` or a raw `<button className="size-6 …">`                     | `<IconButton size={24} label="…">`                                 |
| Round send `Button` with `disabled:bg-send-idle …`                            | `<ComposerSend />` or `<IconButton appearance="send" shape="round">` |
| `size="sm" className="h-7"` on Button                                         | `size="sm"` (now 28 px)                                            |
| Raw `<button>` toggles with `aria-pressed:bg-highlight`                       | `<IconButton pressed>` or `<SegmentedControl mode="toggle">`       |
| `widgets/workflow-graph-editor/inspector/fields.tsx` `Segmented`              | `<SegmentedControl fullWidth mode="single" | "toggle">`            |
| `PanelTabs` and other `role="tablist"` rows                                   | `<Tabs variant="underline">` + `<TabPanel>`                        |
| Settings nav buttons, sidebar nav buttons                                     | `<NavList>` + `<NavItem tone="default" | "sidebar">`               |
| `panelRow`, `cardRow`, `cardRowAction`, tree rows, session rows               | `<ListRow density="compact" | "tree" | "two-line">`                |
| `<p role="status" className="text-[11px] …">`                                 | `<StatusMessage tone="info" | "loading">`                          |
| `<p role="alert" className="text-destructive …">`                             | `<StatusMessage tone="error">`                                     |
| Icon tile + title + description empty views                                   | `<EmptyState>`                                                     |
| `UsageBar`, cost bars, `h-1 rounded-full` fills                               | `<Meter>` or `<Progress>`                                          |
| `+{additions} −{deletions}` spans                                             | `<DiffStat>`                                                       |
| `size-1.5 rounded-full bg-…` dots                                             | `<StatusDot tone="…">`                                             |
| `<details>` with a styled `<summary>`                                         | `<Disclosure>` or `<NativeDisclosure>`                             |
| `<kbd className="…">`                                                          | `<Kbd>` / `<KeyCombo>`                                             |
| Native `<input type="checkbox">`                                              | `<Checkbox>`                                                       |
| Custom option-list popovers (model, folder, branch, workflow, MCP pickers)    | `<Combobox trigger={<Chip …/>}>` or `<Listbox>`                    |
| `PopoverContent className="w-[min(20rem,calc(100vw-1rem))] max-h-…"`          | `<PopoverContent size="md" scroll>`                                |
| `DialogTitle className="text-base"`, `DialogDescription className="text-xs"`  | Drop the override                                                  |
| `SheetHeader className="border-b px-5 py-4"`, `SheetTitle className="text-sm"` | Drop the override                                                 |
| Glass composer shells with their own textarea and send button                 | `<Composer>` + `<ComposerInput>` + `<ComposerToolbar>` + `<ComposerSend>` |
| Inspector `Field` / `FieldNotes`                                              | `<Field messages={…}>` / `<FieldMessages>`                         |
| `<Field><div><Select …/></div></Field>`                                       | `<Field><Select …/></Field>`                                       |
| `text-[13px]` / `text-[11px]` / `text-[10px]` / `text-[15px]`                 | `text-ui` / `text-2xs` / `text-micro` / `text-title`               |
| `text-2xl` / `text-3xl` headings, large totals in `text-base`                 | `text-display` / `text-display-lg`                                 |
| `focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset` and variants | `focus-ring`                                                |
| `text-destructive` for error text                                             | `text-error-foreground`                                            |
| `disabled:opacity-60` / `disabled:opacity-64`                                 | `disabled:opacity-50`                                              |
| `duration-75` … `duration-300`, transitions without a duration                | `duration-fast` / `duration-base` / `duration-slow`                |
| A widget-level `<TooltipProvider>`                                            | Remove it; the app shell provides one                              |
| `title="…"` on icon-only buttons                                              | IconButton `label` (tooltip included)                              |
