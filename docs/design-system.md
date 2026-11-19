# Design system

The desktop renderer has one component library in `apps/desktop/src/renderer/src/shared/ui`, a small set of domain glyphs in `entities/status` and `entities/file-change`, and the tokens in `apps/desktop/src/renderer/src/styles.css`. This page is the contract for both.

**Rule:** new UI uses only library components. When a screen needs a look the library does not have, extend the primitive with a variant (and show it in the catalog) instead of writing a local look-alike. Raw `<button>`, hand-written focus rings, arbitrary `text-[Npx]` sizes and one-off hover colours are review findings.

The development build lists **Settings → Development → Components**, a catalog of every component with its variants, sizes and states in the dark and light appearance. Packaged builds exclude it.

## Review before presenting UI

- [ ] Use one type scale for page titles, section labels, row titles, row descriptions and helper text. Avoid ad-hoc sizes and keep labels no larger than their controls.
- [ ] Keep headings and hero text modest. Prefer smaller steps on the type scale.
- [ ] Use `shared/ui` components and design tokens for controls and styling.
- [ ] Align row controls and icons to the centre line. Align text baselines across columns and use the same height and vertical spacing for equivalent rows.
- [ ] Lay out flat rows on the canvas with subtle dividers. Keep Settings groups, session groups, details docks and conversation sections free of decorative fills and outer borders. Use the darkest neutral surface token for necessary fills (`info-panel` in dark mode) and `code-background` for code and terminal output.
- [ ] Use the default dialog and solid popover surfaces in sessions, Settings, onboarding, Costs and account limits.
- [ ] Keep section spacing consistent and layout anchors stable when moving between steps or pages. Align the message, activity and composer column edges.
- [ ] Use one button variant per role and the same label for the same action.
- [ ] Use pickers for known choices and keep prompt fields non-resizable.
- [ ] Size and align icons consistently.
- [ ] Describe only features that exist. Explain how to enable disabled controls.
- [ ] Review screenshots at 1280 × 800 and 1920 × 1080 against this checklist before presenting the change.

## Tokens

All colours are CSS variables defined for light on `:root` and for dark on `:root.dark`; components use the Tailwind names in the first column.

### Colour

| Token                                              | Dark                  | Light                 | Use                                            |
| -------------------------------------------------- | --------------------- | --------------------- | ---------------------------------------------- |
| `background`                                       | `#000000`             | `#fcfcfc`             | Canvas, panel bodies                           |
| `card`                                             | `#111111`             | `#ffffff`             | Cards, dialogs and sheets                      |
| `popover`                                          | `#111111`             | `#ffffff`             | Menus, solid popovers                          |
| `info-panel` / `-border` / `-divider`              | `#0a0a0a` / white 12% / white 8% | `#ffffff` / `#d4d4d8` / `#e4e4e7` | Dedicated panels and focused forms |
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
| `skeleton`                                         | white 7%              | black 6%              | Skeleton placeholders                          |
| `send-idle` / `send-idle-foreground`               | `#292929` / `#929393` | `#e4e4e7` / `#71717b` | Disabled send button                           |
| `--popover-glass`, `--composer-surface`            | 80% glass             | 80% glass             | `glass-popover`, `glass-composer` utilities    |

`subtle-foreground` is the secondary token for field hints and Settings row descriptions (`#909090` in dark, `#74747d` in light).

Status text uses `text-success-foreground`, `text-info-foreground`, `text-warning-foreground` and `text-error-foreground`. `text-destructive` is reserved for destructive actions such as a Delete menu item.

### Type

| Class        | Size / line height | Use                                                  |
| ------------ | ------------------ | ---------------------------------------------------- |
| `text-micro` | 10 / 14 px         | Kbd, counts inside segments, catalog captions        |
| `text-2xs`   | 11 / 16 px         | Meta, section labels, field labels, badges           |
| `text-xs`    | 12 / 16 px         | Descriptions, chips, tabs, notices                   |
| `text-ui`    | 13 / 20 px         | **Default UI body**: rows, menu items, controls, messages and composer (messages use `leading-relaxed`) |
| `text-sm`    | 14 / 20 px         | `lg` controls                                        |
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
| xl   | 40 px  | —          | `40`       | —              | —      |

28 px is the default for app controls. Rows: tree 22 px, compact 28 px, two-line 44 px, grid 32 px. Panel headers are 40 px (`h-10`), toolbars 36 px (`h-9`).

### Radius

