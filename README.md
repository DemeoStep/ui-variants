# ui-variants

A [Claude Code](https://code.claude.com) mod that shows UI variants for your Flutter project in a live macOS window instead of describing them with diagrams in the terminal.

Claude writes 2–4 variants of a screen, a color scheme or a widget into a temporary picker app. You compare them side by side in real device frames, ask for revisions and pick one. Your choice goes back to the session by itself, and Claude implements it in the project. You never have to switch to the terminal.

![Three layout variants of a "Today" screen side by side in iPhone 17 frames](screenshots/compare.png)

## What the window does

- **Side-by-side comparison.** All variants of the current question are visible at once, each in the frame of the device you pick. The menu lists iOS and Android phones and tablets, including iPhone 17, 17 Pro, 17 Pro Max, Air and 16e, plus a "no frame" mode. Landscape and dark theme are one click away.
- **Several questions at once.** When a show has independent things to choose, such as a layout and a color, you mark a variant in each question and send everything in one message.
- **Revisions on the fly.** "Revise variant" sends a request to Claude right away: "make the button blue", "increase the padding", "swap the blocks". Claude changes only that variant, and the window refreshes with a hot restart.
- **Notes for the choice.** A note on a variant, or a general note, reaches Claude together with your choice.
- **The window does not linger.** It closes after you choose and when the session ends. If the session dies, the window closes itself in about a minute.

| Several questions | Device frames |
|---|---|
| ![The Colors question with two color variants](screenshots/colors.png) | ![The device menu with the newest iPhones](screenshots/devices.png) |

| Ask for a revision | Claude is revising |
|---|---|
| ![The revise dialog on a variant](screenshots/revise-dialog.png) | ![A card shows that Claude is revising the variant](screenshots/revising.png) |

## Requirements

- macOS with Xcode and the Flutter SDK. If the project has `.fvm/flutter_sdk`, that Flutter is used.
- Claude Code 2.1.287 or newer: the mod is built on the mods API (a hooks module).

## Install

Enable the mod only in the Flutter projects where you want it (`local` scope). In other projects it is not loaded and takes no context.

In a Claude Code terminal session inside the project:

```
/plugin install ui-variants --marketplace DemeoStep/ui-variants
```

Answer `y` to add the marketplace, then choose "Install for you, in this repo only (local scope)".

Or from the command line in the project root:

```bash
claude plugin marketplace add DemeoStep/ui-variants
```

```bash
claude plugin install ui-variants@demeostep --scope local
```

The `local` install writes one line to the project's `.claude/settings.local.json`. Claude Code adds that file to your global git excludes, so it never ends up in a commit.

To turn the mod off and on again:

```bash
claude plugin disable ui-variants@demeostep --scope local
```

```bash
claude plugin enable ui-variants@demeostep --scope local
```

### Recommended settings

To let Claude write variants into the temporary app without permission prompts, add this to `~/.claude/settings.json`:

```json
{
  "permissions": {
    "additionalDirectories": ["/Users/<you>/Library/Caches/ui-variants"],
    "allow": ["Edit(~/Library/Caches/ui-variants/**)"]
  }
}
```

## Usage

There is nothing to run. When a task has several equally good options, Claude loads the `ui-variants` skill on its own and shows them in the window. You can also ask for variants explicitly:

```
/ui-variants:ui-variants sign-in screen
```

Skill arguments:
- `close` closes the project's window;
- `clean` closes the window and deletes the temporary app.

The first time in a project the window takes about a minute to open while the app is created and built. After that, variants refresh with a hot restart.

## How it works

1. **The skill** `skills/ui-variants/SKILL.md` tells Claude when and how to show variants. Only its description stays in context, about 90 tokens.
2. **The mod** `hooks/register.js` does nothing until the skill loads. Then it creates or updates a temporary app in `~/Library/Caches/ui-variants/<package>-<hash>/`: `flutter create`, the templates from `templates/`, a path dependency on your project, `flutter pub get`. Your project is never changed; only its `pubspec.yaml` is read.
3. **The window.** When a Claude turn changes the variants, the mod starts `flutter run -d macos` or hot restarts the running window.
4. **Feedback.** The window writes choices, notes and revisions to `.state/decision.json`. The mod sends them to the session as the next message (`$.prompt.submit`) and acknowledges them to the window through `.state/ack.json` and `.state/requests-ack.json`.

**Device frames** come from the [device_frame](https://pub.dev/packages/device_frame) package, resolved in the `>=1.2.0 <2.0.0` range. The newest iPhones, which the package does not have yet, are defined by the mod. If `device_frame` does not fit your project's dependencies, the mod builds the picker with simplified built-in frames instead.

**Network** is used only by `flutter pub get`.

## Limitations

- macOS only. Project plugins without macOS support do not work in the window.
- The window does not open in `claude -p`: the process exits before the mod can start it.

## Development

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

Bump `version` in `.claude-plugin/plugin.json` after every change. The mod uses it to update the templates in already created temporary apps; `lib/registry.dart`, `lib/theme.dart` and `lib/variants/` are never overwritten.

The screenshots show the real picker window rendered with demo variants.

## License

[MIT](LICENSE) © 2026 Oleksii Horiainov
