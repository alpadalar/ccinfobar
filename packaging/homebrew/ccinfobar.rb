# url and sha256 are filled by scripts/homebrew-formula.mjs after npm publish
class Ccinfobar < Formula
  desc "Fast, themeable status line for Claude Code"
  homepage "https://github.com/alpadalar/ccinfobar"
  url "https://registry.npmjs.org/ccinfobar/-/ccinfobar-0.6.2.tgz"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "MIT"

  livecheck do
    url :stable
    strategy :npm
  end

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  def caveats
    <<~EOS
      To use ccinfobar as your Claude Code status line, run:
        ccinfobar install
      Before `brew uninstall ccinfobar`, run `ccinfobar uninstall` to restore your previous status line.
    EOS
  end

  test do
    ENV["CCINFOBAR_CONFIG_DIR"] = (testpath/"config").to_s
    ENV["CCINFOBAR_CACHE_DIR"] = (testpath/"cache").to_s
    ENV["CLAUDE_CONFIG_DIR"] = (testpath/"claude").to_s
    ENV["CCINFOBAR_NO_UPDATE"] = "1"
    ENV["CCINFOBAR_NO_JOBS"] = "1"
    ENV["CCINFOBAR_NO_USAGE_API"] = "1"
    ENV["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1"
    assert_match version.to_s, shell_output("#{bin}/ccinfobar --version")

    payload = '{"model":{"display_name":"Opus"},"workspace":{"current_dir":"/tmp"}}'
    refute_empty pipe_output(bin/"ccinfobar", payload, 0).strip
  end
end
