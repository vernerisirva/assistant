# Independent Review Setup

`npm run review` asks a model that did not write the change to review it. It is
the quality gate that lets substantial work land without the owner reading every
diff.

## Key

Create a key at https://openrouter.ai/keys and add it to your local `.env`:

```bash
OPENROUTER_API_KEY=sk-or-your-key-here
```

Do not commit or paste the key into chats, issues, logs, or docs. The harness
never prints it, and redacts key-shaped text out of upstream error messages.

Without a key the command fails with setup instructions and a non-zero exit
code. It never falls back to a local model or to self-review, because a review
by the author is not an independent review and must not look like one.

## Commands

```bash
npm run review -- --dry-run                  # build the prompt, send nothing, spend nothing
npm run review -- --base main --head HEAD    # review this branch against main
npm run review -- --second                   # also ask the configured second model
npm run review -- --json                     # machine-readable result
npm run review -- --test-summary "386 passing, 0 failing"
npm run review -- --objective "What this change is supposed to achieve"
```

Exit codes: `0` for PASS or PASS_WITH_NOTES, `1` for BLOCKERS, `2` for a failure
such as a missing key, a transport error, or unparseable reviewer output.

Start with `--dry-run`. It prints the models, the prompt size and the configured
caps without making a request, so no review ever spends money unexpectedly.

## Configuration

`config/review.json`:

| Field | Meaning |
| --- | --- |
| `primaryModel` | Reviewer model id on OpenRouter |
| `secondaryModel` | Optional second opinion, used only with `--second` |
| `temperature` | `0` for the most repeatable review |
| `maxCompletionTokens` | Hard cap on the answer, which bounds the largest cost |
| `maxDiffBytes` | Diff size cap; a longer diff is truncated and the reviewer is told |
| `maxCostUsd` | Advisory ceiling; a costlier review is reported, not hidden |

Prefer a reviewer from a different vendor than the model writing the code. The
default is `openai/gpt-5.6-luna-pro`, with `google/gemini-2.5-pro` as the second
opinion, so a Claude-written change is not reviewed by its own family.

Every live review reports the model actually used and the tokens and cost
OpenRouter charged, so spending is always visible.

## What the reviewer sees

The product objective, the diff, the changed-file list, the commit subjects, and
optionally deterministic test results. The objective and test summary come from
the caller and say so in the prompt. The reviewer is never given the
implementer's reasoning, self-review, or conclusions, so its judgement is its
own. The diff itself is presented as untrusted content under review.

## Verdicts

- `BLOCKERS` — at least one defect with a concrete failure case. Fix before merge.
- `PASS_WITH_NOTES` — no blocking defects; notes are worth reading.
- `PASS` — nothing found.

The harness fails closed in every ambiguous case:

- A reviewer claiming `PASS` while listing a blocking finding is recorded as
  `BLOCKERS`, and the adjustment is shown.
- A response with no verdict, a non-string verdict, an unknown verdict, or
  output that cannot be parsed is an error, never a pass.
- The response must be a single JSON object, optionally inside one fenced
  block, and nothing else. A verdict is never read out of surrounding prose,
  so a reviewer quoting an injected payload from the diff cannot supply one.
- A finding or note that does not match the schema is kept and escalated rather
  than dropped, so a described defect can never vanish into silence.
- A finding whose severity is missing or not recognized is treated as blocking,
  and the unrecognized label is printed. Only explicitly non-blocking words
  such as `note`, `minor` or `suggestion` become notes.

The diff under review is untrusted content. The reviewer is told so, and the
diff is fenced with a longer delimiter than any backtick run it contains, so a
diff cannot close its own fence and inject instructions.

If one reviewer of two fails, the review that already succeeded is still
reported rather than discarded, and the failure is printed alongside it. The run
then exits `2` rather than `0`, because the lost answer may have been the one
objecting. Once the cost ceiling is exceeded, remaining reviewers are skipped
instead of being paid for.

The product objective and any test summary are supplied by the caller and are
labelled as such in the prompt. Everything else the reviewer sees is the diff
and repository facts; it is never given the implementer's reasoning or
conclusions.
