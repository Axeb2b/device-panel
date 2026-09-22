# Device Panel

Firebase RTDB device dashboard + Auto Token Sender for project **axexodiweb**.

**Live:** https://axexodiweb.web.app · https://axeb2b.github.io/device-panel/

Full context for operators and agents: **[HANDOFF.md](./HANDOFF.md)**

## Quick start

```bash
firebase deploy --only hosting --project axexodiweb
# sync Pages
rm -rf docs && mkdir docs && cp -a public/. docs/ && git add -A && git commit -m "docs: sync" && git push
```

## Bot

```bash
BOT_TOKEN=... python3 "$HOME/FIREBASE/phonepe (2).py"
```
