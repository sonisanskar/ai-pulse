# Relevance and focus: picking ~7 items from ~150

Date: 2026-11-10. Repo references are to the working tree at that date, including the uncommitted `pick_brief` / `brief_group` in `pipeline/rank.py`. "Measured" means I ran it against `site/data/latest.json` (2026-11-01, 146 items) or against the live API.

## TL;DR

1. **Fix the inputs before tuning the quotas.** `hf_papers.fetch` uses the API's default sort (`publishedAt`), so it gets the newest 30 papers, not the best ones. Ask for `date=<yesterday UTC>` instead, because votes are still coming in at 01:30 UTC. For HF models, use the Hub's own "usable" signals (`inference_provider`, `apps`) and its derivative signal (`baseModels`) instead of the `avoid` word list.
2. **The keyword floor is close to a no-op.** 100 of 146 items pass it. Substring matching lets `transformer` match every `transformers` library model and `rag` match "Sto*rag*e". Use word boundaries, count title hits for more, and set the floor per bucket.
3. **Normalize popularity per source and take its log.** Drop the hand-tuned constants (`upvotes*4`, `stars/3`). Both HN and Reddit use popularity on a log scale minus age, and for a once-a-day batch the age term can just be an eligibility window.
4. **Dedupe by entity, not by title.** For 7 slots, the quotas plus the per-source cap already give the diversity MMR would give. What's missing is linking the *same thing* across types: a paper and its repo, a blog post and its model.
5. **Two levels only:** Today's 7, then Explore. Each card states why it was picked. Muting gives instant feedback with an undo.

## 1. Ranking code that ships in real products