| Class              | Value | Use                                          |
| ------------------ | ----- | -------------------------------------------- |
| `rounded-sm`       | 4 px  | Checkbox, Kbd, 16/20 px icon buttons         |
| `rounded-control`  | 6 px  | Controls, menu items, rows, chips            |
| `rounded-surface`  | 8 px  | Popovers, menus, cards, specimens            |
| `rounded-overlay`  | 12 px | Dialogs, the compact composer                |
| `rounded-composer` | 16 px | The message composer, message bubbles        |
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

The sidebar collapses and expands over `duration-slow` with `ease-out` by transitioning one registered length, `--sidebar-extent`, on the shell: the panel width, the conversation column and the header's reserved wordmark space all follow it, while the sidebar contents keep their full width and are clipped, so text never rewraps. Resizing by drag, keyboard or window size stays instant. The rail's New session button grows in its place with the same timing. The wordmark is drawn once by the shell at `--shell-brand-start` from the rail and never moves; `--shell-brand-end` is the space the header keeps free for it (`--brand-wordmark-width` follows the 12 px wordmark).

## Interaction rules

**Focus.** Every interactive primitive uses one utility: `focus-ring`, a 1.5 px outline inset by 1.5 px in `--ring`, shown on `:focus-visible` only. Containers that hold a native input use `focus-ring-within`. Small controls whose inset ring would hide the glyph (Switch, Checkbox) use `focus-ring-offset` (2 px outside). Filled primary and destructive buttons set `--focus-ring-color` to their foreground so the ring stays visible. No `ring-offset`, no `ring-[3px]`, no `focus:` without `-visible`.

**Hover.** `bg-accent` plus `text-foreground` for muted items; the sidebar tone uses `bg-sidebar-row-hover`. Hover applies only to enabled elements: `enabled:hover:` on buttons, `not-disabled:hover:` when the element can be a link, `not-data-disabled:hover:` on rows.

**Selected.** Styling keys off one attribute, `data-selected`, set by the `selected` (or `pressed`) prop. The ARIA attribute follows the role: `aria-current="page"` for navigation (NavItem), `aria-current="true"` for list rows, `aria-selected` for tabs and listbox options, `aria-pressed` for toggle buttons (IconButton `pressed`, SegmentedControl in toggle mode), `aria-checked` for radios. Selected uses `bg-highlight` (sidebar tone: `bg-sidebar-row-selected` with its shadow).

**Expanded.** Triggers that open a menu or popover show `bg-accent` through `aria-expanded` or `data-state=open`. IconButton applies it only with `aria-haspopup` (set by menu, popover and dialog triggers), so disclosure toggles that carry `aria-expanded` keep their idle look.

**Disabled.** `opacity-50` and `cursor-not-allowed`; no hover. Disabled send buttons use the `send-idle` colours at full opacity instead.

**Tooltips.** One `TooltipProvider` is mounted in `app.tsx`. A tooltip opens on pointer hover, or on focus only when the focus came from keyboard navigation (Tab, arrows, Home, End, F6). Focus restored by closing a dialog does not open one. Prefer IconButton's built-in tooltip, `Hint` or `DisabledHint` over `title=`; a native `title` stays only where it reveals the full text of a truncated label, a link target or a file status letter.

**Overlays.** Dialog and Sheet share the `--overlay` backdrop with a 2 px blur.

**Live regions.** The conversation transcript is a `role="log"` (`aria-live="polite"`, `aria-relevant="additions"`); the streaming message carries `aria-busy` so tokens are not read one by one. A visually hidden `role="status"` announces approval requests and the finished reply (an excerpt), remounted per session so opening a session announces nothing. Errors use StatusMessage `error` (`role="alert"`).

**Long lists.** `content-visibility-auto` skips layout and paint of off-screen items and remembers their size (`contain-intrinsic-block-size: auto 8rem`). Transcript messages use it except the last eight and the one streaming, which stay fully rendered. It applies paint containment, so do not use it on items whose content must overflow them.

**State preview.** `data-preview-hover`, `data-preview-focus` and `data-preview-active` force the hover, focus and pressed looks. They exist for the catalog; do not use them in product UI.

## Components

Paths are relative to `apps/desktop/src/renderer/src`.

### Primitives

**Button** — `shared/ui/button.tsx`. Labelled commands. Variants `default` (primary), `secondary`, `outline`, `ghost`, `destructive`, `link`; sizes `xs` `sm` `md` `lg`, `inline` (no height or padding, inherits the text size) for a `link` inside a sentence or a title, icon sizes `icon-xs` (24) `icon-sm` (28) `icon-md` (32). `selected` marks a ghost button as current. Not for glyph-only buttons (use IconButton) or list rows (use ListRow/NavItem). Do put the icon first as a child; don't override height with `h-*`, pick the size.
Deprecated aliases kept so existing callers compile: `default` = `lg` (36 px), `icon` = 36 px, `icon-lg` = 40 px. Before this change `sm` meant 32 px and the implicit default 36 px; existing callers were moved to `md` and `lg` so they render as before.

