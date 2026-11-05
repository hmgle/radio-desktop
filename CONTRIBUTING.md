# Contributing

Thank you for helping improve Radio Desktop. Reports and discussions in English or Simplified Chinese are welcome.

## Report a bug or suggest a feature

Search existing issues first. Include the app version or commit, OS version, CPU architecture, relevant Linux desktop/WebKit version, reproduction steps, expected behavior, and actual behavior. A screenshot and error details help. For playback bugs, include a public stream URL and whether other stations work. Remove credentials, private URLs, and personal listening data before sharing files.

For a feature request, describe the listening problem and the behavior you would like. Discuss broad changes before spending time implementing them.

## Work on the code

See the [development guide](docs/development.md) for dependencies, checks, architecture, and packages. Keep each pull request focused. Follow surrounding Go and TypeScript style, format Go with `gofmt`, and add behavior tests for changed logic and failure paths. Regenerate MyGo bindings when changing bound APIs. Update both message catalogs for UI text, and keep the English and Chinese READMEs/user guides aligned for user-facing changes.

Before opening a pull request, run the relevant backend/frontend checks in the development guide. Explain what changed, why, how it was tested, and any platform limitations. Do not include generated builds, local databases, secrets, or unrelated files.

## License

By contributing original work, you agree to license it under this project's GPL-3.0-only license. Contributions must be yours to submit or have compatible permission. Preserve third-party attribution and describe new dependencies or borrowed assets with their source and license.
