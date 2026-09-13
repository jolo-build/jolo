# Homebrew tap assets

`Formula/jolo-cli.rb` and `Casks/jolo.rb` are the source files for the
[jolo-build/homebrew-tap](https://github.com/jolo-build/homebrew-tap) repository.

The tap's `.github/workflows/update.yml` checks GitHub's latest stable Jolo release
every 30 minutes and on manual dispatch. It downloads the published checksums and
runs `scripts/update-homebrew-tap.js` from that release's tag to render the formula
and cask. Unchanged versions are a no-op. GitHub may delay scheduled runs.

The workflow runs in the tap repository with its own `GITHUB_TOKEN`; no personal
access token or repository secret is needed. [update.yml](update.yml) is the source
copy of that workflow. Copy changes to the tap's `.github/workflows/update.yml`.
Edit the renderer script for formula/cask changes; generated files are overwritten.