**IconButton** — `shared/ui/icon-button.tsx`. Glyph-only commands. `label` is required and becomes the accessible name and the tooltip (`tooltip={false}` when a parent already shows one; `shortcut` adds a key hint). Sizes `16 20 24 28 32 40` (default 28; 40 is for floating launchers such as the workflow assistant, usually `shape="round"` with `glass-popover border`), `tone` `default | sidebar | danger`, `shape` `square | round`, `appearance="send"` for the round primary send button with idle disabled colours, `pressed` for toggles. `current` marks a navigation destination (`aria-current="page"`, selected look); `marker` adds the navigation rail's 2 px bar beside the button while it is current. Not for text buttons.

**Chip** — `shared/ui/chip.tsx`. Compact triggers in composers, filters and toolbars (`ComposerChip` re-exports it). Sizes `sm` (24) and `md` (28, default), optional `icon`, `selected`, `interactive={false}` for a static span. Wrap the label in a `<span>` so it truncates at 224 px.

**AttachmentChip** — `shared/ui/attachment-chip.tsx`. An attachment tile in the composer strip (`size="sm"`, 48 px) and in history (`md`, 80 px). `kind` `image` (default) shows the thumbnail from `src`, or a placeholder glyph without one; `file` shows a FileTypeIcon and the extension. `name` and `detail` (size, error) form the accessible name and the tooltip. `status` `ready | uploading | failed`: uploading dims the content under a Spinner, failed draws an error border. `onOpen` makes the tile a button that opens the image (the composer and history open a Dialog lightbox); `menu` (DropdownMenu items) makes it a menu trigger named `File actions for <name> · <detail>` instead; `onRemove` adds a 16 px round remove IconButton on the corner. Not for file names in a toolbar (use Chip).

**AttachmentToken** — `shared/ui/attachment-token.tsx`. An attachment reference inside text: a 14 px thumbnail (`kind="image"`, or an image glyph without `src`), a FileTypeIcon (`kind="file"`) or a Spinner while uploading, then the file name and a muted `detail` such as the size, on a `bg-muted` 20 px pill that sits on the text line. Without `onOpen` or `menu` it is a static `role="img"` named `Image <name>, <detail>` or `File <name>, <detail>` (the composer); with `onOpen` it is a button named `Open <name>, <detail>` that opens the image, and with `menu` a DropdownMenu trigger named `File actions for <name>, <detail>` (history: Open, Show in folder). `status` `failed` colours the name as an error. Not a replacement for the strip (AttachmentChip). `icon` replaces the image glyph and `label` the `Image`/`File` prefix of the accessible name, so a code comment token (`label="Code comment"`, a file glyph, `file:lines` in mono) uses the same pill.

**FileTypeIcon** — `shared/ui/file-type-icon.tsx`. A muted file glyph chosen from the file name's extension (image, document, spreadsheet, data, archive, audio, video, program, code, other; the mapping lives in `shared/lib/file-category.ts`). Size it with `className`. Used by AttachmentChip and AttachmentToken; use it wherever a file name needs a type hint.

**Input / Textarea** — `shared/ui/input.tsx`, `shared/ui/textarea.tsx`. Sizes `sm` `md` `lg`, `variant="ghost"` for inline titles and composer fields (no border, no ring; the container shows focus). Invalid uses `aria-invalid`, which draws an error border.

**SearchField** — `shared/ui/search-field.tsx`. Variants `panel` (panel headers and toolbars), `sidebar`, `underline` (top of a picker or popover), `palette` (command palette, history search). `onClear` adds a clear button while there is a value; `shortcut` shows a key hint while empty. `icon` replaces the search glyph for lookup fields (a repository, a link) and `trailing` holds an inline action such as an xs ghost Open button. `PanelSearch` is the panel variant.

**Select** — `shared/ui/select.tsx`. Native-like single choice from a short fixed list. Trigger sizes `sm` `md` `lg` (`default` = `lg`), `variant="ghost"` for toolbar pickers. Items use the shared menu item spec. For searchable or rich options use Combobox.

**Switch** and **Checkbox** — `shared/ui/switch.tsx`, `shared/ui/checkbox.tsx`. Switch for settings that apply immediately; Checkbox for selections inside forms and lists (viewed files, task lists), including `indeterminate`. Pair both with `Label`.

