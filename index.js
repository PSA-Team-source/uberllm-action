// UberLLM PR Reviewer: sends a pull request's diff to any chat model on an
// OpenAI-compatible API and posts the answer as one PR comment (updated in
// place on every push). No dependencies: Node's built-in fetch only.
'use strict';

const fs = require('fs');

const MARKER = '<!-- uberllm-pr-review -->';
const DEFAULT_EXCLUDE = [
  '*.lock', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'go.sum', 'Cargo.lock', 'poetry.lock', 'uv.lock',
  'composer.lock', 'Gemfile.lock', '*.min.js', '*.min.css', '*.map', '*.snap', 'dist/*', 'vendor/*',
];
const DEFAULT_PROMPT = [
  'You are a senior engineer reviewing a pull request.',
  'Report only real problems: bugs, security issues, data loss, race conditions, broken error handling, missing input validation, and clear performance mistakes.',
  'For each finding give the file and line from the diff, what goes wrong, and a concrete fix.',
  'Skip style nits and praise. Do not restate the diff.',
  'If nothing needs to change, say so in one sentence.',
  'Answer in GitHub Markdown, most important finding first.',
].join('\n');

// ---------------------------------------------------------------- inputs

function input(name, fallback = '') {
  const v = process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

function bool(name, fallback) {
  const v = input(name, String(fallback)).toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

function int(name, fallback) {
  const n = Number.parseInt(input(name, String(fallback)), 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return n;
}

// ---------------------------------------------------------------- diff

/** "dist/*" matches dist/a.js and dist/x/y.js; "*.lock" matches any file name ending .lock. */
function globToRegExp(glob) {
  const esc = glob.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*');
  return glob.includes('/') ? new RegExp(`^${esc.replace(/\[\^\/\]\*$/, '.*')}$`) : new RegExp(`(^|/)${esc}$`);
}

function excluded(path, patterns) {
  return patterns.some((p) => p.test(path));
}

/** Split a unified diff into per-file chunks: [{path, text}]. */
function splitDiff(diff) {
  const parts = diff.split(/^(?=diff --git )/m).filter((s) => s.trim());
  return parts.map((text) => {
    const m = text.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    return { path: m ? m[2] : '', text };
  });
}

/**
 * Drop excluded files, then keep whole files until the budget is spent; a file
 * that does not fit is cut at a line boundary. Returns the text and what was
 * left out so the model and the reader both know the review is partial.
 */
function prepareDiff(diff, maxChars, patterns) {
  const files = splitDiff(diff);
  const skipped = [];
  const cut = [];
  let out = '';
  for (const f of files) {
    if (f.path && excluded(f.path, patterns)) {
      skipped.push(f.path);
      continue;
    }
    const room = maxChars - out.length;
    if (f.text.length <= room) {
      out += f.text;
    } else if (room > 200) {
      out += f.text.slice(0, f.text.lastIndexOf('\n', room) + 1 || room) + '\n[... diff of this file cut here ...]\n';
      cut.push(f.path);
    } else {
      cut.push(f.path);
    }
  }
  return { text: out, skipped, cut, files: files.length };
}

// ---------------------------------------------------------------- HTTP

async function request(url, opts, label, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    if (i) await new Promise((r) => setTimeout(r, 2000 * 3 ** (i - 1)));
    let res;
    try {
      res = await fetch(url, { ...opts, signal: AbortSignal.timeout(opts.timeoutMs || 120000) });
    } catch (e) {
      last = new Error(`${label}: ${e.message || e}`); // network error or timeout: retry
      continue;
    }
    if (res.ok) return res;
    last = new Error(`${label}: HTTP ${res.status} ${(await res.text()).slice(0, 500)}`);
    if (res.status !== 429 && res.status < 500) throw last; // a 4xx will not get better
  }
  throw last;
}

function gh(token) {
  const api = process.env.GITHUB_API_URL || 'https://api.github.com';
  const headers = { Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'uberllm-pr-reviewer' };
  return {
    async diff(repo, number) {
      const res = await request(`${api}/repos/${repo}/pulls/${number}`, { headers: { ...headers, Accept: 'application/vnd.github.diff' } }, 'GitHub diff').catch(() => null);
      if (res) return res.text();
      // Very large PRs: GitHub refuses the .diff, so build it from the per-file patches.
      let page = 1;
      let out = '';
      for (;;) {
        const r = await request(`${api}/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`, { headers: { ...headers, Accept: 'application/vnd.github+json' } }, 'GitHub files');
        const files = await r.json();
        for (const f of files) out += `diff --git a/${f.previous_filename || f.filename} b/${f.filename}\n${f.patch ? `--- a/${f.filename}\n+++ b/${f.filename}\n${f.patch}\n` : `[${f.status}, no text diff]\n`}`;
        if (files.length < 100 || page >= 30) break;
        page++;
      }
      return out;
    },
    async upsertComment(repo, number, body) {
      const json = { ...headers, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };
      let existing = null;
      for (let page = 1; page <= 10 && !existing; page++) {
        const r = await request(`${api}/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`, { headers: json }, 'GitHub comments');
        const list = await r.json();
        existing = list.find((c) => typeof c.body === 'string' && c.body.includes(MARKER)) || null;
        if (list.length < 100) break;
      }
      const url = existing ? `${api}/repos/${repo}/issues/comments/${existing.id}` : `${api}/repos/${repo}/issues/${number}/comments`;
      const r = await request(url, { method: existing ? 'PATCH' : 'POST', headers: json, body: JSON.stringify({ body }) }, 'GitHub comment');
      return (await r.json()).html_url;
    },
  };
}

async function review({ baseUrl, apiKey, model, prompt, pr, diff, maxTokens }) {
  const user = [
    `Pull request: ${pr.title || ''}`.trim(),
    pr.body ? `Description:\n${String(pr.body).slice(0, 4000)}` : '',
    diff.cut.length || diff.skipped.length
      ? `Note: ${diff.cut.length ? `the diff of ${diff.cut.length} file(s) was cut to fit` : ''}${diff.cut.length && diff.skipped.length ? '; ' : ''}${diff.skipped.length ? `${diff.skipped.length} generated/lock file(s) were left out` : ''}.`
      : '',
    'Diff:',
    '```diff',
    diff.text,
    '```',
  ].filter(Boolean).join('\n\n');
  const body = { model, messages: [{ role: 'system', content: prompt }, { role: 'user', content: user }] };
  if (maxTokens) body.max_tokens = maxTokens;
  const res = await request(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'User-Agent': 'uberllm-pr-reviewer' },
    body: JSON.stringify(body),
    timeoutMs: 300000,
  }, 'Model API');
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text || !String(text).trim()) throw new Error(`Model API returned no review text (finish_reason: ${data?.choices?.[0]?.finish_reason || 'unknown'})`);
  return { text: String(text).trim(), usage: data.usage || {}, model: data.model || model };
}

