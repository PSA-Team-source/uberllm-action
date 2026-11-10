# UberLLM PR Reviewer

A GitHub Action that sends a pull request's diff to a chat model and posts the review as one PR comment. The comment is updated in place on every push, so a PR never collects a pile of bot comments.

It works with [UberLLM](https://uberllm.dev) (one key, hundreds of models) and with any other OpenAI-compatible API: set `base-url`.

- No dependencies: one `index.js` on Node 24, nothing to install or build.
- Lock files, minified files, source maps, `dist/` and `vendor/` are left out of the diff so you don't pay for them.
- Large PRs are trimmed to `max-diff-chars`. Whole files go in first, and the comment says what was cut.
- Pull requests from forks get no secrets on `pull_request`, so the action skips them with a warning instead of failing.
- A model or network error logs a warning and doesn't block the merge (set `fail-on-error: true` to change that).

Made by the UberLLM team.

## Usage

1. Create an API key at <https://uberllm.dev/dashboard/keys> and add it to your repository as a secret named `UBERLLM_API_KEY` (Settings → Secrets and variables → Actions → New repository secret).
2. Add `.github/workflows/ai-review.yml`:

```yaml
name: AI review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    if: github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    steps:
      - uses: PSA-Team-source/uberllm-action@v1
        with:
          api-key: ${{ secrets.UBERLLM_API_KEY }}
          # model: qwen/qwen3-coder          # any id from https://api.uberllm.dev/v1/models
          # max-diff-chars: 60000
          # exclude: "docs/**, *.generated.ts"
```

That's all you need. Open a PR and the review appears as a comment within a minute or so.

### Pick a model

The default is `deepseek/deepseek-v4-pro`, a strong reasoning model with a 1M-token context and a low per-token price. Any chat model id from `GET https://api.uberllm.dev/v1/models` works, for example `qwen/qwen3-coder`, `moonshotai/kimi-k2.7-code`, `anthropic/claude-sonnet-4.6` or `openai/gpt-5.3-codex`. Current prices for every model: <https://uberllm.dev/models>. There's also an open dataset of them at [PSA-Team-source/llm-api-prices](https://github.com/PSA-Team-source/llm-api-prices).

### Other OpenAI-compatible APIs

```yaml
      - uses: PSA-Team-source/uberllm-action@v1
        with:
          base-url: https://api.openai.com/v1
          api-key: ${{ secrets.OPENAI_API_KEY }}
          model: gpt-5-mini
```

Any server that implements `POST /chat/completions` works: OpenAI, OpenRouter (`https://openrouter.ai/api/v1`), DeepSeek (`https://api.deepseek.com/v1`), a self-hosted vLLM, and others.

### Your own review rules

```yaml
        with:
          api-key: ${{ secrets.UBERLLM_API_KEY }}
          prompt: |
            You review Go services. Flag unchecked errors, goroutine leaks, missing context
            timeouts and SQL built with string concatenation. File, line and fix for each.
            Nothing else.
```

### Use the review in a later step

```yaml
      - id: review
        uses: PSA-Team-source/uberllm-action@v1
        with:
          api-key: ${{ secrets.UBERLLM_API_KEY }}
          post-comment: "false"
      - run: echo "${{ steps.review.outputs.review }}" | head -50
```

## Inputs

| Input | Default | What it does |
|---|---|---|
| `api-key` | (required) | API key for `base-url`. Keep it in a secret. |
| `model` | `deepseek/deepseek-v4-pro` | Model id, as listed by `GET <base-url>/models` |
| `base-url` | `https://api.uberllm.dev/v1` | OpenAI-compatible base URL (before `/chat/completions`) |
| `max-diff-chars` | `60000` | Most characters of diff sent to the model |
| `prompt` | built in | System prompt. The default asks for real problems only (bugs, security, data loss), with file, line and fix |
| `exclude` | | Extra patterns to leave out, comma or newline separated (`*` = within a folder, `**` = any depth) |
| `max-tokens` | | `max_tokens` for the answer. Empty = the model's default |
| `post-comment` | `true` | `false` = only set the `review` output and the job summary |
| `fail-on-error` | `false` | `true` = fail the step when the model or GitHub API errors |
| `github-token` | `${{ github.token }}` | Reads the diff and writes the comment (needs `pull-requests: write`) |

## Outputs

| Output | What it holds |
|---|---|
| `review` | The review text (Markdown) |
| `comment-url` | URL of the PR comment, when one was posted |

## How it works

1. It reads the PR diff from the GitHub API. For PRs too big for GitHub's `.diff`, it builds the diff from the per-file patches.
2. It drops generated and lock files, then fits whole files into `max-diff-chars`.
3. It sends the PR title, description and diff to `POST <base-url>/chat/completions` with your prompt, retrying on 429 and 5xx.
4. It posts the answer as a comment marked `<!-- uberllm-pr-review -->`, or edits that comment if it's already there, and adds it to the job summary. The comment footer shows the model and the token counts.

The diff goes to the API you configure, and nowhere else. Don't use this on `pull_request_target` together with a checkout of the PR's code.

## Develop

```sh
node test.js     # diff filtering and trimming
```

Run it against a real PR without posting anything:

```sh
gh api repos/OWNER/REPO/pulls/123 | jq '{pull_request: ., repository: .base.repo}' > /tmp/event.json
env "INPUT_API-KEY=$UBERLLM_API_KEY" INPUT_POST-COMMENT=false "INPUT_GITHUB-TOKEN=$(gh auth token)" \
  GITHUB_EVENT_PATH=/tmp/event.json node index.js
```

## License

[MIT](LICENSE)
