# Learning

`learning/` contains preference-learning and semantic embedding scaffolding for schedule ranking.

## Preference Learning
Some scheduling objectives can be encoded as explicit costs (illegal schedules, overlap penalties, split penalties), but these are not enough to capture user-specific scheduling taste. Preference learning is used as a tie-breaker across multiple engine-optimal candidates.

You can view the engine as a candidate generator and the preference model as a selector that approximates:
`P(U(A) > U(B))`,
where `A` and `B` are candidate schedules and `U` is latent user utility.

## Semantic Preference Learning
The preference model can consume semantic context from recurrence metadata such as event names and descriptions. Embeddings are produced with sentence-transformer models (optionally GPU-accelerated), enabling ranking based on event meaning instead of only primitive numeric features.

## Files
- [`learning/constants.py`](constants.py): model constants (current default transformer).
- [`learning/embedding.py`](embedding.py): sentence-transformer import/scaffold.
- [`learning/model.py`](model.py): placeholder for ranking/training logic.

## Current TODO
- Learn from user data and preference feedback to improve event selection (see [`learning/TODO.txt`](TODO.txt)).
