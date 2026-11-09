# Nerla design system

How Nerla's UI is built. Most rules here are checked by tests that read the source, listed at the end.

- `website/src/app/nerla-themes.css` holds the raw palette for each mode.
- `website/src/app/globals.css` maps it onto Tailwind, with the type scale, utilities, motion and accessibility CSS.
- `website/src/components/ui/` holds the shared components.

## Colours

A candy palette on plain grey neutrals. Sky and pistachio lead, bubblegum and lavender accent, lemon marks warnings and berry marks errors and destructive actions.

Each pastel (`pistachio`, `bubblegum`, `sky`, `lavender`, `lemon`) has four steps:

| Step      | Example              | Use                                    |
| --------- | -------------------- | -------------------------------------- |
| base      | `--color-sky`        | Fills such as event blocks             |
| `-soft`   | `--color-sky-soft`   | Quiet fills such as chips and badges   |
| `-strong` | `--color-sky-strong` | Marks, presence cats and folder backs  |
| `-ink`    | `--color-sky-ink`    | Text on the base or soft fill          |

- **Neutrals**: `bg`, `surface`, `surface-solid`, `surface-raised`, `sunk`, `hover`, `selected`, `scrim`, `border`, `input`, `text`, `text-muted`.
- **Accent**: `accent` is the pink of the primary button. Link-like text uses `accent-text`, which is blue. `secondary` is the lavender pair.
- **Alerts and marks**: `berry` and `berry-text` for errors, `unread`, `join`, the task status colours `status-*`, the board column fills `col-*` and the stat fills `stat-1` to `stat-4`.

Use them through Tailwind as `app-*` classes (`bg-app-sky-soft text-app-sky-ink`, `bg-app-selected`) or the shadcn names (`bg-card`, `text-muted-foreground`, `border-border`, `ring-ring`). `--ring` is the text colour, so focus rings are ink.

### Modes

- Light and dark each have a block in `nerla-themes.css`, keyed on `[data-theme="nerla"][data-mode="light|dark"]`. In dark mode the soft and strong steps equal the base pastels, on charcoal neutrals.
- **More contrast** (the setting or `prefers-contrast: more`) raises muted text to 7:1, borders to 3:1, and gives pastel chips and selected fills an ink edge.
- **Forced colours** give focus, selection and drawn controls system colours.
- Any `[data-theme][data-mode]` element maps the tokens, so the call stage can be dark inside a light app. Popovers inside it portal through `usePortalContainer` (`portal-container.tsx`).

## Type

Figtree for body and display, JetBrains Mono for code, Atkinson Hyperlegible for easier reading, all bundled in `website/src/fonts.ts`.

| Class          | Size      | Line height |
| -------------- | --------- | ----------- |
| `text-micro`   | 0.6875rem | 1rem        |
| `text-caption` | 0.75rem   | 1rem        |
| `text-ui`      | 0.8125rem | 1.25rem     |
| `text-body`    | 0.875rem  | 1.25rem     |
| `text-lead`    | 1rem      | 1.5rem      |
| `text-title`   | 1.25rem   | 1.75rem     |
| `text-page`    | 1.5rem    | 2rem        |

Use these, never `text-xs`, `text-sm` and friends. Controls use weight 500, headings 600, and `font-bold` is kept for page titles.

## Size, corners, shadows and motion

- **Rem only**, never `px`. Convert with `remPx` from `lib/utils.ts` when maths needs pixels.
- **Corners**: controls use `rounded-md` (0.5rem). The scale runs `rounded-xs` to `rounded-xl`, and `rounded-2xl` and up are refused.
- **Controls** are 2rem high on desktop and 2.75rem on phones. A `Button` gets its size from its `size` prop, never from `h-*`, `py-*` or `text-*`. `TAP` gives a small control a phone touch area without changing its look.
- **Shadows**: one raised shadow, `--shadow-popover`, for popovers, menus and floating cards. Hairline edges are a `0.0625rem` ring or `border-border`.
- **Motion**: durations and easings are variables on `:root` in `globals.css`, used through the `motion-*` classes and the helpers in `lib/motion.ts`, which follow the reduced motion setting.

## House rules

- Tokens only. No hex, no stock Tailwind palette, no raw `white` or `black` outside the files the guard allows, no gradients.
- A soft fill takes its own ink: `bg-app-sky-soft` with `text-app-sky-ink`.
- `text-accent` is the pink fill, not text. Links use `text-app-accent-text`.
- A button shows an icon or a shortcut, never both.
- Icons come from `website/src/components/icons.ts`, which re-exports Phosphor icons under neutral names.
- Class names stay whole in source, since the guards read text. `` `bg-${tone}-soft` `` slips past them.

## Components