function commentBody(r, diff, baseUrl) {
  const host = (() => { try { return new URL(baseUrl).host; } catch { return baseUrl; } })();
  const notes = [];
  if (diff.skipped.length) notes.push(`left out ${diff.skipped.length} generated/lock file(s)`);
  if (diff.cut.length) notes.push(`diff cut to fit \`max-diff-chars\` (${diff.cut.length} file(s) partly or not reviewed)`);
  const tokens = r.usage.prompt_tokens != null ? ` · ${r.usage.prompt_tokens} in / ${r.usage.completion_tokens ?? '?'} out tokens` : '';
  return [
    MARKER,
    '### AI review',
    '',
    r.text,
    '',
    '---',
    `<sub>\`${r.model}\` via ${host}${tokens}${notes.length ? ` · ${notes.join(', ')}` : ''} · [UberLLM PR Reviewer](https://github.com/PSA-Team-source/uberllm-action). Updated on every push; an AI review can be wrong.</sub>`,
  ].join('\n');
}

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const delim = `EOF_${Math.random().toString(36).slice(2)}`;
  fs.appendFileSync(file, `${name}<<${delim}\n${value}\n${delim}\n`);
}

// ---------------------------------------------------------------- main

async function main() {
  const apiKey = input('api-key');
  const baseUrl = input('base-url', 'https://api.uberllm.dev/v1');
  const model = input('model', 'deepseek/deepseek-v4-pro');
  const prompt = input('prompt', DEFAULT_PROMPT);
  const maxChars = int('max-diff-chars', 60000);
  const maxTokens = input('max-tokens') ? int('max-tokens', 1) : 0;
  const post = bool('post-comment', true);
  const failOnError = bool('fail-on-error', false);
  const token = input('github-token', process.env.GITHUB_TOKEN || '');
  const patterns = [...DEFAULT_EXCLUDE, ...input('exclude').split(/[\n,]/).map((s) => s.trim()).filter(Boolean)].map(globToRegExp);

  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
  const pr = event.pull_request;
  if (!pr) {
    console.log('::notice::Not a pull_request event; nothing to review.');
    return;
  }
  if (!apiKey) {
    // Pull requests from forks get no secrets on the pull_request event.
    console.log('::warning::No api-key (secrets are not passed to pull requests from forks); skipping the review.');
    return;
  }
  if (!token) throw new Error('github-token is empty');
  console.log(`::add-mask::${apiKey}`);

  const repo = event.repository?.full_name || process.env.GITHUB_REPOSITORY;
  const client = gh(token);
  try {
    const diff = prepareDiff(await client.diff(repo, pr.number), maxChars, patterns);
    if (!diff.text.trim()) {
      console.log(`::notice::No reviewable changes (${diff.skipped.length} generated/lock file(s) left out).`);
      return;
    }
    console.log(`Reviewing ${repo}#${pr.number} with ${model}: ${diff.text.length} diff chars, ${diff.files} file(s), ${diff.skipped.length} left out, ${diff.cut.length} cut.`);
    const r = await review({ baseUrl, apiKey, model, prompt, pr, diff, maxTokens });
    const body = commentBody(r, diff, baseUrl);
    setOutput('review', r.text);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${body}\n`);
    if (post) {
      const url = await client.upsertComment(repo, pr.number, body);
      setOutput('comment-url', url);
      console.log(`Review posted: ${url}`);
    } else {
      console.log(body);
    }
  } catch (e) {
    const msg = String(e && e.message ? e.message : e).split(apiKey).join('***');
    if (failOnError) throw new Error(msg);
    console.log(`::warning::UberLLM PR Reviewer did not finish: ${msg}`);
  }
}

module.exports = { globToRegExp, excluded, splitDiff, prepareDiff, commentBody, DEFAULT_EXCLUDE };

if (require.main === module) {
  main().catch((e) => {
    console.log(`::error::${e.message || e}`);
    process.exit(1);
  });
}