**Hacker News** (Arc 3.2, `news.arc` lines 264–299, http://www.arclanguage.org/arc3.2.tar):
`rank = (score-1)^0.8 / ((age_min + 120)/60)^1.8 × penalty`, where `gravity* 1.8`, `timebase* 120`, `nourl-factor* .4`, and non-story items get `.5`. `contro-factor` multiplies by `min(1, (score/comments)^2)` once a story has more than 20 visible comments, so threads with more comments than votes sink.

**Reddit** (`r2/r2/lib/db/_sorts.pyx`, https://github.com/reddit-archive/reddit/blob/master/r2/r2/lib/db/_sorts.pyx):
- `_hot` (lines 47–58) is `sign·log10(max(|ups−downs|,1)) + (epoch_seconds − 1134028003)/45000`. So 10× the votes is worth 45,000 s, about 12.5 h, of freshness.
- `_confidence` (lines 70–85) is the Wilson lower bound with `z = 1.281551565545` ("80% confidence").

**What to borrow**
- **Log popularity.** Both formulas compress popularity logarithmically, as `score()` already does with `log1p`. Keep that.
- **Normalization.** Neither product normalizes across sources, because each has one vote scale. Our `max(upvotes*4, points, stars/3, trending, …)` in `rank.score` (lines 17–31) has no primary-source basis. Proposal (my own design, not from a source): in `rank.score`, replace the raw value with the item's **percentile within its `source_key` for today's batch**, then `log1p`. That makes each source's scale irrelevant. The source weights in `config.yaml` stay as the prior.
- **Time decay.** Our `-0.15 × age_days` trades one order of magnitude of popularity for about 18 days. That is effectively no decay, which is fine, because `dedupe.filter_seen` already removes anything seen before. Decay only matters for items that are old but new to us: models trending months after `createdAt`, and RSS posts up to 4 days old. In `pick_brief`, use hard windows per bucket instead of a gravity curve: about 3 days for releases and papers, about 14 days for repos and models.
- **HN controversy factor.** The `comments` signal is fetched but unused. Apply `contro-factor` to HN items in `rank.score`.
- **Wilson score.** It needs negative votes, and none of our sources have them. It does fit the mute: see section 4.

## 2. First-party APIs: signals we ignore

| API | Docs say | We read today | Change |
|---|---|---|---|
| **HF Daily Papers** `/api/daily_papers` | Params `date`, `week`, `month`, `submitter`, `sort ∈ {publishedAt, trending}`, with `publishedAt` as the default ([OpenAPI](https://huggingface.co/.well-known/openapi.json), path `/api/daily_papers`). Response includes `githubRepo`, `githubStars`, `projectPage`, top-level `numComments`, `ai_keywords`, `withdrawnAt`. | Only `limit=30` (`hf_papers.py:11`), so we get the newest papers. We do read `githubRepo` and `githubStars`. | Call with `date=<yesterday>`. Measured: top upvotes were 64/57/45, against 1–9 for today's entries under the default sort. Mark papers that have `githubRepo` as candidates for "usable", drop papers with `withdrawnAt`, and use `numComments`. |
| **HF Hub** `/api/models` | `sort` accepts `trending_score`, `likes`, `downloads`, `created_at`. Filters include `apps` (e.g. `ollama`, `vllm`), `inference_provider` (`"all"` = served by at least one provider), `num_parameters` (`min:6B,max:128B`), and `author`. `expand` accepts `baseModels`, `createdAt`, `likes`, `downloads` and more ([`hf_api.py` `list_models`, `ExpandModelProperty_T`, `ModelSort_T`](https://github.com/huggingface/huggingface_hub/blob/main/src/huggingface_hub/hf_api.py)). | `trendingScore`, `likes`, `downloads`, `createdAt`. `_clean_tags` **strips** `base_model:` tags. | Measured: `inference_provider=all` sorted by trending returned Kimi, Qwen, LiquidAI and NVIDIA models, while the plain trending list includes "…Heretic-Uncensored…GGUF". In `hf_hub.py`, add a second call with `inference_provider=all`. Treat `baseModels.relation ∈ {quantized, finetune, merge}` as derivatives, so they are excluded from the brief, and keep them as a signal rather than filtering them out. That replaces `brief.avoid`. |
| **GitHub** `search/repositories` | Qualifiers `created:`, `pushed:`, `stars:`, `topic:`, `archived:`, `license`, `good-first-issues:` ([syntax](https://docs.github.com/en/search-github/searching-on-github/searching-for-repositories)). `sort ∈ {stars, forks, help-wanted-issues, updated}`. Items carry `pushed_at`, `license`, `homepage`, `forks_count`, `archived`. Rate limit is 30 req/min authenticated, 10 unauthenticated ([REST](https://docs.github.com/en/rest/search/search#search-repositories)). | `stargazers_count`, `forks_count` (unused in ranking), `created_at`, `topics`. | In `github.py`: add `archived:false pushed:>{since}`, rank by **stars ÷ max(age_days, 1)** (star velocity), and require `license` for the usable bucket. |
| **HN Algolia** | `/search` is "Sorted by relevance, then points, then number of comments", and `/search_by_date` by date. Tags include `front_page`, `show_hn`, `ask_hn`. `num_comments` is filterable ([docs](https://hn.algolia.com/api), rendered from the page's JS bundle). | `points`, `num_comments`. | In `hackernews.py`, set `signals["front_page"]` from a second `tags=front_page` query (measured: it works with `created_at_i`). Let `show_hn` AI stories count as "usable". |
| **arXiv** | `sortBy ∈ {relevance, lastUpdatedDate, submittedDate}` (§3.1.1.3). Entries carry `arxiv:comment`, `arxiv:journal_ref` and `arxiv:primary_category` (§3.3.2.4). Results change once a day, "no need to call the API more than once in a day" (§3.3.1.1) ([manual](https://info.arxiv.org/help/api/user-manual.html)). | Title, summary, `cs.*` tags. | arXiv has no popularity signal; `keyword_hits*6` stands in for one. In `arxiv.py`, read `arxiv_comment` for accepted-venue or code links, and let raw arXiv fill only the wildcard slot. HF Papers should own the paper bucket. |

## 3. Diversity re-ranking (MMR)

Carbonell & Goldstein define MMR as `argmax_{Di∈R\S} [λ·Sim1(Di,Q) − (1−λ)·max_{Dj∈S} Sim2(Di,Dj)]`. R is retrieved with a **relevance threshold θ**, and Q can be "a query or user profile" (§2, [PDF](https://www.cs.cmu.edu/~jgc/publication/The_Use_MMR_Diversity_Based_LTMIR_1998.pdf)). They suggest λ≈0.3 to explore and λ≈0.7 to focus. The evidence is thin: a 5-user pilot (§3), and no significant precision difference across λ in the summarization study (Table 1).

**Mapping to the plan.** The keyword floor is θ, `interests` is Q, and `take()` (`rank.py:83–91`) is MMR with a hard cutoff: it rejects when title Jaccard > 0.5. With 7 slots split across 4 quota buckets and a per-source cap, the quotas already do most of what MMR does. **A full MMR isn't worth it.** The real gaps:
- **The same entity under different titles.** "Introducing X" (blog), `org/X-27B` (HF), the HN thread, and the GitHub repo share almost no title tokens. Fix this in `dedupe.merge_duplicates`: join on the paper's `githubRepo` → `gh:owner/repo`, on `baseModels` → base model id, and on the HF org plus model family name appearing in a lab post title.
- **The per-source cap is keyed on `item.source`** (`rank.py:85`). "HF Trending Models", "HF Trending Spaces" and "HF Trending Datasets" therefore count separately. Key the cap on the provider (`hf`, `github`, `arxiv+hf_papers`, the feed org) instead.
- **Topic redundancy**, e.g. two agent-benchmark papers. In `take()`, compare title plus `tags`/`ai_keywords` tokens at about 0.5. That is MMR with λ≈0.5 in effect, at no extra cost.

## 4. Presentation (NN/g)

- **Two levels, no more.** Progressive disclosure: "disclose everything that users frequently need up front", and keep the primary list short. "designs that go beyond 2 disclosure levels typically have low usability." The link to the secondary screen should "set clear expectations for what users will find" (Nielsen, 2006, *Usability Criteria for Progressive Disclosure*, https://www.nngroup.com/articles/progressive-disclosure/).
  → `site/app.js` `TABS`: Today (7) → Explore (all). Label the link "Explore all 146 from today". Don't nest further levels inside Explore beyond filters.
- **Scent on every card.** Summary text should "convey the gist … and add detail to the link label". Link names should be "clear and self-explanatory" (Budiu, 2020, *What the User Sees*, https://www.nngroup.com/articles/information-scent/).
  → Each card in the Today view: a human title (not the bare `org/repo` id), a one-line TL;DR, and a **reason chip** such as "Lab release · OpenAI blog", "Use this · 1.2k★ in 3 days, Apache-2.0" or "Paper · 64 upvotes, has code".
- **Explain the pick and allow fine-tuning.** Guidelines are "Clearly State the Source of Data" and "Allow Users to Fine-Tune Suggestions". Negative feedback should be "reflected in the recommendations immediately" (Harley, 2018, https://www.nngroup.com/articles/recommendation-guidelines/).
  → `briefFor` already swaps muted items in place. Add a toast that names what was muted, with Undo. `muteKey` (`app.js:120`) mutes the item's *first* tag, which can be a broad tag like `transformers`. Offer the source and the specific tag as separate choices. Optionally, down-weight a source (instead of hiding it) using the Wilson lower bound over shown vs. muted counts with Reddit's z=1.28.
- **Glanceable, not exploratory.** Dashboards "provide information that can be consumed fast" and "Their goal is not to facilitate exploration". Use color only to reinforce information shown another way (Laubheimer, 2017, https://www.nngroup.com/articles/dashboards-preattentive/).
  → Bucket headers (`GROUPS`) as text. Show signals as short numbers, not colored badges, and put sparklines and filters in Explore only.
- **Fewer choices, plus editing.** "Keeping the number of options at a reasonable level allows people to make decisions more easily" (Loranger, 2015, https://www.nngroup.com/articles/simplicity-vs-choice/). "good user interface design and good editorial preparation of the data" is the first and often most successful defence against overload (Nielsen, 1995, https://www.nngroup.com/articles/coping-information-overload/).
  → Show fewer than 7 when a bucket has nothing that clears the floor. Don't pad.

## Unverified

- Whether HN production still uses the Arc 3.2 constants, and whether Reddit still uses `_hot`. The repo is archived; I only verified the published source.
- The meaning and formula of HF `trendingScore`. I found no documentation of it, only that it is a sort and expand field.
- The default ranking of the HN Algolia `/search` endpoint with no query. I have only the docs string, not Algolia's settings.
- Per-source percentile normalization and the eligibility windows are my own design proposals, not taken from any source.
- The "usable" thresholds (star velocity, licence required) haven't been tested against outcomes.