All in `website/src/components/ui/` unless noted. Build on these rather than writing a new control.

| Component                                                    | Use it for                                                                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `Button`                                                     | Every button. Variants `default`, `sky`, `secondary`, `outline`, `ghost`, `destructive`, `join`, `bubble`, `link`. `shortcut` shows a key cap |
| `BaseModal`, `ConfirmDialog` (`components/settings/`)        | Dialogs, and confirming a destructive action                                                            |
| `BottomSheet`                                                | A sheet over a scrim on phones                                                                          |
| `AnchoredPopover`, `useAnchoredPosition`, `usePopoverToggle` | Non-modal popovers placed against an element, a selection or a drag                                    |
| `useMenuKeys`, `CheckItem` (`check-menu.tsx`)                | Menus opened by a button                                                                                |
| `Toolbar`, `TOOL`                                            | A row of controls with one tab stop                                                                     |
| `Collapse`                                                   | Content that opens and closes                                                                           |
| `Input`, `Select`, `AutosizeTextarea`, `DateInput`, `TimeField`, `MiniMonth`, `RadioList`, `SegmentedControl` | Form fields. `DateInput` shows DD-MM-YYYY, `TimeField` is 24 hour |
| `FieldError`, `FIELD_LABEL`, `TEXT_LINK` (`field-label.ts`)  | Field errors, labels and inline links                                                                   |
| `Skeleton`, `Spinner`, `LoadingSpinner`, `TypingDots`        | Loading and waiting                                                                                     |
| `LoadState` (`components/settings/`)                         | A failed load with Try again                                                                            |
| `Badge`, `UnreadDot`, `NotFoundView`                         | Counts, unread marks and the 404 page                                                                   |
| `UserAvatar`, `Avatar`, `PresenceCat`, `IdentityTile`, `SymbolPicker` | Users, presence, and workspace or project symbols                                              |
| `StatusIcon`, `PriorityIcon`                                 | Task status and priority                                                                                |
| `IconTip`, `Tooltip`, `ShortcutHint`, `ShortcutKeys`         | Icon button names on hover and focus, hints and key caps                                                |
| `CreateFab`                                                  | The Create button above the phone tab bar                                                               |
| `cat-scenes.tsx`                                             | The cat illustrations                                                                                   |

`PresenceCat` is the logo cat, masked from `assets/cat-logo.png`, in the colour of the user's state: available pistachio, busy and do not disturb berry, away lemon, out of office lavender, secret sky and offline muted grey. Its cutout takes the fill behind it through `--row-fill`. The cat is `aria-hidden`, so show the word from `PRESENCE_WORD` (`lib/presence.ts`) beside it.

## Accessibility

- Dialogs, popovers, menus and the task panel return focus to what opened them.
- Lists and toolbars are one tab stop with arrow keys inside: `Toolbar`, `useRovingList` (`lib/useRovingList.ts`) or `rovingIndex` (`lib/rovingFocus.ts`).
- Every icon button has a name and an `IconTip`.
- Text reaches 4.5:1 on every surface, field edges and marks 3:1, and nothing relies on colour alone.
- "Skip to content" is the first stop in `AppShell`, and F6 moves between the sidebar, the page and the chat.

The user's accessibility settings are saved on their account (`lib/accessibility.ts`, with the server keys in `server/src/utils/accessibility.ts`) and set attributes on `<html>`:

| Setting             | Key             | Effect                                                    |
| ------------------- | --------------- | --------------------------------------------------------- |
| Shapes with colours | `typeShapes`    | Calendar event types show a shape beside their colour     |
| Reduce motion       | `reduceMotion`  | `data-motion="reduce"`. Fades and transitions stop        |
| Easier reading      | `easierReading` | `data-reading="easier"`. Atkinson Hyperlegible and wider spacing |
| Larger text         | `largerText`    | `data-text="larger"`. The small type steps go up one step |
| More contrast       | `moreContrast`  | `data-contrast="more"`                                    |
| Still z's           | `stillZs`       | `data-zs`. The sleeping cat's z's rest. On by default     |

The device's own reduced motion and more contrast settings apply whatever the account says (`rootState`). `website/public/theme-init.js` sets the attributes before the first paint and repeats `rootState` by hand, so change both together.

## The checks

- `website/src/app/theme-classes.test.ts` reads every source file and refuses unknown colour keys, off-scale corners, type, weights and spacing, pixel values, raw colours, a soft fill without its ink, `text-accent` as text, sizing in a `Button`'s `className`, a `Button` with both a shortcut and an icon, and icon buttons with no name. An exception goes in its allow lists with a reason.
- `website/src/app/tokens.test.ts` checks every contrast pairing in light, dark and more contrast, and that the theme has no gradients or `px`.
