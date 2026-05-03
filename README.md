# Middle Click Autoscroll

`Middle Click Autoscroll` is a macOS Safari Web Extension that adds Windows-style middle-click autoscroll to Safari.

## What It Does

- Toggles autoscroll with the middle mouse button.
- Shows a centered autoscroll indicator at the click position.
- Scrolls the nearest scrollable container, not just the page.
- Avoids hijacking middle-clicks on links.
- Includes a popup toggle to enable or disable the feature globally.

## Project Structure

- `Middle Click Autoscroll/`: macOS host app that helps users install and enable the Safari extension.
- `Middle Click Autoscroll Extension/`: Safari Web Extension resources and native extension handler.
- `Middle Click Autoscroll.xcodeproj/`: Xcode project.

## Requirements

- macOS
- Xcode
- Safari
- A pointing device with a middle mouse button or equivalent input

## Running Locally

1. Open `Middle Click Autoscroll.xcodeproj` in Xcode.
2. Select the `Middle Click Autoscroll` app scheme.
3. Build and run the app.
4. In Safari, open `Safari > Settings > Extensions`.
5. Enable `Middle Click Autoscroll`.
6. Set website access to `All Websites` if Safari prompts for it.

The helper app opens Safari and explains the extension enablement step. Once enabled, the extension popup can be used to turn autoscroll on or off.

## Notes

- This repository is intended for source distribution on GitHub rather than App Store submission.
- Xcode user data, derived data, and build artifacts are ignored.

## License

No license has been added yet. If you want other people to use, modify, or redistribute this project, add a license before publishing.
