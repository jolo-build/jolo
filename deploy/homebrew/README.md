# Homebrew tap assets

`Formula/jolo-cli.rb` and `Casks/jolo.rb` are the source files for the
[jolo-build/homebrew-tap](https://github.com/jolo-build/homebrew-tap) repository.

The `homebrew-tap` job in [cli-release.yml](../../.github/workflows/cli-release.yml) renders
these with the checksums of each tagged release and pushes the result to the tap repository.
Update them by editing the templates here — not in the tap repo, which is overwritten.

The job needs a `TAP_GITHUB_TOKEN` repository secret: a fine-grained access token with
contents read/write on `jolo-build/homebrew-tap`. Without the secret the job skips itself.
