# AI Pulse

A single-page dashboard that refreshes itself every morning with AI research papers, industry news, trending models and repos, plus a **Concept of the Day** lesson with spaced-repetition flashcards.

It costs nothing to run: GitHub Actions runs the job, GitHub Pages hosts the site, and free open-model LLM APIs write the summaries.

```
GitHub Action (07:00 IST daily)
  └─ python -m pipeline.build
       fetch (HF Papers, arXiv, 16 blogs/newsletters, Anthropic, HN, Reddit, HF Hub, GitHub)
       → merge duplicates → drop already-seen → rank by popularity + your interests
       → free LLM: TL;DRs, daily digest, Concept of the Day
       → site/data/*.json  → commit → deploy to GitHub Pages
```

## Tabs
| Tab | What's there |
|---|---|
| **Today** | Headline and themes, top 5 with reasons, a "big picture" overview, the Concept of the Day, your learning stats, and an archive picker |
| **Papers / News / Models & Repos** | Cards with TL;DR, key idea, why it matters, difficulty, tags and links. Filter by time range, source, tag, unread or new-only; sort by rank or newest |
| **Learn** | All lessons (intuition, math in LaTeX, code, pitfalls, further reading), SM-2 flashcard review (keyboard: space, then 1–4), streak |
| **Saved** | Read-later list with progress, plus export/import of your progress |

Items you haven't seen since your last visit get a **NEW** badge. The footer shows the health of every source and of the LLM, so you can tell when a feed breaks.

## Setup (about 5 minutes)
1. **Create a GitHub repo** and push this folder:
   ```bash
   git init && git add . && git commit -m "AI Pulse"
   git branch -M main
   git remote add origin https://github.com/<you>/ai-pulse.git
   git push -u origin main
   ```
2. **Get a free LLM key.** Sign up at [console.groq.com](https://console.groq.com) (no card needed) → API Keys → create one.
   In the repo, go to **Settings → Secrets and variables → Actions → New repository secret**: `GROQ_API_KEY`.
   Optional fallback: `OPENROUTER_API_KEY` from [openrouter.ai](https://openrouter.ai) (uses its `:free` models).
3. **Enable Pages:** go to **Settings → Pages → Source: GitHub Actions**.
4. **First run:** go to **Actions → Daily AI Pulse → Run workflow**. When it finishes, your site is at `https://<you>.github.io/ai-pulse/`.

After that it runs every day at 07:00 IST. The daily data commits also keep the repo active, so GitHub won't pause the schedule.

> Without any LLM key the site still works and shows raw abstracts. You just won't get TL;DRs, the digest or lessons.

## Run locally
```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m pipeline.build --no-llm          # fetch only
GROQ_API_KEY=... .venv/bin/python -m pipeline.build  # with summaries
.venv/bin/python -m http.server 8000 -d site         # open http://localhost:8000
```
To run fully offline with a local model, use [Ollama](https://ollama.com): `ollama pull qwen2.5:7b`, then
`OLLAMA_MODEL=qwen2.5:7b .venv/bin/python -m pipeline.build`.

Useful flags: `--only hf_papers,github` runs a subset of sources (a re-run on the same day merges with what's already there), and `--config path.yaml` uses a different config.

## Customize (`pipeline/config.yaml`)
- **`interests`**: keywords that boost ranking, and that filter arXiv down to what you care about.
- **`weights`**: how much each source counts.
- **`sources.rss.feeds`**: add or remove blogs and newsletters (any RSS/Atom URL).
- **`llm.providers`**: provider and model order. If a model is retired or renamed, the next one in the list is used automatically.
- **`pipeline/curriculum.yaml`**: fallback lesson topics, used when today's papers don't suggest a good concept.

## How it fits together
```
pipeline/
  build.py        orchestrator (fetch → merge → filter seen → rank → LLM → write)
  sources/*.py    one module per source; each fails independently and reports to status.json
  dedupe.py       cross-source merge (HF+arXiv, blog+HN) and "already seen" filtering
  rank.py         popularity (log-scaled) × source weight + interest boost − age
  llm.py          OpenAI-compatible client over free providers with model/provider fallback
  summarize.py    batched per-item TL;DRs (cached by id) + daily digest
  concepts.py     Concept of the Day (Markdown lesson + flashcards)
site/             static frontend (index.html, app.js, styles.css): no build step
  data/           latest.json, days/YYYY-MM-DD.json, index.json, concepts.json, status.json
state/            seen.json, summaries.json: memory between runs (not served)
```

Your personal progress (saved, read, flashcards, streak) stays in your browser's localStorage. Use **Saved → Export / Import** to move it between devices.

Note: GitHub Models, the original plan for the LLM, was retired by GitHub on 2026-07-30, so this project uses Groq / OpenRouter / Ollama instead.
