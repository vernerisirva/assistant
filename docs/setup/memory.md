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
- `admin`
- `general`

## Safety Rules

The assistant should not silently remember everything. Low-risk preferences can be stored when the user explicitly asks. Inferred preferences should be proposed first. Sensitive memories require Telegram approval before storage.

The user can ask:

- "What do you remember about me?"
- "Forget that."
- "Forget memory MEMORY_ID."
- "Remember that I prefer concise Telegram messages."
