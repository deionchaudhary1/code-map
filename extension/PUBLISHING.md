# Publish Code Map to the VS Code Marketplace

The extension manifest uses the local-only publisher ID `code-map-local` and the `UNLICENSED` marker. To release publicly, register your publisher and choose a license for the project.

1. Sign in with your Microsoft account and choose **Create publisher**. Pick a unique publisher ID and a display name. The ID becomes part of the extension identifier and cannot be changed once created. [Visual Studio Marketplace publisher management](https://marketplace.visualstudio.com/manage)
2. Replace `code-map-local` in `extension/package.json` with your publisher ID. Update the extension's `license` field and place the chosen license text in `extension/LICENSE`. The released extension ID will be `<publisher-id>.code-map`.

   Confirm the extension name and display name are available before publishing; the local package does not reserve them. If either needs changing, update the manifest before producing the public VSIX.
3. Install the root, web, and extension dependencies as documented in [the extension README](README.md). Run `npm exec -- vsce package` from `extension/`. Install the resulting `code-map-0.1.0.vsix` in VS Code and try **Open Code Map** on a trusted workspace. If both local and release builds are installed, uninstall the `code-map-local.code-map` build before testing the release commands.
4. Open your publisher in Marketplace management. Choose **New extension**, select **Visual Studio Code**, and upload the VSIX. For each later release, update the extension manifest version and changelog, build a fresh VSIX, and upload it to the existing listing. [Official publishing instructions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#publish-an-extension)

## Automate future releases

For GitHub Actions, configure a **Trusted Publishing** policy under the publisher in Marketplace management. Match the repository owner, repository name, workflow filename, and GitHub environment if the job uses one. Give the publishing job `contents: read` and `id-token: write`. Use Node.js 22 or later, install the repository's dependencies, and run `npm exec -- vsce publish --oidc` from `extension/`. OIDC supplies a short-lived credential and requires no PAT secret. [Official Trusted Publishing instructions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#publish-with-github-actions-and-trusted-publishing)

Microsoft's publishing guide gives December 1, 2026 as the retirement date for global Azure DevOps Personal Access Tokens. Use manual VSIX upload or federated publishing for new release setups. [Official retirement guidance](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#secure-automated-publishing-to-visual-studio-marketplace)
