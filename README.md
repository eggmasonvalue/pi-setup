# pi-setup

Git-distributed Pi package for sharing my setup.

## Install

```bash
pi install git:github.com/eggmasonvalue/pi-setup
```

Pin to a tag/commit:

```bash
pi install git:github.com/eggmasonvalue/pi-setup@<tag-or-commit>
```

## Included resources

- `extensions/`
- `skills/`
- `prompts/`
- `themes/`

## Not included

Runtime/local state is intentionally excluded (for safety and portability):

- auth/session files
- local caches
- machine-specific config (`settings.json`, `models.json`)

## Manage

```bash
pi update git:github.com/eggmasonvalue/pi-setup
pi remove git:github.com/eggmasonvalue/pi-setup
```