**SegmentedControl** — `shared/ui/segmented-control.tsx`. Two to five mutually related options shown at once. Sizes `sm` (24) and `md` (28), `fullWidth`, `iconOnly`, per-option `icon`, `count`, `disabled`, `title` (a native hint that also shows on disabled options), `tooltip` (the library tooltip, for enabled icon or count segments) and `ariaLabel` (an accessible name when the visible label is only a number or glyph). An empty `label` renders only the icon, for example a status filter whose count is zero. `mode` is `single` (radio group, arrow keys), `toggle` (pressed buttons) or `multiple` (array value). `orientation="vertical"` stacks the options in a column, for example a provider rail beside a list. `invalid` draws an error outline. A single value may be `null` while it is unknown; the first enabled option then takes the tab stop. Not for navigation between views with their own panels (use Tabs).

**Tabs** — `shared/ui/tabs.tsx`. `variant="underline"` with a sliding indicator for panel sections; `variant="editor"` for open documents with `closable` tabs (`onClose`, middle click, Delete). Render content in `TabPanel` with the same `idPrefix` so ARIA wiring matches.

**NavList / NavItem** — `shared/ui/nav-list.tsx`. Vertical navigation (settings sections, sidebar destinations). `selected` sets `aria-current="page"`; `trailing` holds a CountBadge; tones `default`, `sidebar` and `flat`; sizes `sm` (28) and `md` (32).

**Tooltip / Hint** — `shared/ui/tooltip.tsx`. `TooltipContent` variants `label` (single line, optional `shortcut`) and `panel` (short explanation). `Hint` wraps any trigger in one line. Do not use for essential information.

**DisabledHint** — `shared/ui/disabled-hint.tsx`. Explains why a control is disabled. With a `reason` it wraps the disabled control in a focusable span that shows the reason in a panel tooltip, because a disabled button receives no pointer or focus events; with an empty `reason` it shows the optional `hint` as a Hint, or nothing. Give a disabled IconButton `tooltip={false}` while a reason shows.

**Popover** — `shared/ui/popover.tsx`. `surface` `glass` (default) | `solid` | `card` | `panel` (the darker `info-panel` surface for information panels such as session details, which use `infoPanelSurface` with `divide-info-panel-divider` between sections); `size` `default` (288 px) | `sm` (240) | `md` (320) | `lg` (416) | `trigger`; `padding` `md` | `sm` | `none`; `scroll` caps the height at 28 rem within the available space. Use presets instead of `w-[min(...)]` formulas. Use `solid` for the account and provider limits popovers.

**DropdownMenu** — `shared/ui/dropdown-menu.tsx`. Action menus. Item, CheckboxItem, RadioGroup/RadioItem, Label, Separator, Shortcut, Sub/SubTrigger/SubContent, Group. `variant="destructive"` on an item that deletes. Every item is 28 px, `text-ui`, `rounded-control`, `bg-accent` when highlighted; the classes live in `shared/ui/menu-styles.ts` and Select and Listbox reuse them.

**Listbox / Combobox** — `shared/ui/listbox.tsx`. Pickers with search, groups, descriptions, disabled options and full keyboard handling (arrows, Home, End, Enter; the search field keeps focus and drives `aria-activedescendant`). Options take an `ariaLabel` when the visible label is not the accessible name, and `description` accepts rich content such as a highlighted snippet (only string descriptions are searched). `onActiveChange` reports the highlighted option (for a preview beside the list). An input outside the list can drive it: pass `id` and `active`, and point `aria-activedescendant` at `listboxOptionId(id, value)` from `shared/ui/listbox-option-id.ts` (the skill picker keeps focus in the message field this way). Combobox puts a Listbox in a solid popover behind any trigger, usually a Chip. Replaces hand-written option lists in model, folder, branch and workflow pickers. `query` and `onQueryChange` control the search text when the caller needs it, for example to offer a "create" option for an unmatched name. `searchLabel` names the search field when the default `Search <label>` reads badly; an option's `attributes` carries `data-*` hooks for tests and drivers. A Listbox can also sit in a Popover anchored to a point (the graph editor's node picker).

