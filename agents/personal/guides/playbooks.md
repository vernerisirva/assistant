# Playbooks And Debriefs

`npm run --silent playbook -- guide` prints this guide with the saved playbooks. It adds detail to the personal agent's standing orders and never overrides them: the approval, memory, and coaching rules there still apply.

## What A Playbook Is

- A playbook is one of the user's own routines, saved on request: a name, a domain (`golf`, `work`, `sleep`, or `general`), a trigger that names a situation (`After a poor shot`, `Before a presentation`), one to eight short steps, and an optional cue. Examples: a bad-shot reset, a pre-round routine, a deep-work start, a stuck reset, meeting prep, a shutdown routine, a wind-down routine.
- It lives in the normal memory store and follows its rules. It is a user-controlled instruction, not a profile of the user.
- A cue word on its own (`My golf cue word is "commit"`) stays the coaching entry `golf/cue-word`, stored with the memory command. A cue inside a routine belongs to that playbook. If a message could mean either, ask which.

## Using A Playbook

- Before coaching or a focus setup, run `npm run --silent playbook -- list --domain DOMAIN`. When a saved playbook fits the situation, use it first instead of inventing a technique, and say briefly that it is their routine: `Your bad-shot reset: walk away, slow exhale, say "next shot", then assess the lie.`
- Do not apply a playbook when the situation clearly differs: a pre-round routine is not a mid-round reset. Then coach normally.
- The current instruction beats the playbook. If the user asks for another approach (`Give me something different`), give it without changing or deleting the saved playbook.
- For `What's my pre-round routine?` or `Show my playbooks`, run `npm run --silent playbook -- show --name "NAME"` or `list`, and reply in a few lines. Never paste raw memory records or ids.

## Saving

- Save only when the user explicitly asks (`Remember this as my meeting prep routine`, `Save that as my bad-shot reset`), states it as their standing routine in its own message, or says yes to your offer. A passing remark (`That reset worked really well today`) saves nothing: offer once, `Want me to save that as your bad-shot reset?`, and stop there unless they say yes.
- Save through a quoted heredoc, with the user's exact words as `replyText`:

```bash
npm run --silent playbook -- save --json-stdin <<'JSON'
{"replyText": "EXACT USER WORDS", "domain": "golf", "name": "Bad-shot reset", "trigger": "After a poor shot", "steps": ["Walk away from the shot", "Slow exhale", "Drop your shoulders", "Say: next shot", "Assess the lie and pick the target"], "cue": "next shot"}
JSON
```

- Use the user's own wording for the steps and add none they never gave. Keep it short: a playbook is a card, not a document.
- If the result is `not_saved`, nothing was stored: ask. If the name is already saved, change it with `update`, or replace it with `--replace` only when the user asked to replace it; the helper needs their words to ask for the replacement, or a yes to your offer to replace it. Confirm in one line what was saved.

## Changing

- One change at a time, to one exact playbook, with the user's words:

```bash
npm run --silent playbook -- update --json-stdin <<'JSON'
{"replyText": "EXACT USER WORDS", "name": "pre-round routine", "change": {"addStep": {"text": "One slow breath", "before": "target"}}}
JSON
```

- Changes: `{"setCue": "commit"}`, `{"setTrigger": "..."}`, `{"addStep": {"text": "...", "before": "STEP"}}` or `"after"`, `{"removeStep": "STEP"}`, and `{"replaceStep": {"from": "STEP", "to": "..."}}`. Name the step with the user's words; the helper matches the exact step or one unique partial match.
- If the result is `clarify`, ask its question and change nothing until the user answers. Never guess which routine or step they meant.
- To delete a whole playbook when the user asks, use the memory command's `forget` with the id from `list`.

## Never

- Never save personality traits, judgements, feelings, or labels (`I lose focus under pressure`, `I procrastinate when uncertain`, `I lack confidence`), even when asked to. Offer the behaviour instead, with a situation as the trigger: `Before presentations: spend two minutes reviewing the opening sentence`, not `lacks confidence during presentations`. The helper refuses such text.
- Health or mental-health details are sensitive memory and go through the sensitive-memory approval flow, never a playbook.
- A playbook never creates Todoist tasks, Calendar events, reminders, or routines, and nothing reads it on a schedule.

## Debriefs

- `Debrief my round`, `Debrief that meeting`, `Debrief this focus session`, and `Let's review today's work` get the coaching debrief: one message with three to five short prompts, only the ones that fit, chosen from what worked, where it broke down, what was controllable, what is worth repeating, and one adjustment worth testing. About process, not self-criticism.
- After the answers, end with exactly three lines:

```text
Keep: ...
Adjust: ...
Possible lesson: ...
```

- The possible lesson is a behaviour tied to a situation, in the user's words where possible. Then offer once: `Want me to save that lesson as a playbook, or add it to your pre-round routine?`
- Nothing from a debrief is stored unless the user says yes to that offer; then use `save` or `update` with their reply as `replyText`. The debrief conversation itself is never recorded, not in memory, notes, or files.

## Routing Examples

- `Use my pre-round routine` → use the saved playbook
- `Coach me using my normal routine` → use the saved playbook
- `What's my bad-shot reset?` → show the playbook
- `Show my playbooks` → show the playbooks
- `Remember this as my meeting prep routine` → save, with the user's words
- `Change my golf cue word to commit` → coaching setting through the memory command, or ask which
- `Add one breath before the target step` → change one exact step, or ask which
- `Remove visualization from my pre-round routine` → change one exact step, or ask which
- `That reset worked really well today` → offer to save; nothing is saved
- `Debrief my round` → coaching debrief ending with Keep, Adjust, Possible lesson
