# Memory Setup

Memory Phase 1 stores explicit local preferences in:

```bash
.openclaw/state/memory/preferences.json
```

The file is local generated state and is not committed. It is meant for preferences and reusable guidance, not secrets.

## Commands

Remember a low-risk preference:

```bash
npm run memory -- remember --category food --key breakfast --value "likes Greek yogurt with berries" --source telegram
```

Review memories:

```bash
npm run memory -- list
npm run memory -- list --category food
```

Forget a memory:

```bash
npm run memory -- forget --id MEMORY_ID
```

Draft a sensitive memory approval:

```bash
npm run memory -- remember --category health --key injury --value "knee pain after running" --sensitivity sensitive --dry-run
```

Store it after Telegram approval:

```bash
npm run memory -- remember --category health --key injury --value "knee pain after running" --sensitivity sensitive --approved
```

## Categories

- `food`
- `health`
- `schedule`
- `tone`
- `golf`
- `work`
- `sleep`
- `admin`
- `general`

## Coaching Playbook

On-demand coaching reuses this store for routines the user sets explicitly, one entry each:

- `golf/cue-word`, `golf/bad-shot-reset`, `golf/pre-round-routine`
- `work/deep-work-block`, `work/reset-routine`
- `sleep/target-wake-time`, `sleep/wind-down-routine`

```bash
npm run memory -- remember --category golf --key cue-word --value "commit" --source telegram
npm run memory -- list --category golf
```

An entry is stored when the user asks to remember or save a routine, says to use it from now on, or states it as their standing routine in its own message. A routine mentioned in passing is offered first. Coaching never infers or silently stores personality traits, weaknesses, mental-health labels, moods, conclusions drawn from frustrated messages, or diagnoses. If the user asks to remember a judgement about themselves, such as `I always choke under pressure`, Hilla offers to save a matching routine instead. Health or mental-health details are sensitive memory and need Telegram approval.

## Personal Playbooks

A routine with steps is a playbook: a name, a domain (`golf`, `work`, `sleep`, or `general`), a trigger that names a situation, one to eight short steps, and an optional cue. It is an ordinary entry in this store. The key is a slug of the name, `value` is a readable one-line rendering, and a `playbook` field holds the structure, so `memory -- list`, `forget`, and the routines see it like any other entry. A routine saved as plain text through the memory command still reads as a playbook and becomes structured on its first change.

```bash
npm run --silent playbook -- list --domain golf
npm run --silent playbook -- show --name "bad-shot reset"
npm run --silent playbook -- guide
```

`save` and `update` read JSON through a quoted heredoc and require the user's exact words as `replyText`: an explicit request, a standing-routine statement, or a plain yes to Hilla's offer. A remark such as `That reset worked really well today` saves nothing. Updates make one change to one exact playbook, and an unclear routine or step returns a question instead of a guess. The helper refuses trait, feeling, and judgement statements and health details. A debrief lesson is saved only after the user says yes.

## Safety Rules

The assistant should not silently remember everything. Low-risk preferences can be stored when the user explicitly asks. Inferred preferences should be proposed first. Sensitive memories require Telegram approval before storage.

The user can ask:

- "What do you remember about me?"
- "Forget that."
- "Forget memory MEMORY_ID."
- "Remember that I prefer concise Telegram messages."