**Dialog / left navigation sheet** — `shared/ui/dialog.tsx`, `shared/ui/sheet.tsx`. Creation of a new top-level object, such as a workflow or automation, uses the compact, centred shared Dialog with Cancel and Create in the footer. Dialog titles are `text-base` semibold by default, with `size="sm"` for compact titles. Keep descriptions at the shared muted `text-xs` size. `placement="top"` anchors the dialog 12vh from the top to keep the command palette and history search stable as results change. `placement="fullscreen"` fills the window with a 12 px inset, zero padding, and a column layout for a focused view such as a diff file. It keeps Escape and the overlay. `surface` is `card` by default, with the darker `panel` option for mostly read-only content such as reviewing a shared workflow. Use `border-info-panel-divider` for its bordered header and footer. Settings, onboarding and budget dialogs use the default surface. Dialog footers put a ghost `lg` `DialogCancel` before an `lg` action. Other secondary actions also use ghost `lg` buttons. `DialogFooter showCloseButton` renders a DialogCancel labelled Close. `LeftSheetContent` is reserved for left navigation and uses the dialog backdrop. Both close with a 28 px IconButton.

**ConfirmDialog** — `shared/ui/confirm-dialog.tsx`. Confirmation before an action that cannot be undone from the same place: removing a computer, revoking a device, deleting an automation. An `alertdialog` with `title`, `description`, optional `children` for extra context, a ghost Cancel that takes the initial focus and a `confirmLabel` button (`tone` `destructive` default, or `default`). `onConfirm` may return a promise; while it runs both buttons are disabled, `pendingLabel` replaces the label, Escape and the backdrop do nothing, and the dialog closes when it settles, unless `onConfirm` resolves to `false`: then it stays open so `children` can show the error. Reversible actions (archive, move) do not ask. Name the confirm button with the verb and object, not "OK". Triggers carry `aria-haspopup="dialog"`. Use `surface="panel"` for a darker confirmation surface and compact title in Settings.

**Badge / CountBadge** — `shared/ui/badge.tsx`. Short status labels. `tone` `neutral | info | success | warning | error | accent`, `appearance` `soft | outline`, `size` `xs | sm`. CountBadge shows a number (`max` collapses to `99+`), `strong` or `muted`. Not for interactive filters (use Chip).

**StatusDot** — `shared/ui/status-dot.tsx`. A 6 or 8 px dot with the same tones plus `strong`, `pulse`, and `ringClassName` to cut it out of a surface. `variant` `solid` (default), `hollow` (a 1.5 px ring for a muted or unreachable state such as an offline computer) and `spinner` (a Spinner in the tone's colour that takes the same layout box as the dot, so rows keep their alignment; the global reduced-motion rule stops the rotation and leaves a static arc). Give it a `label` when the dot is the only signal. It accepts a `ref`, so it can be a tooltip trigger.

Session rows use one StatusDot (`md`) as their only status glyph, mapped in `widgets/session-sidebar/session-indicator.ts`:

| State | Look | When |
| --- | --- | --- |
| running | `info` spinner | Turn running or stopping, workflow queued, planning, implementing, checking or fixing |
| needs you | `warning` dot | Approval, worker decision or worker plan waiting, workflow waiting for the operator or needing attention |
| failed | `error` dot | Failed or interrupted turn, failed or rejected workflow |
| done | `success` dot | Turn done, checks passed, result waiting for review |
| idle | `neutral` dot | Ready, stopped |
| offline | `neutral` hollow ring | The session's computer is offline |

Hovering the dot or, after a short delay, the row, or focusing the row from the keyboard, shows a panel tooltip: the full status (`Running · 2m`, `Waiting for your approval`, `Checks passed`, `Failed: <first line of the error>`) followed by muted lifecycle lines (`Created Nov 18, 2026, 3:04 PM (5d ago)`, `Last activity 2h ago`, `Archived 1d ago`). The row's accessible name keeps the status words and its accessible description carries the lifecycle lines.

**Bulk selection dialog** (`features/clean-up-sessions`). A Dialog with a SegmentedControl for the preset, a Select all Checkbox (indeterminate when partly selected) with a `N of M selected` count, and a bordered scrolling list of Label rows with a Checkbox, title and one muted detail line. Every row starts selected. The primary button names the count (`Archive 3 sessions`) and only reversible actions are offered in bulk; the result is confirmed by a Toast with Undo.

**Kbd / KeyCombo** — `shared/ui/kbd.tsx`. Key hints; `KeyCombo keys="Ctrl K"` splits on spaces. Tone `tooltip` inside tooltips.

**Meter / Progress** — `shared/ui/progress.tsx`. 4 px bars. Meter (`role="meter"`) for remaining allowances and budgets: `tone`, `stale` fades the fill, `value={null}` draws the dashed unavailable track. Progress (`role="progressbar"`) for work in flight, with `indeterminate`.

**Spinner** — `shared/ui/spinner.tsx`. Inline loading glyph; `label` when it stands alone.

**Skeleton / SkeletonList** — `shared/ui/skeleton.tsx`. Placeholders that hold the layout while a list or detail loads for the first time. Skeleton is a `bg-skeleton` shape (`line` 10 px default, `block`, `circle`) sized by the caller and hidden from assistive technology; it pulses with `animate-pulse`, which the global reduced-motion rule stops. SkeletonList stacks rows that match ListRow heights (`density` `compact` 28 px or `two-line` 44 px, `rows`, `leading` glyph) inside a `role="status"` with the required `label` as its accessible name. Use them when content replaces the placeholder in place (session list, pull request list and detail, changed files, automations); keep Spinner or StatusMessage `loading` for inline action states (sending, refreshing, searching).

**Separator** — `shared/ui/separator.tsx`. Horizontal or vertical 1 px rule. `label` centres `text-2xs` muted text between two rules (history dividers such as "Mode changed to …").

**ResizeHandle** — `shared/ui/resize-handle.tsx`. A focusable `role="separator"` that resizes the surface it sits in. `variant="edge"` (default) is an 8 px vertical strip on the `left` or `right` edge with a 1 px line that lights up on hover, focus and drag; `variant="corner"` is a 16 px square in a `corner` (`top-left` default) with the `focus-ring`. Pointer drags report the offset from the drag start through `onResize` (`onResizeStart` and `onResizeEnd` bracket the drag); arrow keys call `onStep` with a direction (`x`, `y` in −1…1; edges react only to Left and Right). The caller maps both to its own size and step, passes `aria-valuenow`, `aria-valuemin` and `aria-valuemax` for an edge, and adds Home, End or double-click through the usual handlers. `hint` shows a tooltip that hides while dragging. PanelResizer and the sidebar resizer are built on it.

### Composites

**ListRow** — `shared/ui/list-row.tsx`. Every list row. Densities `tree` (22), `compact` (28), `two-line` (title plus description), `grid` (cells laid out by `columns`), `block` (multi-line cells laid out by `columns` with auto height, for inbox items whose decisions sit beside a wrapped summary). Slots `leading`, `title`, `meta` (two-line: the relative time at the end of the title line, or a short warning-toned call to act such as `Needs you`), `description`, `trailing`, `actions` (revealed on hover, focus within and selection). `selected`, `disabled`, `level` (12 px per tree level), `dropIndicator` `before | after | inside`, `tone` `default | sidebar`. `size="sm"` is the compact sidebar scale: 13 px titles like conversation text, 40 px two-line rows with the leading glyph on the title line. `heading` gives group and section rows a muted medium title that brightens on hover. `actionsPlacement="overlay"` floats the actions over the trailing edge instead of reserving their width; while they show, `meta` and `trailing` hide, and the sidebar tone paints the row colour behind them. `actionsPlacement="visible"` keeps the actions shown at all times, for a control the operator must find without hovering, such as the open chevron on a worker row in the conversation. Passing `onClick` makes the main area a button; `mainProps` reaches it for ARIA and drag handlers. Actions sit beside the button, never inside it. A row can be a Radix trigger (`<PopoverTrigger asChild><ListRow …/></PopoverTrigger>`): `aria-expanded`, `aria-haspopup` and `aria-controls` move to the main button and `data-state=open` shows the expanded `bg-accent`.

**Panel / PanelHeader / PanelBody / Toolbar** — `shared/ui/panel.tsx`. These are layout primitives for inline surfaces and the shared drawer. PanelHeader is 40 px with an icon, title, meta and PanelAction buttons. Buttons are 28 px with 14 px glyphs. `label` sets the accessible name and tooltip, and `titleBar` aligns the header with the window caption. `leading` takes a coloured domain glyph in place of `icon`. A title can contain rich text and truncates when it has no `meta`. Toolbar is a 36 px `role="toolbar"` row with ToolbarSeparator and ToolbarSpacer.

### Drawer

`SidePanel` (`shared/ui/side-panel.tsx`) is **the only right-side panel**. The session file explorer defines its appearance and behaviour. All right-side surfaces use its right-edge entrance, 200 ms ease-out timing, reduced-motion handling, shared resize bounds, header and close action, scrollable body, and bottom footer for actions or a composer. It docks and resizes on desktop and overlays its workspace on narrower windows. The shared component owns initial widths. Use it for editing and inspection in an existing view, including automation editing and run details, workflow step creation and inspection, connection and settings inspectors, assistants, Inbox panels, and session tools. Right-side sheets, side modals, and custom panel shells are prohibited.

**EmptyState** — `shared/ui/empty-state.tsx`. Icon tile, `text-title` title, description and actions; `size` `md` for whole views, `sm` inside lists and popovers.

**StatusMessage / InlineNotice** — `shared/ui/status-message.tsx`, `shared/ui/inline-notice.tsx`. Replaces ad-hoc `role="status"` and `role="alert"` paragraphs. Tones `info | loading | success | warning | error`; error uses `role="alert"`, the others `role="status"`. `variant="inline"` is 11 px toned text; `variant="notice"` (InlineNotice) is a 12 px muted block with a toned icon and an accent background for anything but info.

**Toast / ToastRegion** — `shared/ui/toast.tsx`. A transient confirmation of something that just happened, with at most one action such as Undo. ToastRegion is the fixed bottom-centre `section` named Notifications that stacks toasts; Toast is a glass row with a toned icon (`tone` `info | success | error | loading`), a `title`, an optional muted `description`, an `action` (`label`, `onClick`, `disabled`) shown as a small ghost Button and an optional `onDismiss` close button. It is `role="status"` with `aria-live="polite"`, or `role="alert"` for errors, and never takes focus, so its action is reached with Tab. It fades and slides in over `duration-base`, which the global reduced-motion rule removes; `preview` drops the entrance for the catalog. The caller owns the timer and removes the toast when its action expires. Not for errors that need a decision (use ConfirmDialog or StatusMessage) or for permanent state.

**Composer** — `shared/ui/composer.tsx`. The only glass writing shell. `Composer` (`variant` `default` for messages, `compact` for review comments), `ComposerInput` (auto-sizing textarea), `ComposerToolbar` (`start` chips and hints, `end` actions) and `ComposerSend` (round send IconButton with `pending`). `ComposerEditor` (`shared/ui/composer-editor.tsx`) replaces `ComposerInput` where text carries inline tokens: a plain-text `role="textbox"` whose `tokens` (`id`, `offset` into `value`, React `content`) render as atomic, non-editable pieces. Arrow keys skip a token and Backspace or Delete removes it as a unit; `onChange` reports the new text, every token's offset and the tokens the operator deleted. Its handle exposes `focus`, `selection` and `offsetAt(x, y)` for inserting at the caret or the drop point. The caller owns the form and keyboard shortcuts.

**Diff viewer** — `features/diff-viewer`. The only way to show a diff: `DiffFileView` (line numbers, selection, notes and the draft slot), `CodeCommentForm` (the compact Composer with Add a comment…, optional destination SegmentedControl, Cancel and the submit Button), `WrapToggle`, `FullscreenButton` and `DiffFullscreen`. Do not mount `@pierre/diffs` elsewhere.

**SectionLabel** — `shared/ui/section-label.tsx`. 24 px group heading with optional `count` and `action`.

**Field / FieldMessages** — `shared/ui/field.tsx`. Label, control, hint and error or warning messages (`${id}-messages` for `aria-describedby`); `layout` `stacked`, `inline` or `switch` (label on the left, a Switch on the right edge, hint and messages below across the row). A Select inside a form renders Radix's hidden native `<select>` after its trigger; Field drops the trigger's trailing spacing in that case, so put the Select directly in the Field without a wrapper `<div>`.

**KeyValueList** — `shared/ui/key-value-list.tsx`. Two-column `dl` for details and metadata.

**CodeBlock** — `shared/ui/code-block.tsx`. Monospace block with an optional file `label`, copy button and `wrap`. Use the `flat` variant for setup snippets in Settings. Set `maxHeightClassName={null}` for snippets that should expand to their full height and scroll horizontally without wrapping.

**Disclosure / NativeDisclosure** — `shared/ui/disclosure.tsx`. A 28 px row with a rotating chevron, optional `icon`, `meta`, muted `description` lines under the title (a string clamps to two lines; a node renders its own lines) and collapsible content; controlled or uncontrolled. `triggerLabel` names the trigger when the visible title is not enough. `triggerTone="muted"` uses the helper text scale for secondary details. NativeDisclosure renders the same row with `<details>` and `<summary>`: use it when the content must stay in the document while collapsed (find in page, deep links that open a section) or when callers rely on the `open` attribute, such as activity rows and saved result versions. Use `variant="flat"` for a disclosure inside a popover that should retain the surface color on hover.

**MiddleTruncatedText** — `shared/ui/middle-truncated-text.tsx`. Displays long paths with both ends visible and exposes the complete value on hover. Use its `path` variant to preserve the final path segment. Editable folder and file fields use `PathInput`, which shows the full value while focused.

**AddTile** — `shared/ui/add-tile.tsx`. A dashed tile that starts something new in an empty space: a dashed icon square (`icon`, default Plus), a `text-ui` title and an optional `text-2xs` description. Size it from the caller (the graph editor's empty canvas gives it the step node size). Not for regular commands (use Button) or list rows.

**SettingsSection / SettingsRow** — `shared/ui/settings-section.tsx`. Settings pages. SettingsSection heads flat rows with a SectionLabel (`action` sits on its right). Subtle dividers separate rows on the canvas. The page title lives in the Settings header. SettingsRow aligns the title and controls on one line and puts the `text-xs` description below them. SettingsRows provides the same flat dividers for rows under an existing heading, such as Starter routines. Put status lines in the description as StatusMessage. Use Field for stacked settings inputs, with a muted label and subtle hint below the input. Set `resize="none"` on settings textareas to keep content-driven height without a resize handle.

The composer MCP chip opens an inventory Popover with ListRow for server names, scopes and transports, and StatusMessage for availability and configuration errors. Show the hook policy in a separate row. Place the repository trust InlineNotice above the session composer with the definition summary and Trust and Not now actions. The MCP popover can reopen a dismissed notice. The new-session form omits the MCP field.

### Domain glyphs

**StatusIcon** and the tone map — `entities/status`. `status` `success | error | warning | info | pending | running | idle`; `statusTones` maps each to a `Tone`, `toneText` maps a tone to its text class. Session rows use the StatusDot mapping above; workflow tones re-export the same map. ChecksIcon is built on StatusIcon.

**DiffStat, StatusLetter, FileGlyph** — `entities/file-change`. `+N −N` counts, the A/M/D/R letter for a changed file and the coloured file-type glyph. `widgets/workspace-files/file-glyph.tsx` re-exports FileGlyph.

**SubsessionRow** — `entities/session/subsession-row.tsx`. One row for a worker or workflow step session, shared by the Agents panel (`widgets/session-subsessions`, a Popover with `surface="panel"` anchored to the quiet activity line above the composer) and the session card's Subsessions section. `density="two-line"` (`size="sm"`, Agents panel): a StatusDot (`info` spinner while working, `warning` when it needs approval, `error` when failed or interrupted, `success`, otherwise neutral), the title, the state word only for warning and error, the live elapsed time in muted tabular numbers, and a muted 2xs line with the provider mark and model plus the folder basename when it differs from `parentDirectory`; a 24 px danger IconButton Stop is revealed on hover and focus. `density="compact"` (session card): the provider mark with a StatusDot badge cut out of the `info-panel` surface (spinner, warning or error), the truncated title and the elapsed time right-aligned. Finished rows are dimmed to 60 % opacity. The status mapping lives in `entities/session/subsession-status.ts`; the conversation's worker list (`widgets/delegations`) reuses it for its own rows, which add an on-demand details disclosure and inline worker decisions.

**ProjectChip** — `shared/ui/project-chip.tsx`. Hash-coloured project swatch for the header breadcrumb and automation chips; it carries no domain type, so it stays in shared. Session rows do not use it: the leading slot holds the status dot and the directory label identifies the project.

### Live workflow graphs

Flows uses the workflow editor's step cards and connections in read-only mode. Use info-panel surfaces for workflow summaries and the compact session rows under each step. Keep titles, counts and elapsed time at the 13 px UI scale. Use a shared StatusDot spinner for running, warning for an operator decision, error for failure and success for a completed child. A child row exposes its current step in a shared tooltip. Keep the session and pull request as separate focus targets.

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
| Settings nav buttons, sidebar nav buttons                                     | `<NavList>` + `<NavItem tone="default" | "sidebar" | "flat">`               |
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
| Custom option-list popovers (model, folder, branch, workflow pickers)    | `<Combobox trigger={<Chip …/>}>` or `<Listbox>`                    |
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
| `title={blockedReason}` on a disabled Button or IconButton                    | `<DisabledHint reason={blockedReason}>`                            |
| `title=` on a Chip or other trigger                                           | `<Hint label="…">` around the trigger                             |
| Hand-written `role="separator"` drag strips, resize corner `<button>`s         | `<ResizeHandle variant="edge" | "corner">`                       |
| Hand-built Cancel + destructive Dialog footers                                | `<ConfirmDialog>`                                                  |
| `outline` or `md` Cancel buttons in a `DialogFooter`                          | `<DialogCancel />` + an `lg` action                                |
| `flex items-center justify-between` rows with a Label and a Switch            | `<Field layout="switch">`                                          |
| `title=` on SegmentedControl icon or count segments                           | Option `tooltip`                                                   |
| `StatusMessage tone="loading"` as the only content of a list that loads      | `<SkeletonList label="Loading …">`                                 |
| Dashed `border-dashed` "add" buttons                                         | `<AddTile>`                                                        |
